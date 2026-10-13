import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseAnswer } from "./answer.ts";
import { checkTask } from "./check-tasks.ts";
import { latestRecords, RESULTS_DIR, RUN_NAME, readRecords } from "./run.ts";
import {
  findTaskFiles,
  IMAGE_TYPES,
  loadTasks,
  NAME,
  parseTask,
  TASKS_DIR,
  TaskError,
} from "./task.ts";

export type Handler = (request: Request) => Promise<Response>;

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const THREE_DIR = path.join(ROOT, "node_modules/three");
const BIOME = path.join(ROOT, "node_modules/.bin/biome");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ...IMAGE_TYPES,
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const notFound = () => new HttpError(404, "not found");

export function editorHandler(dirs: { tasks: string; results: string }): Handler {
  return async (request) => {
    try {
      return await route(request, dirs);
    } catch (error) {
      if (error instanceof HttpError) return new Response(error.message, { status: error.status });
      if (error instanceof TaskError) return new Response(error.message, { status: 400 });
      console.error(error);
      return new Response("the editor failed, see its terminal", { status: 500 });
    }
  };
}

async function route(request: Request, dirs: { tasks: string; results: string }) {
  const url = new URL(request.url);
  // a page on another site that resolves its own name to this machine is still another site
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new HttpError(403, "open the editor at 127.0.0.1");
  }
  const get = request.method === "GET";
  const put = request.method === "PUT";
  if (get && url.pathname === "/") return serve(WEB_DIR, ["index.html"]);

  const [area, ...rest] = segments(url.pathname);
  const [kind, first, second, ...more] = rest;
  if (get && area === "web") return serve(WEB_DIR, rest);
  if (get && area === "three") return serve(THREE_DIR, rest);
  if (get && area === "tasks") return serveImage(dirs.tasks, rest);
  if (get && area === "results" && kind && RUN_NAME.test(kind) && first === "tasks") {
    return serveImage(path.join(dirs.results, kind, "tasks"), [second, ...more]);
  }
  if (area !== "api" || more.length > 0) throw notFound();

  if (kind === "tasks" && first === undefined && get)
    return Response.json(await taskIds(dirs.tasks));
  if (kind === "tasks" && first && second && get) return getTask(dirs.tasks, first, second);
  if (kind === "tasks" && first && second && put)
    return saveTask(request, dirs.tasks, first, second);
  if (kind === "images" && first && second && put)
    return saveImage(request, dirs.tasks, first, second);
  if (kind === "runs" && first === undefined && get)
    return Response.json(await runNames(dirs.results));
  if (kind === "runs" && first && second === undefined && get) return getRun(dirs.results, first);
  throw notFound();
}

// decoded path segments, none of which can step out of the folder it is joined to
function segments(pathname: string): string[] {
  const parts = pathname.split("/").slice(1);
  return parts.map((part) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new HttpError(400, "bad path");
    }
    if (decoded === "" || decoded === "." || decoded === ".." || /[\\/\0]/.test(decoded)) {
      throw notFound();
    }
    return decoded;
  });
}

async function serve(root: string, parts: (string | undefined)[]): Promise<Response> {
  const file = path.join(root, ...parts.filter((part) => part !== undefined));
  const type = TYPES[path.extname(file)];
  if (!type || parts.length === 0) throw notFound();
  const body = await readFile(file).catch(() => {
    throw notFound();
  });
  // the page is written in TypeScript and the browser gets it with the types removed
  const code = file.endsWith(".ts") ? stripTypeScriptTypes(body.toString("utf8")) : body;
  return new Response(code, { headers: { "content-type": type, "cache-control": "no-store" } });
}

// only images, so the answer keys next to them are read through the api
function serveImage(root: string, parts: (string | undefined)[]): Promise<Response> {
  const name = parts.at(-1) ?? "";
  if (!Object.hasOwn(IMAGE_TYPES, path.extname(name).toLowerCase())) throw notFound();
  return serve(root, parts);
}

