import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ModelConfig } from "./models.ts";
import type { ModelReply } from "./providers.ts";
import { type Call, type RunOptions, readRecords, runEval, selectTasks, summarize } from "./run.ts";
import { loadTasks } from "./task.ts";

// test fixtures, not benchmark tasks
const solvable = {
  prompt: "Add one block on top of the block.",
  size: { x: 2, y: 2, z: 2 },
  initial: [{ x: 0, y: 0, z: 0 }],
  reference: {
    status: "solved",
    blocks: [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ],
  },
};
const unsolvable = { ...solvable, reference: { status: "impossible", reason: "no room" } };

async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "run-"));
  const files = { "stack/one.json": solvable, "stack/two.json": unsolvable, ...extra };
  for (const [name, task] of Object.entries(files)) {
    const file = path.join(root, "tasks", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof task === "string" ? task : JSON.stringify(task));
  }
  return {
    dir: path.join(root, "results", "test-run"),
    tasks: await loadTasks(path.join(root, "tasks")),
  };
}

const models: Record<string, ModelConfig> = {
  builder: { provider: "openai", model: "builder", params: {} },
  quitter: { provider: "openrouter", model: "quitter", params: { max_tokens: 10 } },
};

const reply = (text: string): ModelReply => ({
  text,
  stopReason: "stop",
  servedModel: null,
  servedBy: null,
  responseId: null,
  refusal: null,
  usage: null,
});

// "builder" always builds the solvable task's answer, "quitter" always says impossible
// failing models throw instead, like a provider outage
function fakeModels(failing: string[] = []) {
  const calls: string[] = [];
  const call: Call = async (config) => {
    calls.push(config.model);
    if (failing.includes(config.model)) throw new Error("503 overloaded");
    return reply(
      config.model === "quitter"
        ? '{"status": "impossible", "reason": "no"}'
        : JSON.stringify({ status: "solved", blocks: solvable.reference.blocks }),
    );
  };
  return { call, calls };
}

const run = (
  setup: Pick<RunOptions, "dir" | "tasks">,
  call: Call,
  overrides: Partial<RunOptions> = {},
) => runEval({ ...setup, models, attempts: 2, concurrency: 3, call, ...overrides });

test("grades every task, model and attempt once and saves each record", async () => {
  const setup = await fixture();
  const { call, calls } = fakeModels();
  await run(setup, call);
  assert.equal(calls.length, 2 * 2 * 2);

  const saved = await readRecords(path.join(setup.dir, "records.jsonl"));
  const outcome = (task: string, model: string) =>
    saved
      .filter((record) => record.task === task && record.model === model)
      .map((record) => (record.status === "graded" ? record.pass : "error"));
  assert.deepEqual(outcome("stack/one", "builder"), [true, true]);
  assert.deepEqual(outcome("stack/one", "quitter"), [false, false]);
  assert.deepEqual(outcome("stack/two", "builder"), [false, false]);
  assert.deepEqual(outcome("stack/two", "quitter"), [true, true]);

  const record = saved.find((r) => r.task === "stack/one" && r.model === "quitter");
  assert.equal(record?.status === "graded" && record.failures[0]?.code, "claimed_impossible");
  assert.equal(record?.parent, "stack/one");
  assert.equal(
    record?.status === "graded" && record.text,
    '{"status": "impossible", "reason": "no"}',
  );
});

test("records the settings a run was started with", async () => {
  const setup = await fixture();
  await run(setup, fakeModels().call);
  const settings = JSON.parse(await readFile(path.join(setup.dir, "run.json"), "utf8"));
  assert.equal(settings.attempts, 2);
  assert.deepEqual(settings.models, models);
  assert.deepEqual(Object.keys(settings.tasks), ["stack/one", "stack/two"]);
  assert.match(settings.tasks["stack/one"], /^[0-9a-f]{64}$/);
  assert.ok(settings.system.length > 0);
});

