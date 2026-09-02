import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import Ajv from "ajv";

const MAX_REPO_BYTES = 10 * 1024 * 1024;

interface Script {
  name: string;
  url: string;
}

interface Check {
  name: string;
  errors: string[];
  warnings: string[];
  file?: string;
}

interface Entry {
  name: string;
  license: string | null;
  sizeBytes: number | null;
}

const ajv = new Ajv();

const validateRegistry = ajv.compile<{ scripts: Script[] }>(
  JSON.parse(readFileSync("src/registry.schema.json", "utf8")),
);

const validateManifest = ajv.compile<{ main: string }>(
  JSON.parse(readFileSync("src/package.schema.json", "utf8")),
);

const onCi = process.env.GITHUB_ACTIONS === "true";

async function main() {
  const registry = readRegistry();
  const checks: Check[] = [
    { name: "Formatting", errors: checkFormatting(), warnings: [] },
    {
      name: "Registry schema",
      errors: registry.errors,
      warnings: [],
      file: "registry.json",
    },
  ];

  const entries: Entry[] = [];
  if (registry.scripts) {
    const check: Check = {
      name: "Registry entries",
      errors: [],
      warnings: [],
      file: "registry.json",
    };
    checks.push(check);

    const names = new Set<string>();
    const repos = new Set<string>();
    for (const script of registry.scripts) {
      const name = script.name.toLowerCase();
      const repo = repoKey(script.url);
      if (names.has(name)) {
        check.errors.push(`Duplicate name: ${script.name}`);
      }
      if (repos.has(repo)) {
        check.errors.push(`Duplicate url: ${script.url}`);
      }
      names.add(name);
      repos.add(repo);

      entries.push(await checkRepo(script, check));
    }
  }

  const failed = checks.filter((check) => check.errors.length > 0);

  for (const check of checks) {
    const location = check.file ? ` file=${check.file}` : "";
    for (const error of check.errors) {
      if (onCi) console.log(`::error${location}::${check.name}: ${error}`);
      else console.error(`${check.name}: ${error}`);
    }
    for (const warning of check.warnings) {
      if (onCi) console.log(`::warning${location}::${check.name}: ${warning}`);
      else console.warn(`${check.name}: warning: ${warning}`);
    }
  }

  if (onCi) {
    writeFileSync("validation-report.md", buildReport(checks, entries));
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${checks.length} checks failed.`);
    process.exit(1);
  }
  console.log(`All checks passed (${entries.length} scripts checked).`);
}

main().catch((error) => {
  console.error(`Checks crashed: ${error}`);
  process.exit(1);
});

function readRegistry(): { scripts?: Script[]; errors: string[] } {
  let registry: unknown;
  try {
    registry = JSON.parse(readFileSync("registry.json", "utf8"));
  } catch (error) {
    return { errors: [`registry.json is not valid JSON: ${error}`] };
  }

  if (validateRegistry(registry)) {
    return { scripts: registry.scripts, errors: [] };
  }
  const errors: string[] = [];
  for (const error of validateRegistry.errors ?? []) {
    errors.push(`${error.instancePath || "/"} ${error.message}`);
  }
  return { errors };
}

function checkFormatting(): string[] {
  const prettier = spawnSync("npx", ["prettier", "--list-different", "."], {
    encoding: "utf8",
    shell: true,
  });
  // stdout is null if the spawn itself failed.
  const unformatted = (prettier.stdout ?? "").split("\n").filter(Boolean);
  if (prettier.status !== 0 && unformatted.length === 0) {
    const reason = prettier.error ?? prettier.stderr ?? "";
    return [`prettier could not run: ${reason}`.trim()];
  }

  const errors: string[] = [];
  for (const file of unformatted) {
    errors.push(`${file} is not formatted (run \`npm run format\`)`);
  }
  return errors;
}

async function checkRepo(script: Script, check: Check): Promise<Entry> {
  const entry: Entry = { name: script.name, license: null, sizeBytes: null };
  const fail = (message: string) =>
    check.errors.push(`${script.name}: ${message}`);

  const repo = parseRepo(script.url);
  if (!repo) {
    fail(`url is not a GitHub repo: ${script.url}`);
    return entry;
  }

  const meta = await getJson<{ license: { spdx_id: string } | null }>(
    `repos/${repo}`,
  );
  if (!meta) {
    fail(`unreachable: ${script.url}`);
    return entry;
  }

  entry.license = meta.license?.spdx_id ?? null;
  if (entry.license === null || entry.license === "NOASSERTION") {
    check.warnings.push(`${script.name}: no recognized license`);
  }

  const tree = await getJson<{ tree: { type: string; size?: number }[] }>(
    `repos/${repo}/git/trees/HEAD?recursive=1`,
  );
  if (!tree) {
    fail("could not read the repo file tree");
  } else {
    let total = 0;
    for (const node of tree.tree) {
      if (node.type === "blob") total += node.size ?? 0;
    }
    entry.sizeBytes = total;
    if (total > MAX_REPO_BYTES) {
      fail(
        `repo files total ${formatSize(total)}, over the ${formatSize(MAX_REPO_BYTES)} limit`,
      );
    }
  }

  const packageJson = await getFile(repo, "package.json");
  if (!packageJson) {
    fail("no package.json");
    return entry;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson);
  } catch {
    fail("package.json is not valid JSON");
    return entry;
  }

  if (!validateManifest(manifest)) {
    for (const error of validateManifest.errors ?? []) {
      fail(`package.json ${error.instancePath || "/"} ${error.message}`);
    }
    return entry;
  }

  if (!(await getFile(repo, manifest.main))) {
    fail(`main file "${manifest.main}" is missing`);
  }
  return entry;
}

function buildReport(checks: Check[], entries: Entry[]): string {
  const failed = checks.filter((check) => check.errors.length > 0);
  const lines: string[] = [];

  if (failed.length === 0) {
    lines.push("### All checks passed", "");
    for (const check of checks) {
      lines.push(`- ${check.name}`);
    }
    lines.push("");
  } else {
    lines.push(`### ${failed.length} of ${checks.length} checks failed`, "");
    for (const check of failed) {
      lines.push(`**${check.name}**`, "");
      for (const error of check.errors) {
        lines.push(`- ${error}`);
      }
      lines.push("");
    }
  }

  const warnings: string[] = [];
  for (const check of checks) {
    for (const warning of check.warnings) {
      warnings.push(`- ${check.name}: ${warning}`);
    }
  }
  if (warnings.length > 0) {
    lines.push("**Warnings**", "", ...warnings, "");
  }

  if (entries.length > 0) {
    lines.push("| Script | License | Size |", "| --- | --- | --- |");
    for (const entry of entries) {
      const license = entry.license ?? "none";
      lines.push(
        `| ${entry.name} | ${license} | ${formatSize(entry.sizeBytes)} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "unknown";
  const kib = bytes / 1024;
  return kib < 1024
    ? `${Math.round(kib)} KiB`
    : `${(kib / 1024).toFixed(1)} MiB`;
}

function repoKey(url: string): string {
  return (parseRepo(url) ?? url).toLowerCase();
}

function parseRepo(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

async function getFile(repo: string, path: string): Promise<string | null> {
  const response = await fetchGitHub(
    `repos/${repo}/contents/${path}`,
    "application/vnd.github.raw+json",
  );
  return response.ok ? response.text() : null;
}

async function getJson<T>(path: string): Promise<T | null> {
  const response = await fetchGitHub(path, "application/vnd.github+json");
  return response.ok ? (response.json() as Promise<T>) : null;
}

async function fetchGitHub(path: string, accept: string): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  return fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
