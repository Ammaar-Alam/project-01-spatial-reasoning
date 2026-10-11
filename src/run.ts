import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { checkTasks } from "./check-tasks.ts";
import { type Failure, type Grade, grade } from "./grade.ts";
import { loadModels, type ModelConfig } from "./models.ts";
import { buildRequest, type ModelRequest, SYSTEM_PROMPT } from "./prompt.ts";
import { API_KEYS, callModel, type ModelReply, type Resume } from "./providers.ts";
import { loadTasks, TASKS_DIR, type Task } from "./task.ts";

export type Call = (
  config: ModelConfig,
  request: ModelRequest,
  resume: Resume,
) => Promise<ModelReply>;

// one line of records.jsonl, appended as soon as something happens to an attempt
export type RunRecord = {
  task: string;
  family: string;
  parent: string;
  model: string;
  attempt: number;
  startedAt: string;
  latencyMs: number;
} & (
  | ({ status: "graded"; pass: boolean; failures: Failure[] } & ModelReply)
  // the provider accepted a background request, the next run keeps polling this id
  | { status: "started"; responseId: string }
  // the call failed and nothing was graded, responseId is set if a background request exists
  | { status: "error"; error: string; responseId?: string }
);

// everything that must stay fixed for a run to be resumed
type Settings = {
  attempts: number;
  system: string;
  models: Record<string, ModelConfig>;
  // sha256 of what each task sends to a model plus its answer key
  tasks: Record<string, string>;
  // sha256 of the source and locked dependencies that build requests, call models and grade
  code: string;
};

export type RunOptions = {
  dir: string;
  tasks: Task[];
  models: Record<string, ModelConfig>;
  attempts: number;
  concurrency: number;
  call: Call;
  log?: (line: string) => void;
};

