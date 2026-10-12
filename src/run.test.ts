import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { existsSync } from "node:fs";
import fsp, { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
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
  assert.match(settings.code, /^[0-9a-f]{64}$/);
  assert.ok(settings.system.length > 0);
});

test("refuses to resume a run started with different code", async () => {
  const setup = await fixture();
  const { call } = fakeModels();
  await run(setup, call);
  const file = path.join(setup.dir, "run.json");
  const settings = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...settings, code: "0".repeat(64) }));
  await assert.rejects(run(setup, call), /different code/);
});

test("lets only one invocation work on a run at a time", async () => {
  const setup = await fixture();
  const { call, calls } = fakeModels();
  // slow enough that the first run is still going when the second one starts
  const slow: Call = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return call(...args);
  };
  const outcomes = await Promise.allSettled([run(setup, slow), run(setup, slow)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
  const refused = outcomes.find((outcome) => outcome.status === "rejected");
  assert.match(String(refused?.reason), /in use by another run/);
  assert.equal(calls.length, 8);
  assert.equal(existsSync(path.join(setup.dir, "run.lock")), false);
});

test("stops taking new work after a failure but keeps the lock until requests in flight finish", async () => {
  const setup = await fixture();
  const { call, calls } = fakeModels();
  // the first request fails quickly while the others are still waiting on the provider
  let sent = 0;
  let inFlight = 0;
  const slow: Call = async (...args) => {
    inFlight++;
    await new Promise((resolve) => setTimeout(resolve, ++sent === 1 ? 10 : 100));
    inFlight--;
    return call(...args);
  };
  let logged = 0;
  const log = () => {
    if (++logged === 1) throw new Error("disk full");
  };
  await assert.rejects(run(setup, slow, { log }), /disk full/);
  assert.equal(inFlight, 0);
  assert.equal(calls.length, 3);
  assert.equal((await readRecords(path.join(setup.dir, "records.jsonl"))).length, 3);
  assert.equal(existsSync(path.join(setup.dir, "run.lock")), false);
});

test("takes over the lock of a run that was killed", async () => {
  const setup = await fixture();
  await mkdir(setup.dir, { recursive: true });
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  await writeFile(path.join(setup.dir, "run.lock"), String(pid));
  const { call, calls } = fakeModels();
  await run(setup, call);
  assert.equal(calls.length, 8);
  assert.equal(existsSync(path.join(setup.dir, `run.lock.${pid}`)), false);
});

test("takes over a killed run's lock even if a run was killed while taking it over", async () => {
  const setup = await fixture();
  await mkdir(setup.dir, { recursive: true });
  const [owner, claimant] = [0, 1].map(() => spawnSync(process.execPath, ["-e", ""]).pid);
  await writeFile(path.join(setup.dir, "run.lock"), String(owner));
  await writeFile(path.join(setup.dir, `run.lock.${owner}`), String(claimant));
  const { call, calls } = fakeModels();
  await run(setup, call);
  assert.equal(calls.length, 8);
  const left = (await readdir(setup.dir)).filter((name) => name.startsWith("run.lock"));
  assert.deepEqual(left, []);
});

test("lets only one of two runs take over a killed run's lock", async () => {
  const setup = await fixture();
  await mkdir(setup.dir, { recursive: true });
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  await writeFile(path.join(setup.dir, "run.lock"), String(pid));
  const { call, calls } = fakeModels();
  const slow: Call = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return call(...args);
  };
  const outcomes = await Promise.allSettled([run(setup, slow), run(setup, slow)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(calls.length, 8);
});

test("does not take over a killed run's lock that another run has already taken", async () => {
  const setup = await fixture();
  await mkdir(setup.dir, { recursive: true });
  const lock = path.join(setup.dir, "run.lock");
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  await writeFile(lock, String(pid));
  const read = fsp.readFile;
  let seen = false;
  // another run finishes its takeover right after this one reads the dead pid
  mock.method(fsp, "readFile", async (...args: Parameters<typeof read>) => {
    const data = await read(...args);
    if (args[0] === lock && !seen) {
      seen = true;
      fs.writeFileSync(lock, String(process.pid));
    }
    return data;
  });
  syncBuiltinESMExports();
  const { call, calls } = fakeModels();
  try {
    await assert.rejects(run(setup, call), /in use by another run/);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(calls.length, 0);
});

test("removes a partly written record before the next one is saved", async () => {
  const setup = await fixture();
  const append = fs.appendFileSync;
  let appends = 0;
  // the disk fills up halfway through the first record
  mock.method(fs, "appendFileSync", (...args: Parameters<typeof append>) => {
    if (++appends > 1) return append(...args);
    append(args[0], String(args[1]).slice(0, 10));
    throw new Error("ENOSPC: no space left on device");
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(run(setup, fakeModels().call), /ENOSPC/);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }

  const file = path.join(setup.dir, "records.jsonl");
  assert.equal((await readRecords(file)).length, 2);
  const retry = fakeModels();
  await run(setup, retry.call);
  assert.equal(retry.calls.length, 6);
});

test("sets aside a record cut off by a crash and resumes from the complete ones", async () => {
  const setup = await fixture();
  await run(setup, fakeModels(["quitter"]).call);
  const file = path.join(setup.dir, "records.jsonl");
  await appendFile(file, '{"task":"stack/one","mod');

  const retry = fakeModels();
  await run(setup, retry.call);
  assert.equal(retry.calls.length, 4);
  assert.equal((await readRecords(file)).length, 12);
  assert.equal(await readFile(`${file}.partial`, "utf8"), '{"task":"stack/one","mod');
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
      if (id !== resume.responseId) {
        // the saved response is looked up before a new request replaces it
        await new Promise((resolve) => setTimeout(resolve, 50));
        resume.sending();
      }
      if (announce) resume.started(id);
      return { ...(await fakeModels().call(config, request, resume)), responseId: id };
    };
  await run(one, answeredBy("resp_9", false), options);
  const resumed = (await readRecords(file)).at(-1);
  assert.equal(resumed?.status, "graded");
  assert.equal(resumed?.startedAt, sentAt);
  assert.ok((resumed?.latencyMs ?? 0) >= 120_000);

  // a fresh request that replaces a failed one is timed from when it is sent,
  // whether it is still running when created or finishes right away
  for (const announce of [true, false]) {
    await writeFile(file, `${JSON.stringify({ ...first, startedAt: sentAt })}\n`);
    await run(one, answeredBy("resp_10", announce), options);
    const fresh = (await readRecords(file)).at(-1);
    assert.notEqual(fresh?.startedAt, sentAt);
    assert.ok((fresh?.latencyMs ?? Infinity) < 50);
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

test("stops before sending anything if a task changes while the run is starting", async () => {
  const setup = await fixture();
  // edited on disk after the tasks were loaded but before they are copied
  const file = path.join(path.dirname(setup.dir), "..", "tasks", "stack/one.json");
  await writeFile(file, JSON.stringify({ ...solvable, reference: unsolvable.reference }));
  const { call, calls } = fakeModels();
  await assert.rejects(run(setup, call), /stack\/one changed while the run was starting/);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(path.join(setup.dir, "run.json")), false);

  // starting again from the edited files works and copies exactly the selected tasks
  const reloaded = { ...setup, tasks: await loadTasks(path.dirname(file).replace(/stack$/, "")) };
  const one = { ...reloaded, tasks: reloaded.tasks.filter((task) => task.id === "stack/one") };
  await run(one, call);
  const copied = await loadTasks(path.join(setup.dir, "tasks"));
  assert.deepEqual(
    copied.map((task) => [task.id, task.reference.status]),
    [["stack/one", "impossible"]],
  );
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
