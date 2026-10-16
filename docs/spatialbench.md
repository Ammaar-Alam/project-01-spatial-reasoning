# SpatialBench tasks

This collection contains 32 tasks: eight packing, eight reconstruction, eight camera-edit, four minimum-connection and four minimum-separation puzzles. There are 24 solvable tasks and eight intentionally impossible cases. The recorded comparison uses 24 tasks; the other eight were calibration examples.

## Images

The PNG clues are **custom diagrams, not harness snapshot exports**. Packing uses labeled piece layers, reconstruction uses ray-count maps, viewpoint tasks use landmark/depth masks, and repair tasks use corridor or terminal diagrams. They use the native task schema and grader, but measure reasoning over these diagrams rather than the harness's ordinary rendered views. Eight tasks supply their clues entirely as text.

The input images are byte-identical to those used in the recorded evaluation. Replacing them with 3D snapshots would create different task inputs and require new evaluations. The native editor renders the initial and accepted answer structures for inspection.

## Open and check

```sh
pnpm editor
# Select a task in Build, or oct16-spatialbench in Results.
pnpm check
```

Task JSON uses the same Biome formatter as the editor's Save action. Each task and its clue images live in `tasks/<family>/`. Recorded responses, unchanged run metadata and task snapshots use `results/oct16-spatialbench/`. No separate editor, fixture loader or API-provider changes are required.

## Existing results

The comparison has 18 solvable and six impossible tasks, with 160 graded responses and eight unreturned outcomes. Gemini 3.8 Flash and DeepSeek V4.1 Flash each solved 4 of 18 solvable tasks. The other routes are GLM 5.3 Flash, Qwen 3.7 Flash, GPT-6 Luna, Kimi K2.5 and MiMo V2.5. The archived provider is Prime Intellect; provider/model configuration labels remain as recorded.

This is a small authored set, with unmatched text/image instances and differing output budgets. Thirty-nine responses reached an output limit. The native grader checks exact accepted occupancy and native constraints. It scores impossibility by status, not the explanation. Results therefore combine diagram reading, planning and exact JSON construction, and do not establish a general model ranking.
