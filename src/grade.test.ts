import assert from "node:assert/strict";
import { test } from "node:test";
import { grade } from "./grade.ts";
import { taskFileSchema } from "./task.ts";

type Cell = [number, number, number];

const blocks = (...cells: Cell[]) => cells.map(([x, y, z]) => ({ x, y, z }));
const solved = (...cells: Cell[]) => JSON.stringify({ status: "solved", blocks: blocks(...cells) });
const impossible = JSON.stringify({ status: "impossible", reason: "cannot be done" });

// test fixture: a two-block tower on a 4x4x4 grid, the goal is to add a third block on top
const tower = (extra: Record<string, unknown> = {}) =>
  taskFileSchema.parse({
    prompt: "Add one block on top of the tower.",
    size: { x: 4, y: 4, z: 4 },
    initial: blocks([0, 0, 0], [0, 1, 0]),
    reference: { status: "solved", blocks: blocks([0, 0, 0], [0, 1, 0], [0, 2, 0]) },
    ...extra,
  });

const codes = (task: ReturnType<typeof tower>, raw: string) =>
  grade(task, raw).failures.map((failure) => failure.code);

test("passes an exact match in any block order", () => {
  assert.deepEqual(grade(tower(), solved([0, 0, 0], [0, 1, 0], [0, 2, 0])), {
    pass: true,
    failures: [],
  });
  assert.equal(grade(tower(), solved([0, 2, 0], [0, 0, 0], [0, 1, 0])).pass, true);
});

test("fails missing and extra blocks", () => {
  assert.deepEqual(codes(tower(), solved([0, 0, 0], [0, 1, 0])), ["wrong_structure"]);
  assert.deepEqual(codes(tower(), solved([0, 0, 0], [0, 1, 0], [0, 2, 0], [1, 0, 0])), [
    "wrong_structure",
  ]);
});

test("reports which blocks are missing and extra", () => {
  const [failure] = grade(tower(), solved([0, 0, 0], [0, 1, 0], [1, 2, 0])).failures;
  assert.equal(failure?.message, "missing 1 block: (0, 2, 0); 1 block extra: (1, 2, 0)");
});

test("fails illegal structures before comparing them", () => {
  assert.deepEqual(codes(tower(), solved([0, 0, 0], [0, 1, 0], [0, 4, 0])), ["out_of_bounds"]);
  assert.deepEqual(codes(tower(), solved([0, 0, 0], [0, 1, 0], [0, -1, 0])), ["out_of_bounds"]);
  assert.deepEqual(codes(tower(), solved([0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 2, 0])), [
    "duplicate_block",
  ]);
});

test("fails malformed replies", () => {
  assert.deepEqual(codes(tower(), "I would add a block at (0, 2, 0)."), ["invalid_json"]);
  assert.deepEqual(codes(tower(), '{"status": "solved"}'), ["invalid_answer"]);
});

test("grades impossible claims against the reference", () => {
  const unsolvable = tower({ reference: { status: "impossible", reason: "no room above" } });
  assert.deepEqual(codes(tower(), impossible), ["claimed_impossible"]);
  assert.equal(grade(unsolvable, impossible).pass, true);
  assert.deepEqual(codes(unsolvable, solved([0, 0, 0], [0, 1, 0], [0, 2, 0])), [
    "missed_impossible",
  ]);
});

test("accepts an empty structure when that is the answer", () => {
  const clear = tower({ reference: { status: "solved", blocks: [] } });
  assert.equal(grade(clear, solved()).pass, true);
});

test("counts a moved block as one removal plus one addition", () => {
  const task = tower({ constraints: { maxEdits: 1 } });
  assert.deepEqual(codes(task, solved([0, 0, 0], [0, 2, 0])), [
    "too_many_edits",
    "wrong_structure",
  ]);
});

test("enforces edit limits", () => {
  const task = tower({ constraints: { maxEdits: 1 } });
  assert.equal(grade(task, solved([0, 0, 0], [0, 1, 0], [0, 2, 0])).pass, true);
  assert.deepEqual(codes(task, solved([0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0])), [
    "too_many_edits",
    "wrong_structure",
  ]);
  const exact = tower({ constraints: { exactEdits: 2 } });
  assert.deepEqual(codes(exact, solved([0, 0, 0], [0, 1, 0], [0, 2, 0])), ["wrong_edit_count"]);
});

test("enforces block counts", () => {
  const capped = tower({ constraints: { maxBlocks: 3 } });
  assert.equal(grade(capped, solved([0, 0, 0], [0, 1, 0], [0, 2, 0])).pass, true);
  assert.deepEqual(codes(capped, solved([0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0])), [
    "too_many_blocks",
    "wrong_structure",
  ]);
  const exact = tower({ constraints: { exactBlocks: 4 } });
  assert.deepEqual(codes(exact, solved([0, 0, 0], [0, 1, 0], [0, 2, 0])), ["wrong_block_count"]);
});

test("protects filled and empty cells", () => {
  const task = tower({ constraints: { protected: blocks([0, 0, 0], [1, 0, 0]) } });
  assert.deepEqual(codes(task, solved([0, 1, 0], [0, 2, 0])), [
    "protected_changed",
    "wrong_structure",
  ]);
  assert.deepEqual(codes(task, solved([0, 0, 0], [0, 1, 0], [0, 2, 0], [1, 0, 0])), [
    "protected_changed",
    "wrong_structure",
  ]);
});

test("enforces add-only and remove-only tasks", () => {
  const addOnly = tower({ constraints: { only: "add" } });
  assert.equal(grade(addOnly, solved([0, 0, 0], [0, 1, 0], [0, 2, 0])).pass, true);
  assert.deepEqual(codes(addOnly, solved([0, 0, 0])), ["forbidden_edit", "wrong_structure"]);
  const removeOnly = tower({ constraints: { only: "remove" } });
  assert.deepEqual(codes(removeOnly, solved([0, 0, 0], [0, 1, 0], [0, 2, 0])), ["forbidden_edit"]);
});
