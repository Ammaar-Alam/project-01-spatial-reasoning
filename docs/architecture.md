# Architecture

This page describes how tasks are stored, how a model's answer is graded, and how the source modules depend on each other.

## Overview

```mermaid
flowchart LR
  file["tasks/family/name.json"] --> load["loadTask<br/>schema, grid bounds, images"]
  load --> task["Task"]
  task --> grade["grade"]
  reply["Model reply<br/>(raw text)"] --> grade
  grade --> result["Grade<br/>pass, failures"]
  task --> check["check-tasks<br/>grades each task's own reference"]
  check --> grade
```

A task file is loaded and validated once. Grading takes the loaded task and the model's raw reply text and returns a pass or fail with the list of failures. `pnpm tasks:check` runs every task's reference answer through the same grader, so a task cannot enter the benchmark if its own answer breaks its rules.

## Data model

```mermaid
classDiagram
  direction LR
  class Task {
    id: string
    family: string
    parent: string
    prompt: string
    size: Size
    initial: Block[]
    images: string[]
    constraints: Constraints
    reference: Answer
  }
  class Constraints {
    maxEdits: number, optional
    exactEdits: number, optional
    maxBlocks: number, optional
    exactBlocks: number, optional
    protected: Block[]
    only: add or remove, optional
  }
  class Block {
    x: int
    y: int
    z: int
  }
  class Answer {
    <<union>>
    status: solved or impossible
  }
  class Solved {
    status: solved
    blocks: Block[]
  }
  class Impossible {
    status: impossible
    reason: string
  }
  class Grade {
    pass: boolean
    failures: Failure[]
  }
  class Failure {
    code: FailureCode
    message: string
  }
  Task *-- Constraints
  Task o-- Block : initial
  Task --> Answer : reference
  Answer <|-- Solved
  Answer <|-- Impossible
  Solved o-- Block : blocks
  Grade *-- Failure
```

A model's answer and a task's reference use the same `Answer` format. That is what lets `check-tasks` grade the reference like any other answer.

`id`, `family` and `parent` are not stored in the file. The loader takes `id` and `family` from the path, and `parent` defaults to the id.

## Grading

```mermaid
flowchart TD
  reply["Reply text"] --> parse{"One JSON object<br/>matching the answer schema?"}
  parse -- no --> f1["invalid_json or invalid_answer"]
  parse -- yes --> status{"status"}
  status -- impossible --> refA{"Reference is impossible?"}
  refA -- yes --> pass1["Pass"]
  refA -- no --> f2["claimed_impossible"]
  status -- solved --> legal{"Every block inside the grid<br/>and listed once?"}
  legal -- no --> f3["out_of_bounds and/or duplicate_block"]
  legal -- yes --> refB{"Reference is impossible?"}
  refB -- yes --> f4["missed_impossible"]
  refB -- no --> rules["Check every constraint,<br/>then compare to the reference"]
  rules --> any{"Any failures?"}
  any -- no --> pass2["Pass"]
  any -- yes --> f5["Fail with every<br/>failure found"]
```

Parsing accepts the whole reply as one JSON value, optionally inside one ` ```json ` fence. It never picks one object out of several, and it never repairs an answer.

Constraint checks and the structure comparison all run, so a failing answer reports every rule it broke instead of only the first.

### Counting edits

Edits compare the initial structure `S` with the final structure `F`. They do not depend on the order the model might have imagined making changes.

- added = blocks in `F` that are not in `S`
- removed = blocks in `S` that are not in `F`
- edits = added + removed

Moving one block from `(0, 0, 0)` to `(1, 0, 0)` is 1 removal plus 1 addition, so 2 edits.

### Failure codes

| Code | Meaning |
| --- | --- |
| `invalid_json` | The reply is not exactly one JSON value |
| `invalid_answer` | The JSON does not match the answer schema |
| `out_of_bounds` | A block is outside the task's grid |
| `duplicate_block` | The same block is listed more than once |
| `claimed_impossible` | The answer says impossible, but the task has a solution |
| `missed_impossible` | The answer builds a structure, but the task has no solution |
| `too_many_edits` | More edits than `maxEdits` |
| `wrong_edit_count` | Edits differ from `exactEdits` |
| `too_many_blocks` | More final blocks than `maxBlocks` |
| `wrong_block_count` | Final block count differs from `exactBlocks` |
| `protected_changed` | A protected cell was filled or emptied |
| `forbidden_edit` | A removal in an add-only task, or an addition in a remove-only task |
| `wrong_structure` | The final blocks differ from the reference |

## Modules

```mermaid
flowchart BT
  geometry["geometry.ts<br/>Block, bounds, set helpers"]
  answer["answer.ts<br/>answer schema, strict parsing"]
  task["task.ts<br/>task schema, loading"]
  grade["grade.ts<br/>grading, failure codes"]
  check["check-tasks.ts<br/>CLI"]
  answer --> geometry
  task --> answer
  task --> geometry
  grade --> answer
  grade --> geometry
  grade -. types only .-> task
  check --> grade
  check --> task
```

Arrows point from a module to the module it imports. There are no import cycles. File system access is limited to `findTaskFiles` and `loadTask` in `task.ts`, so parsing and grading are pure functions. Tests sit next to the module they cover as `*.test.ts` and run with Node's built-in test runner.
