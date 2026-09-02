# Orion Drift Spectator Script Registry

This repository is the official registry of community spectator scripts for Orion Drift. Each entry points to an external repository that hosts a spectator script. Adding your script here makes it discoverable to other players.

## How to apply for a script being added to the registry

1. Make a new repository for your script
   - See the example script for reference: [AA-Franz/OD_ExampleCameraScript](https://github.com/AA-Franz/OD_ExampleCameraScript)
2. Make a PR to this repository
   - Fork this repository
   - Add a reference to your camera package repository in the `registry.json` file
   - In your PR description, you MUST include:
     - A description of what your script does
     - Your exact Discord username

## Registry entry format

Each script is an object in the `scripts` array of [`registry.json`](registry.json). The fields are validated against [`src/registry.schema.json`](src/registry.schema.json):

| Field         | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| `name`        | Unique identifier of your camera package, e.g. `anotheraxiom.example`. |
| `displayName` | Human-friendly name shown in game.                                     |
| `author`      | Your name (Discord/Meta whatever, but something we can find you with). |
| `url`         | Link to the GitHub repository (`https://github.com/<owner>/<repo>`).   |

### Example

```json
{
  "name": "anotheraxiom.example",
  "displayName": "Example Script",
  "author": "Another Axiom",
  "url": "https://github.com/AA-Franz/OD_ExampleCameraScript"
}
```

## Validation

Every pull request is checked automatically by the [`Check Formatting and Schema`](.github/workflows/check.yml) workflow, which runs the following checks:

- **Formatting:** All JSON must be formatted with [Prettier](https://prettier.io/)
- **Registry Schema:** `registry.json` must validate against `src/registry.schema.json`
- **Your package.json Schemae:** Your camera script's `package.json` must validate against `src/package.schema.json`

You can run these checks locally with `npm run validate` before opening your PR to make sure they pass.