export async function runEval(options: RunOptions): Promise<RunRecord[]> {
  const { dir, tasks, models, attempts, concurrency, call, log = () => {} } = options;
  const prepared = await Promise.all(
    tasks.map(async (task) => ({ task, request: await buildRequest(task) })),
  );

  const settings: Settings = {
    attempts,
    system: SYSTEM_PROMPT,
    models,
    tasks: Object.fromEntries(
      prepared.map(({ task, request }) => [task.id, fingerprint(task, request)]),
    ),
    code: await codeVersion(),
  };
  await openRun(dir, settings, tasks);

  // a graded attempt is final, anything else is tried again, picking up a saved response id
  const recordsFile = path.join(dir, "records.jsonl");
  await setAsideCutOffRecord(recordsFile);
  const latest = latestRecords(await readRecords(recordsFile));
  const jobs = Array.from({ length: attempts }, (_, i) => i + 1).flatMap((attempt) =>
    prepared.flatMap(({ task, request }) =>
      Object.entries(models).flatMap(([model, config]) => {
        const last = latest.get(key(task.id, model, attempt));
        if (last?.status === "graded") return [];
        const saved =
          last && "responseId" in last && last.responseId
            ? { responseId: last.responseId, startedAt: last.startedAt }
            : undefined;
        return [{ task, request, model, config, attempt, saved }];
      }),
    ),
  );

  const save = (record: RunRecord) => appendFileSync(recordsFile, `${JSON.stringify(record)}\n`);
  const records: RunRecord[] = [];
  let next = 0;
  const worker = async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      const { task, request, model, config, attempt, saved } = job;
      const callStart = Date.now();
      // a resumed response is timed from when it was first sent
      let since = saved ? Date.parse(saved.startedAt) : callStart;
      const base = () => ({
        task: task.id,
        family: task.family,
        parent: task.parent,
        model,
        attempt,
        startedAt: new Date(since).toISOString(),
      });

      let responseId = saved?.responseId;
      const started = (id: string) => {
        // a new id means a fresh request replaced the saved one, so its clock starts now
        if (id !== saved?.responseId) since = callStart;
        responseId = id;
        save({ ...base(), latencyMs: Date.now() - since, status: "started", responseId: id });
      };

      // a failed call is saved as an error, a bug in grading stops the run instead
      let reply: ModelReply | undefined;
      let error = "";
      try {
        reply = await call(config, request, { responseId, started });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      // an answer from a different response than the saved one came from a fresh request
      if (reply && saved && reply.responseId !== saved.responseId) since = callStart;
      const latencyMs = Date.now() - since;
      const record: RunRecord = reply
        ? { ...base(), latencyMs, status: "graded", ...reply, ...score(task, reply) }
        : { ...base(), latencyMs, status: "error", error, ...(responseId ? { responseId } : {}) };

      save(record);
      records.push(record);
      const outcome = record.status === "graded" ? (record.pass ? "pass" : "fail") : "error";
      log(`[${records.length}/${jobs.length}] ${model} ${task.id} #${attempt} ${outcome}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return records;
}

// creates run.json, or confirms an existing run was started with the same settings
async function openRun(dir: string, settings: Settings, tasks: Task[]): Promise<void> {
  const file = path.join(dir, "run.json");
  if (existsSync(file)) {
    const saved = JSON.parse(await readFile(file, "utf8"));
    const changed = (Object.keys(settings) as (keyof Settings)[]).filter(
      (field) => !isDeepStrictEqual(saved[field], settings[field]),
    );
    if (changed.length > 0) {
      throw new Error(
        `${dir} was started with different ${changed.join(", ")}. Use a new run name to change settings.`,
      );
    }
    return;
  }
  await mkdir(dir, { recursive: true });
  // copies of the task files and images as run, so later edits never lose the inputs or answer keys
  for (const task of tasks) {
    const folder = path.join(dir, "tasks", task.family);
    for (const source of [task.file, ...task.images]) {
      const target = path.join(folder, path.relative(path.dirname(task.file), source));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
  const run = { ...settings, createdAt: new Date().toISOString(), commit: commit() };
  await writeFile(file, `${JSON.stringify(run, null, 2)}\n`);
}

// a refusal fails even when its text happens to parse as a correct answer
function score(task: Task, reply: ModelReply): Grade {
  if (reply.refusal)
    return { pass: false, failures: [{ code: "refused", message: reply.refusal }] };
  return grade(task, reply.text);
}

// a crash mid-write can leave the last line cut off, it moves to records.jsonl.partial so
// the complete records stay readable and the next one starts on its own line
async function setAsideCutOffRecord(file: string): Promise<void> {
  if (!existsSync(file)) return;
  const data = await readFile(file);
  const end = data.lastIndexOf("\n") + 1;
  if (end === data.length) return;
  await appendFile(`${file}.partial`, data.subarray(end));
  await truncate(file, end);
}

export async function readRecords(file: string): Promise<RunRecord[]> {
  if (!existsSync(file)) return [];
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as RunRecord);
}

// the newest line for each task, model and attempt
const latestRecords = (records: RunRecord[]) =>
  new Map(records.map((record) => [key(record.task, record.model, record.attempt), record]));

// one line per model from the latest record of every attempt
export function summarize(records: RunRecord[], models: string[]): string[] {
  const latest = [...latestRecords(records).values()];
  return models.map((model) => {
    const mine = latest.filter((record) => record.model === model);
    const passed = mine.filter((record) => record.status === "graded" && record.pass).length;
    const graded = mine.filter((record) => record.status === "graded").length;
    const unfinished = mine.length - graded;
    return `${model}: ${passed}/${graded} passed${unfinished > 0 ? `, ${unfinished} unfinished, run again to finish them` : ""}`;
  });
}

// "transform" selects a family, "transform/mirror-l-01" selects one task
export function selectTasks(tasks: Task[], filter?: string): Task[] {
  if (tasks.length === 0) throw new Error("no tasks found in tasks/");
  if (!filter) return tasks;
  const wanted = filter.split(",");
  for (const name of wanted) {
    if (!tasks.some((task) => task.id === name || task.family === name)) {
      throw new Error(`no task or family named ${name}`);
    }
  }
  return tasks.filter((task) => wanted.includes(task.id) || wanted.includes(task.family));
}

const key = (task: string, model: string, attempt: number) =>
  `${task}\u0000${model}\u0000${attempt}`;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// every task field except local file paths, plus exactly what the model receives
const fingerprint = ({ file: _file, images: _images, ...fields }: Task, request: ModelRequest) =>
  hash({ fields, request });

async function codeVersion(): Promise<string> {
  const root = path.resolve(import.meta.dirname, "..");
  const files = (await readdir(path.join(root, "src"), { recursive: true }))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => path.join("src", file));
  const sources = [...files, "pnpm-lock.yaml"].sort();
  return hash(
    await Promise.all(
      sources.map(async (file) => [file, await readFile(path.join(root, file), "utf8")]),
    ),
  );
}

function commit(): { sha: string; dirty: boolean } | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return null;
  }
}

const RESULTS_DIR = path.resolve(import.meta.dirname, "../results");
const ENV_FILE = path.resolve(import.meta.dirname, "../.env");
const RUN_NAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function count(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${flag} must be a whole number of at least 1`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      models: { type: "string" },
      tasks: { type: "string" },
      attempts: { type: "string", default: "1" },
      concurrency: { type: "string", default: "4" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const { problems } = await checkTasks(TASKS_DIR);
  if (problems.length > 0) {
    throw new Error(`fix these tasks first (pnpm tasks:check):\n\n${problems.join("\n\n")}`);
  }
  const tasks = selectTasks(await loadTasks(TASKS_DIR), values.tasks);

  if (values["dry-run"]) {
    console.log(SYSTEM_PROMPT);
    for (const task of tasks) {
      const { text, images } = await buildRequest(task);
      const attached = images.length > 0 ? ` (${images.length} images attached)` : "";
      console.log(`\n--- ${task.id}${attached} ---\n${text}`);
    }
    return;
  }

  if (!values.name || !RUN_NAME.test(values.name)) {
    throw new Error("--name is required, using lowercase letters, digits, dots and hyphens");
  }
  if (!values.models) throw new Error("--models is required, as names from models.json");
  const attempts = count(values.attempts, "--attempts");
  const concurrency = count(values.concurrency, "--concurrency");
  const catalog = await loadModels();
  const models: Record<string, ModelConfig> = {};
  for (const name of values.models.split(",")) {
    const config = catalog[name];
    if (!config) {
      throw new Error(`models.json has no ${name}, choose from ${Object.keys(catalog).join(", ")}`);
    }
    models[name] = config;
  }
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const needed = [...new Set(Object.values(models).map((config) => API_KEYS[config.provider]))];
  const unset = needed.filter((variable) => !process.env[variable]);
  if (unset.length > 0) throw new Error(`set ${unset.join(", ")} in .env`);

  const dir = path.join(RESULTS_DIR, values.name);
  await runEval({ dir, tasks, models, attempts, concurrency, call: callModel, log: console.log });
  const records = await readRecords(path.join(dir, "records.jsonl"));
  console.log(`\n${summarize(records, Object.keys(models)).join("\n")}`);
  console.log(`saved to ${path.relative(process.cwd(), dir)}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
