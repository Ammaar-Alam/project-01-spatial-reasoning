import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { editorHandler } from "./editor.ts";

// test fixtures, not benchmark tasks
const tower = {
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
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function setup(files: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "editor-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    const data = typeof content === "string" || Buffer.isBuffer(content);
    await writeFile(file, data ? content : JSON.stringify(content));
  }
  const handle = editorHandler({
    tasks: path.join(root, "tasks"),
    results: path.join(root, "results"),
  });
  const send = (url: string, init?: RequestInit) =>
    handle(new Request(`http://127.0.0.1${url}`, init));
  const put = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    send(url, { method: "PUT", headers, body: JSON.stringify(body) });
  return { root, send, put };
}

test("lists task ids and returns a task file as written", async () => {
  const { send } = await setup({
    "tasks/stack/tower-01.json": tower,
    "tasks/stack/tower-01.png": PNG,
    "tasks/stack/side.PNG": PNG,
    "tasks/loose.json": tower,
  });
  // the task loader accepts image extensions in any case, so serving must too
  const upper = await send("/tasks/stack/side.PNG");
  assert.equal(upper.status, 200);
  assert.equal(upper.headers.get("content-type"), "image/png");
  assert.deepEqual(await (await send("/api/tasks")).json(), ["stack/tower-01"]);
  assert.deepEqual(await (await send("/api/tasks/stack/tower-01")).json(), tower);
  assert.equal((await send("/api/tasks/stack/missing")).status, 404);
  assert.deepEqual(Buffer.from(await (await send("/tasks/stack/tower-01.png")).arrayBuffer()), PNG);
  // answer keys are read through the api only
  assert.equal((await send("/tasks/stack/tower-01.json")).status, 404);
});

test("saves a task that passes its own check, formatted like the rest of the repo", async () => {
  const { root, put } = await setup();
  const response = await put("/api/tasks/stack/tower-01", tower);
  assert.equal(response.status, 200);
  const saved = await readFile(path.join(root, "tasks/stack/tower-01.json"), "utf8");
  assert.deepEqual(JSON.parse(saved), tower);
  assert.match(saved, /^ {2}"initial": \[\{ "x": 0, "y": 0, "z": 0 \}\],$/m);
  assert.ok(saved.endsWith("}\n"));
});

test("writes nothing when a task breaks the schema or its own rules", async () => {
  const { root, send, put } = await setup();
  const file = path.join(root, "tasks/stack/tower-01.json");

  // the grid shrank under a starting block
  const shrunk = await put("/api/tasks/stack/tower-01", { ...tower, size: { x: 4, y: 1, z: 4 } });
  assert.equal(shrunk.status, 400);
  assert.match(await shrunk.text(), /out_of_bounds: 1 block outside the 4x1x4 grid/);

  const extra = await put("/api/tasks/stack/tower-01", { ...tower, colour: "red" });
  assert.equal(extra.status, 400);
  assert.match(await extra.text(), /colour/);

  const strict = await put("/api/tasks/stack/tower-01", { ...tower, constraints: { maxEdits: 0 } });
  assert.equal(strict.status, 400);
  assert.match(await strict.text(), /reference answer fails\n {2}too_many_edits/);

  const named = await put("/api/tasks/Stack/tower-01", tower);
  assert.equal(named.status, 400);

  const garbled = await send("/api/tasks/stack/tower-01", { method: "PUT", body: "{" });
  assert.equal(garbled.status, 400);
  assert.match(await garbled.text(), /not JSON/);
  assert.equal(existsSync(file), false);
});

test("refuses to create a task over one that exists, but saves edits to it", async () => {
  const { put } = await setup({ "tasks/stack/tower-01.json": tower });
  const edited = { ...tower, prompt: "Stack one more block." };
  const created = await put("/api/tasks/stack/tower-01", edited, { "If-None-Match": "*" });
  assert.equal(created.status, 409);
  assert.equal((await put("/api/tasks/stack/tower-01", edited)).status, 200);
});

test("saves of one task at the same time never mix, and only one create wins", async () => {
  const { root, put } = await setup();
  const file = path.join(root, "tasks/stack/tower-01.json");
  const prompts = Array.from({ length: 6 }, (_, i) => `Stack block ${i}.`);
  const creates = await Promise.all(
    prompts.map((prompt) =>
      put("/api/tasks/stack/tower-01", { ...tower, prompt }, { "If-None-Match": "*" }),
    ),
  );
  const statuses = creates.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409]);
  const winner = prompts[creates.findIndex((response) => response.status === 200)];
  assert.equal(JSON.parse(await readFile(file, "utf8")).prompt, winner);

  const edits = await Promise.all(
    prompts.map((prompt) => put("/api/tasks/stack/tower-01", { ...tower, prompt })),
  );
  assert.ok(edits.every((response) => response.status === 200));
  assert.ok(prompts.includes(JSON.parse(await readFile(file, "utf8")).prompt));
  assert.deepEqual(await readdir(path.dirname(file)), ["tower-01.json"]);
});

