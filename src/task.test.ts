import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkTasks } from "./check-tasks.ts";
import { findTaskFiles, loadTask, TaskError } from "./task.ts";

// test fixture, not a benchmark task
const base = {
  prompt: "Add one block on top of the tower.",
  size: { x: 4, y: 4, z: 4 },
  initial: [{ x: 0, y: 0, z: 0 }],
  reference: {
    status: "solved",
    blocks: [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ],
  },
};

async function tasksDir(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tasks-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

async function loadError(name: string, content: unknown, extra: Record<string, unknown> = {}) {
  const root = await tasksDir({ [name]: content, ...extra });
  await assert.rejects(loadTask(root, path.join(root, name)), TaskError);
  return (await checkTasks(root)).problems;
}

test("loads a task and derives its id from the path", async () => {
  const root = await tasksDir({ "stack/tower-01.json": base });
  const task = await loadTask(root, path.join(root, "stack/tower-01.json"));
  assert.equal(task.id, "stack/tower-01");
  assert.equal(task.family, "stack");
  assert.equal(task.parent, "stack/tower-01");
  assert.deepEqual(task.images, []);
  assert.deepEqual(task.constraints, { protected: [] });
});

test("finds only JSON files and tolerates a missing folder", async () => {
  const root = await tasksDir({ "stack/a.json": base, "stack/a.png": "", "stack/b.json": base });
  assert.deepEqual(await findTaskFiles(root), [
    path.join(root, "stack/a.json"),
    path.join(root, "stack/b.json"),
  ]);
  assert.deepEqual(await findTaskFiles(path.join(root, "missing")), []);
});

test("rejects tasks outside a family folder or with bad names", async () => {
  await loadError("tower.json", base);
  await loadError("stack/deep/tower.json", base);
  await loadError("stack/Tower_01.json", base);
});

test("rejects invalid task files", async () => {
  await loadError("stack/broken.json", "{ not json");
  await loadError("stack/unknown-field.json", { ...base, difficulty: "hard" });
  await loadError("stack/outside.json", { ...base, initial: [{ x: 4, y: 0, z: 0 }] });
  await loadError("stack/twice.json", {
    ...base,
    initial: [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    ],
  });
  await loadError("stack/bad-size.json", { ...base, size: { x: 0, y: 4, z: 4 } });
  await loadError("stack/impossible-alternatives.json", {
    ...base,
    reference: { status: "impossible", reason: "the grid is full" },
    alternatives: [[{ x: 1, y: 0, z: 0 }]],
  });
});

test("checks that task images exist and are images", async () => {
  await loadError("stack/no-image.json", { ...base, images: ["front.png"] });
  await loadError("stack/text.json", { ...base, images: ["notes.txt"] }, { "stack/notes.txt": "" });
  await loadError(
    "stack/outside.json",
    { ...base, images: ["../shared/front.png"] },
    { "shared/front.png": "" },
  );

  const root = await tasksDir({
    "stack/view.json": { ...base, images: ["view/front.png"] },
    "stack/view/front.png": "",
  });
  const task = await loadTask(root, path.join(root, "stack/view.json"));
  assert.deepEqual(task.images, [path.join(root, "stack/view/front.png")]);
});

test("loads an image-only task that starts from an empty grid", async () => {
  const { initial: _, ...imageOnly } = base;
  const root = await tasksDir({
    "image/arch-01.json": { ...imageOnly, images: ["arch-01.png"] },
    "image/arch-01.png": "",
  });
  const task = await loadTask(root, path.join(root, "image/arch-01.json"));
  assert.deepEqual(task.initial, []);
  assert.deepEqual(await checkTasks(root), { checked: 1, problems: [] });
});

test("passes tasks whose reference answer passes", async () => {
  const root = await tasksDir({
    "stack/tower-01.json": base,
    "stack/tower-02.json": {
      ...base,
      reference: { status: "impossible", reason: "the grid is full" },
    },
  });
  assert.deepEqual(await checkTasks(root), { checked: 2, problems: [] });
});

test("flags tasks whose reference answer breaks their own rules", async () => {
  const root = await tasksDir({
    "stack/tower-01.json": { ...base, constraints: { maxEdits: 0 } },
    "stack/tower-02.json": base,
  });
  const { checked, problems } = await checkTasks(root);
  assert.equal(checked, 2);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /^stack\/tower-01: reference answer fails\n {2}too_many_edits/);
});

test("flags alternative answers that break the task's rules", async () => {
  const root = await tasksDir({
    "stack/tower-01.json": {
      ...base,
      constraints: { maxEdits: 1 },
      alternatives: [
        [
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 0 },
        ],
        [
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 0 },
          { x: 2, y: 0, z: 0 },
        ],
      ],
    },
  });
  const { problems } = await checkTasks(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /^stack\/tower-01: alternative 2 fails\n {2}too_many_edits/);
});
