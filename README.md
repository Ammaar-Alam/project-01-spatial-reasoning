# Spatial Reasoning Benchmark

[![CI](https://github.com/Ammaar-Alam/project-01-spatial-reasoning/actions/workflows/ci.yml/badge.svg)](https://github.com/Ammaar-Alam/project-01-spatial-reasoning/actions/workflows/ci.yml)

A COS 597C Project 1 benchmark by Ammaar Alam and Erik Dyer for evaluating spatial reasoning through one-shot construction and manipulation tasks.

Each task gives a model a starting structure or images, a goal, and any constraints. The model answers once with the complete final structure as JSON, or says the task is impossible. A strict grader scores every answer as pass or fail.

The suite covers spatial transformations, reconstruction from images and viewpoint changes, and constrained editing puzzles.

## Setup

Requires Node.js 24.11 or newer and pnpm.

```sh
pnpm install
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm tasks:check` | Loads every task in `tasks/` and confirms its reference answer passes the grader |
| `pnpm test` | Runs the unit tests |
| `pnpm check` | Lint, typecheck, tests and task check, the same as CI |
| `pnpm format` | Formats and fixes lint issues in place |

## Tasks

Everything about a task lives in one JSON file: the prompt, the starting blocks, the rules, and the answer key. To add a task:

1. Create `tasks/<family>/<name>.json`. A new family is a new folder.
2. Put any images next to it and list them in `images`.
3. Run `pnpm tasks:check`.

No other file or code changes. The path gives the task its id, for example `tasks/transform/mirror-l-01.json` is `transform/mirror-l-01`. Names use lowercase letters, digits and hyphens.

```json
{
  "prompt": "Mirror the structure across the plane x = 3.5.",
  "size": { "x": 8, "y": 4, "z": 4 },
  "initial": [{ "x": 1, "y": 0, "z": 0 }, { "x": 2, "y": 0, "z": 0 }, { "x": 1, "y": 1, "z": 0 }],
  "constraints": { "maxEdits": 6 },
  "reference": {
    "status": "solved",
    "blocks": [{ "x": 6, "y": 0, "z": 0 }, { "x": 5, "y": 0, "z": 0 }, { "x": 6, "y": 1, "z": 0 }]
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | The instruction shown to the model |
| `size` | yes | Grid dimensions. Coordinates run from 0 to size - 1, and y is up |
| `initial` | no | Blocks present at the start. Defaults to none |
| `images` | no | PNG, JPEG or WebP files shown to the model, with paths relative to the task file |
| `constraints` | no | Rules the answer must follow, listed below |
| `parent` | no | Groups variations of one puzzle. Defaults to the task id |
| `reference` | yes | The correct answer, in the same format a model uses. Never shown to the model |
| `alternatives` | no | Other final structures that are also correct, for tasks with more than one valid answer |

| Constraint | Rule |
| --- | --- |
| `maxEdits`, `exactEdits` | Limit on added plus removed blocks, compared between the initial and final structures. Moving a block counts as 2 edits |
| `maxBlocks`, `exactBlocks` | Limit on the number of blocks in the final structure |
| `protected` | Cells that must be the same before and after, whether filled or empty |
| `only` | `"add"` or `"remove"` to allow only one kind of edit |

## Answers

A model replies with exactly one JSON object, either the full final structure or a claim that the task cannot be solved:

```json
{ "status": "solved", "blocks": [{ "x": 0, "y": 0, "z": 0 }] }
```

```json
{ "status": "impossible", "reason": "The digit needs at least 5 edits." }
```

One surrounding ` ```json ` fence is allowed. Any other text, a second JSON object, extra fields, non-integer coordinates, blocks outside the grid, or the same block listed twice fails the answer. Nothing is repaired or retried.

An answer passes when it follows every constraint and its blocks exactly match the reference or one of the alternatives, in any order. On a task whose reference is `impossible`, only an `impossible` answer passes. The reason is kept for review but not scored.

[docs/architecture.md](docs/architecture.md) has diagrams of the data model and the grading flow, plus every failure code.

## License

[MIT](LICENSE)