test("saves failed calls as errors and retries only those on the next run", async () => {
  const setup = await fixture();
  await run(setup, fakeModels(["quitter"]).call);

  const retry = fakeModels();
  await run(setup, retry.call);
  assert.deepEqual(retry.calls, ["quitter", "quitter", "quitter", "quitter"]);

  const saved = await readRecords(path.join(setup.dir, "records.jsonl"));
  assert.equal(saved.length, 12);
  assert.equal(saved.filter((record) => record.status === "error").length, 4);
  assert.deepEqual(summarize(saved, ["builder", "quitter"]), [
    "builder: 2/4 passed",
    "quitter: 2/4 passed",
  ]);

  const done = fakeModels();
  await run(setup, done.call);
  assert.deepEqual(done.calls, []);
});

test("refuses to resume a run with different settings or changed tasks", async () => {
  const setup = await fixture();
  const { call } = fakeModels();
  await run(setup, call);
  await assert.rejects(run(setup, call, { attempts: 3 }), /different attempts/);
  await assert.rejects(
    run(setup, call, { models: { builder: models.builder as ModelConfig } }),
    /different models/,
  );
  const edited = setup.tasks.map((task) => ({ ...task, prompt: `${task.prompt} Quickly.` }));
  await assert.rejects(run({ ...setup, tasks: edited }, call), /different tasks/);
});

test("refuses to resume a run after its answer key changes", async () => {
  const setup = await fixture();
  const { call } = fakeModels();
  await run(setup, call);
  const rekeyed = setup.tasks.map((task) => ({
    ...task,
    alternatives: [[{ x: 1, y: 0, z: 0 }]],
  }));
  await assert.rejects(run({ ...setup, tasks: rekeyed }, call), /different tasks/);
  const regrouped = setup.tasks.map((task) => ({ ...task, parent: "stack/other" }));
  await assert.rejects(run({ ...setup, tasks: regrouped }, call), /different tasks/);
});

test("times a resumed response from when it was first sent", async () => {
  const setup = await fixture();
  const one = { ...setup, tasks: setup.tasks.filter((task) => task.id === "stack/one") };
  const options = { models: { builder: models.builder as ModelConfig }, attempts: 1 };
  const lost: Call = async (_config, _request, resume) => {
    resume.started("resp_9");
    throw new Error("poll failed");
  };
  await run(one, lost, options);

  const file = path.join(setup.dir, "records.jsonl");
  const [first] = await readRecords(file);
  const sentAt = new Date(Date.now() - 120_000).toISOString();
  await writeFile(file, `${JSON.stringify({ ...first, startedAt: sentAt })}\n`);

  // the saved response finishes, so the answer carries its id
  const answeredBy =
    (id: string, announce: boolean): Call =>
    async (config, request, resume) => {
      if (announce) resume.started(id);
      return { ...(await fakeModels().call(config, request, resume)), responseId: id };
    };
  await run(one, answeredBy("resp_9", false), options);
  const resumed = (await readRecords(file)).at(-1);
  assert.equal(resumed?.status, "graded");
  assert.equal(resumed?.startedAt, sentAt);
  assert.ok((resumed?.latencyMs ?? 0) >= 120_000);

  // a fresh request that replaces a failed one is timed from its own start,
  // whether it is still running when created or finishes right away
  for (const announce of [true, false]) {
    await writeFile(file, `${JSON.stringify({ ...first, startedAt: sentAt })}\n`);
    await run(one, answeredBy("resp_10", announce), options);
    const fresh = (await readRecords(file)).at(-1);
    assert.notEqual(fresh?.startedAt, sentAt);
    assert.ok((fresh?.latencyMs ?? Infinity) < 60_000);
  }
});

