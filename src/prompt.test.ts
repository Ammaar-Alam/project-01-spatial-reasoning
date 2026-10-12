import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildRequest, SYSTEM_PROMPT } from "./prompt.ts";
import { loadTask } from "./task.ts";

// test fixture, not a benchmark task
async function fixture(task: Record<string, unknown>, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-"));
  await mkdir(path.join(root, "stack"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, "stack", name), content);
  }
  await writeFile(path.join(root, "stack/tower.json"), JSON.stringify(task));
  return loadTask(root, path.join(root, "stack/tower.json"));
}

const tower = {
  prompt: "Add one block on top of the tower.",
  size: { x: 4, y: 5, z: 3 },
  initial: [
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 0 },
  ],
  reference: {
    status: "solved",
    blocks: [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 3, y: 4, z: 2 },
    ],
  },
  alternatives: [[{ x: 2, y: 3, z: 1 }]],
};

test("describes the goal, grid and starting blocks in a fixed order", async () => {
  const request = await buildRequest(await fixture(tower));
  assert.equal(request.system, SYSTEM_PROMPT);
  assert.deepEqual(request.images, []);
  assert.equal(
    request.text,
    [
      "Add one block on top of the tower.",
      "Grid: x from 0 to 3, y from 0 to 4, z from 0 to 2.",
      'Starting structure (2 blocks):\n[{"x":0,"y":0,"z":0},{"x":0,"y":1,"z":0}]',
    ].join("\n\n"),
  );
});

test("never shows the reference or alternative answers", async () => {
  const { text, system } = await buildRequest(await fixture(tower));
  for (const leaked of ['"x":3,"y":4,"z":2', '"x":2,"y":3,"z":1', "reference", "alternative"]) {
    assert.equal(`${system}\n${text}`.includes(leaked), false, leaked);
  }
});

test("states every rule the task sets", async () => {
  const { text } = await buildRequest(
    await fixture({
      ...tower,
      reference: { status: "impossible", reason: "no room" },
      alternatives: [],
      constraints: {
        maxEdits: 2,
        exactBlocks: 3,
        only: "add",
        protected: [{ x: 1, y: 0, z: 0 }],
      },
    }),
  );
  assert.ok(
    text.endsWith(
      [
        "Rules:",
        "- Make at most 2 edits.",
        "- An edit adds one block or removes one block, counted by comparing the final structure with the starting structure. Moving a block counts as 2 edits.",
        "- The final structure has exactly 3 blocks.",
        "- Only add blocks. Do not remove any starting block.",
        '- These cells must stay as they are, whether filled or empty:\n[{"x":1,"y":0,"z":0}]',
      ].join("\n"),
    ),
  );
});

test("sends images as base64 and marks an empty start", async () => {
  const { text, images } = await buildRequest(
    await fixture(
      { ...tower, initial: [], images: ["front.png", "top.jpg"] },
      {
        "front.png": "png-bytes",
        "top.jpg": "jpg-bytes",
      },
    ),
  );
  assert.match(text, /Starting structure: empty\.$/);
  assert.deepEqual(images, [
    { mediaType: "image/png", data: Buffer.from("png-bytes").toString("base64") },
    { mediaType: "image/jpeg", data: Buffer.from("jpg-bytes").toString("base64") },
  ]);
});