async function taskIds(root: string): Promise<string[]> {
  const files = await findTaskFiles(root);
  const ids = files.map((file) => path.relative(root, file).replace(/\.json$/, ""));
  return ids
    .filter((id) => id.split(path.sep).length === 2)
    .map((id) => id.split(path.sep).join("/"));
}

function taskFile(root: string, family: string, name: string): string {
  if (!NAME.test(family) || !NAME.test(name)) {
    throw new HttpError(400, "use lowercase letters, digits and hyphens in names");
  }
  return path.join(root, family, `${name}.json`);
}

async function getTask(root: string, family: string, name: string): Promise<Response> {
  const text = await readFile(taskFile(root, family, name), "utf8").catch(() => {
    throw notFound();
  });
  return new Response(text, { headers: { "content-type": "application/json" } });
}

// saved only if pnpm tasks:check would accept it, written whole so a crash leaves the old file
async function saveTask(request: Request, root: string, family: string, name: string) {
  const file = taskFile(root, family, name);
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw new HttpError(400, "the task is not JSON");
  }
  const problems = checkTask(await parseTask(root, file, json));
  if (problems.length > 0) throw new HttpError(400, problems.join("\n\n"));
  if (request.headers.get("if-none-match") === "*" && existsSync(file)) {
    throw new HttpError(409, `${family}/${name} already exists`);
  }
  // formatted by the repo's own Biome so saved tasks pass pnpm lint unchanged
  const formatted = execFileSync(
    BIOME,
    ["format", `--stdin-file-path=tasks/${family}/${name}.json`],
    {
      cwd: ROOT,
      input: JSON.stringify(json),
    },
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, formatted);
  await rename(`${file}.tmp`, file);
  return Response.json({ id: `${family}/${name}` });
}

async function saveImage(request: Request, root: string, family: string, name: string) {
  if (!NAME.test(family) || !name.endsWith(".png") || !NAME.test(name.slice(0, -4))) {
    throw new HttpError(400, "snapshots are saved as tasks/<family>/<name>.png");
  }
  const data = Buffer.from(await request.arrayBuffer());
  if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new HttpError(400, "a snapshot must be a PNG");
  }
  await mkdir(path.join(root, family), { recursive: true });
  await writeFile(path.join(root, family, name), data);
  return Response.json({ image: name });
}

async function runNames(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && RUN_NAME.test(entry.name))
    .filter((entry) => existsSync(path.join(root, entry.name, "run.json")))
    .map((entry) => entry.name)
    .sort();
}

// the run's own copy of its tasks and the latest record of every attempt
async function getRun(root: string, name: string): Promise<Response> {
  const dir = path.join(root, name);
  if (!RUN_NAME.test(name) || !existsSync(path.join(dir, "run.json"))) throw notFound();
  const snapshot = path.join(dir, "tasks");
  const tasks = (await loadTasks(snapshot)).map(({ file: _, images, ...task }) => ({
    ...task,
    images: images.map(
      (image) =>
        `/results/${name}/tasks/${path.relative(snapshot, image).split(path.sep).join("/")}`,
    ),
  }));
  const records = latestRecords(await readRecords(path.join(dir, "records.jsonl")));
  const attempts = [...records.values()].map((record) => {
    const parsed = record.status === "graded" ? parseAnswer(record.text) : null;
    return { ...record, answer: parsed?.ok ? parsed.answer : null };
  });
  return Response.json({ tasks, attempts });
}

// connects the handler to node's server, reading each body whole since tasks and snapshots are small
export function listen(handler: Handler, port: number): Server {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = Object.entries(req.headers).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value] as [string, string]] : [],
    );
    let response: Response;
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "unknown"}`);
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      response = await handler(new Request(url, { method: req.method, headers, body }));
    } catch {
      response = new Response("bad request", { status: 400 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return server.listen(port, "127.0.0.1");
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "4173" } } });
  const port = Number(values.port);
  listen(editorHandler({ tasks: TASKS_DIR, results: RESULTS_DIR }), port).on("listening", () => {
    console.log(`editor running at http://127.0.0.1:${port}`);
  });
}