test("fails a reply the provider marked as a refusal even if its text is a correct answer", async () => {
  const setup = await fixture();
  const refusing: Call = async (config, request, resume) => ({
    ...(await fakeModels().call(config, request, resume)),
    refusal: "I can't help with that.",
  });
  await run(setup, refusing, { models: { builder: models.builder as ModelConfig }, attempts: 1 });
  const saved = await readRecords(path.join(setup.dir, "records.jsonl"));
  const record = saved.find((r) => r.task === "stack/one");
  assert.equal(record?.status === "graded" && record.pass, false);
  assert.deepEqual(record?.status === "graded" && record.failures, [
    { code: "refused", message: "I can't help with that." },
  ]);
});

test("keeps a copy of every task file and image a run used", async () => {
  const setup = await fixture({
    "image/arch.json": { ...solvable, images: ["arch/front.png"] },
    "image/arch/front.png": "png-bytes",
  });
  await run(setup, fakeModels().call, { attempts: 1 });

  const copy = path.join(setup.dir, "tasks");
  assert.equal(await readFile(path.join(copy, "image/arch/front.png"), "utf8"), "png-bytes");
  const original = path.join(path.dirname(setup.dir), "..", "tasks", "stack/one.json");
  await writeFile(original, JSON.stringify({ ...solvable, prompt: "Edited later." }));

  const copied = await loadTasks(copy);
  assert.deepEqual(
    copied.map((task) => task.id),
    ["image/arch", "stack/one", "stack/two"],
  );
  assert.equal(copied.find((task) => task.id === "stack/one")?.prompt, solvable.prompt);
});

test("keeps polling a started response instead of sending the task again", async () => {
  const setup = await fixture();
  const one = { ...setup, tasks: setup.tasks.filter((task) => task.id === "stack/one") };
  const lost: Call = async (_config, _request, resume) => {
    resume.started("resp_9");
    throw new Error("poll failed");
  };
  await run(one, lost, { models: { builder: models.builder as ModelConfig }, attempts: 1 });

  const file = path.join(setup.dir, "records.jsonl");
  const saved = await readRecords(file);
  assert.deepEqual(
    saved.map((record) => [record.status, "responseId" in record ? record.responseId : null]),
    [
      ["started", "resp_9"],
      ["error", "resp_9"],
    ],
  );

  // a crash after the response was created leaves only the started line
  await writeFile(file, `${JSON.stringify(saved[0])}\n`);
  const resumed: (string | undefined)[] = [];
  const finish: Call = async (config, request, resume) => {
    resumed.push(resume.responseId);
    return fakeModels().call(config, request, resume);
  };
  await run(one, finish, { models: { builder: models.builder as ModelConfig }, attempts: 1 });
  assert.deepEqual(resumed, ["resp_9"]);
  const final = (await readRecords(file)).at(-1);
  assert.equal(final?.status === "graded" && final.pass, true);
});

test("summarizes errors that still need a retry", () => {
  const base = { family: "stack", parent: "stack/one", model: "m", attempt: 1, startedAt: "" };
  const records = [
    { ...base, task: "stack/one", latencyMs: 1, status: "error" as const, error: "timeout" },
    {
      ...base,
      task: "stack/two",
      latencyMs: 1,
      status: "graded" as const,
      pass: true,
      failures: [],
      ...reply(""),
    },
  ];
  assert.deepEqual(summarize(records, ["m"]), [
    "m: 1/1 passed, 1 unfinished, run again to finish them",
  ]);
});

test("selects tasks by family or id", async () => {
  const { tasks } = await fixture({ "shape/three.json": solvable });
  const ids = (filter?: string) => selectTasks(tasks, filter).map((task) => task.id);
  assert.deepEqual(ids(), ["shape/three", "stack/one", "stack/two"]);
  assert.deepEqual(ids("stack"), ["stack/one", "stack/two"]);
  assert.deepEqual(ids("shape,stack/two"), ["shape/three", "stack/two"]);
  assert.throws(() => selectTasks(tasks, "nope"), /no task or family named nope/);
  assert.throws(() => selectTasks([]), /no tasks found/);
});