test("saves snapshots as PNG files inside the family folder", async () => {
  const { root, send } = await setup();
  const image = (name: string, body: Buffer) =>
    send(`/api/images/stack/${name}`, { method: "PUT", body: new Uint8Array(body) });
  assert.equal((await image("tower-01-front.png", PNG)).status, 200);
  assert.deepEqual(await readFile(path.join(root, "tasks/stack/tower-01-front.png")), PNG);
  assert.equal((await image("tower-01-front.png", Buffer.from("not a png"))).status, 400);
  assert.equal((await image("tower-01.json", PNG)).status, 400);
});

test("never reads or writes outside its folders", async () => {
  const { root, send, put } = await setup({ "secret.json": tower, "tasks/stack/a.json": tower });
  for (const url of [
    "/tasks/%2e%2e/secret.json",
    "/tasks/..%2fsecret.json",
    "/tasks/stack/..%5c..%5csecret.json",
    "/web/..%2f..%2fpackage.json",
    "/three/%2e%2e/%2e%2e/package.json",
    "/results/..%2f/tasks/secret.json",
    "/api/tasks/..%2f/secret",
    "/api/runs/..%2f",
  ]) {
    const response = await send(url);
    assert.ok([400, 404].includes(response.status), `${url} answered ${response.status}`);
  }
  assert.ok((await put("/api/tasks/..%2f..%2fx/y", tower)).status >= 400);
  assert.equal(existsSync(path.join(root, "x")), false);
});

test("answers only requests addressed to this machine", async () => {
  const { send } = await setup({ "tasks/stack/tower-01.json": tower });
  const handle = editorHandler({ tasks: "", results: "" });
  assert.equal((await handle(new Request("http://evil.example/api/tasks"))).status, 403);
  assert.equal((await send("/api/tasks")).status, 200);
});

test("serves the page's TypeScript as JavaScript", async () => {
  const { send } = await setup();
  const response = await send("/web/pick.ts");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
  const code = await response.text();
  assert.doesNotMatch(code, /: Cell\b/);
  assert.match(code, /export function/);
});

test("lists runs and shows every attempt with its parsed answer", async () => {
  const graded = { family: "stack", parent: "stack/tower-01", startedAt: "", latencyMs: 1 };
  const reply = { stopReason: null, servedModel: null, servedBy: null, responseId: null };
  const lines = [
    {
      ...graded,
      ...reply,
      task: "stack/tower-01",
      model: "a",
      attempt: 1,
      status: "graded",
      pass: true,
      failures: [],
      text: JSON.stringify(tower.reference),
      refusal: null,
      usage: null,
    },
    {
      ...graded,
      ...reply,
      task: "stack/tower-01",
      model: "b",
      attempt: 1,
      status: "graded",
      pass: false,
      failures: [{ code: "invalid_json", message: "reply is not one JSON value" }],
      text: "here you go",
      refusal: null,
      usage: null,
    },
    {
      ...graded,
      ...reply,
      task: "stack/tower-01",
      model: "c",
      attempt: 1,
      status: "graded",
      pass: false,
      failures: [{ code: "claimed_impossible", message: "the task has a solution" }],
      text: '{"status":"impossible","reason":"no room"}',
      refusal: null,
      usage: null,
    },
    {
      ...graded,
      task: "stack/tower-01",
      model: "d",
      attempt: 1,
      status: "error",
      error: "upstream failed",
    },
  ];
  const records = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"task":"stack/tow`;
  const { send } = await setup({
    "results/first/run.json": {},
    "results/first/records.jsonl": records,
    "results/first/tasks/stack/tower-01.json": { ...tower, images: ["tower-01.png", "side#1.png"] },
    "results/first/tasks/stack/tower-01.png": PNG,
    "results/first/tasks/stack/side#1.png": PNG,
    "results/no-settings/records.jsonl": "",
  });

  assert.deepEqual(await (await send("/api/runs")).json(), ["first"]);
  const run = (await (await send("/api/runs/first")).json()) as {
    tasks: { images: string[]; file?: string }[];
    attempts: { model: string; answer: unknown }[];
  };
  const [task] = run.tasks;
  assert.equal(run.tasks.length, 1);
  // file names are encoded so a # or ? stays part of the name
  assert.deepEqual(task?.images, [
    "/results/first/tasks/stack/tower-01.png",
    "/results/first/tasks/stack/side%231.png",
  ]);
  assert.equal(task?.file, undefined);
  assert.deepEqual(
    run.attempts.map((attempt) => [attempt.model, attempt.answer]),
    [
      ["a", tower.reference],
      ["b", null],
      ["c", { status: "impossible", reason: "no room" }],
      ["d", null],
    ],
  );
  for (const image of task?.images ?? []) assert.equal((await send(image)).status, 200);
  assert.equal((await send("/api/runs/missing")).status, 404);
});
