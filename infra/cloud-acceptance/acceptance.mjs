// Bounded CPU and loopback acceptance. No model API or archived code is executed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    fixtures: { type: "string" },
    output: { type: "string" },
    playwright: { type: "string" },
    chromium: { type: "string", default: "/usr/bin/chromium" },
  },
});
for (const required of ["source", "fixtures", "output"]) {
  assert(values[required], `--${required} is required`);
}
const source = path.resolve(values.source);
const fixtures = path.resolve(values.fixtures);
const output = path.resolve(values.output);
await mkdir(output, { recursive: false });
const moduleAt = (name) => import(pathToFileURL(path.join(source, "src", name)).href);
const { checkTasks } = await moduleAt("check-tasks.ts");
const { loadTasks } = await moduleAt("task.ts");
const { buildRequest } = await moduleAt("prompt.ts");
const { editorHandler, listen } = await moduleAt("editor.ts");

const checks = [];
const record = (name, status, evidence) => {
  const item = { name, status, timestamp_utc: new Date().toISOString(), evidence };
  checks.push(item);
  console.log(JSON.stringify(item));
};
async function hashes(root) {
  const names = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        path.relative(root, name),
        createHash("sha256")
          .update(await readFile(name))
          .digest("hex"),
      ]),
    ),
  );
}
const before = await hashes(fixtures);
const result = await checkTasks(fixtures);
assert.deepEqual(result, { checked: 14, problems: [] });
record("fixture schema and reference compatibility", "PASS", result);
const tasks = await loadTasks(fixtures);
let images = 0;
for (const task of tasks) {
  const request = await buildRequest(task);
  images += request.images.length;
  const altered = await buildRequest({
    ...task,
    id: "acceptance-sentinel",
    parent: "acceptance-sentinel",
    reference: { status: "impossible", reason: "acceptance-sentinel" },
    alternatives: [],
  });
  assert.deepEqual(request, altered);
  assert.equal(request.images.length, task.images.length);
}
assert.equal(images, 8);
record("CPU request construction", "PASS", {
  requests: 14,
  image_parts: images,
  structural_answer_exclusion: true,
  model_calls: 0,
  semantic_answer_and_image_audit: "Outside infrastructure acceptance scope",
});

const previewTasks = path.join(output, "preview-tasks");
await cp(fixtures, previewTasks, { recursive: true, force: false, errorOnExist: true });
const server = listen(
  editorHandler({ tasks: previewTasks, results: path.join(output, "results") }),
  0,
);
await once(server, "listening");
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
try {
  const routes = {};
  for (const route of [
    "/",
    "/api/tasks",
    "/web/main.ts",
    "/web/build.ts",
    "/web/scene.ts",
    "/three/build/three.module.js",
  ]) {
    routes[route] = (await fetch(base + route)).status;
    assert.equal(routes[route], 200);
  }
  assert.equal((await (await fetch(`${base}/api/tasks`)).json()).length, 14);
  for (const task of tasks) {
    for (const image of task.images) {
      const imagePath = path
        .relative(fixtures, image)
        .split(path.sep)
        .map(encodeURIComponent)
        .join("/");
      assert.equal((await fetch(`${base}/tasks/${imagePath}`)).status, 200);
    }
  }
  record("native creator HTTP preview", "PASS", {
    loopback: true,
    routes,
    fixtures: 14,
    images: 8,
  });
  const roundtrip = editorHandler({
    tasks: path.join(output, "roundtrip"),
    results: path.join(output, "results"),
  });
  const id = "transform/case-001";
  const original = JSON.parse(await readFile(path.join(fixtures, `${id}.json`), "utf8"));
  const url = `http://127.0.0.1/api/tasks/${id}`;
  const save = () =>
    roundtrip(
      new Request(url, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-none-match": "*" },
        body: JSON.stringify(original),
      }),
    );
  assert.equal((await save()).status, 200);
  assert.deepEqual(await (await roundtrip(new Request(url))).json(), original);
  assert.equal((await save()).status, 409);
  record("existing fixture save and reload", "PASS", {
    fixture: id,
    separate_directory: true,
    save_status: 200,
    collision_status: 409,
    unchanged_content: true,
  });
  if (values.playwright) {
    let browser;
    try {
      const { chromium } = await import(pathToFileURL(path.resolve(values.playwright)).href);
      browser = await chromium.launch({
        executablePath: values.chromium,
        headless: true,
        chromiumSandbox: true,
        ignoreDefaultArgs: ["--unsafely-disable-devtools-self-xss-warnings"],
        env: {
          PATH: process.env.PATH,
          XDG_CONFIG_HOME: path.join(output, "browser-config"),
          XDG_CACHE_HOME: path.join(output, "browser-cache"),
        },
        timeout: 15000,
      });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        const host = new URL(route.request().url()).hostname;
        return host === "127.0.0.1" ? route.continue() : route.abort();
      });
      await page.goto(base, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForFunction(
        () => document.querySelectorAll("#task-list option").length === 15,
      );
      await page.selectOption("#task-list", "transform/case-001");
      await page.waitForFunction(() => document.querySelector("#prompt").value.length > 0);
      await page.click("#save");
      await page.waitForFunction(() =>
        document
          .querySelector("#status")
          .textContent.includes("Saved tasks/transform/case-001.json"),
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.selectOption("#task-list", "transform/case-001");
      await page.waitForFunction(() => document.querySelector("#prompt").value.length > 0);
      const state = await page.evaluate(() => ({
        title: document.title,
        taskOptions: document.querySelectorAll("#task-list option").length,
        prompt: document.querySelector("#prompt").value,
        layers: [...document.querySelectorAll("#layers button")].map((b) => b.textContent),
        canvas: {
          width: document.querySelector("canvas").width,
          height: document.querySelector("canvas").height,
        },
      }));
      assert.equal(state.prompt, original.prompt);
      assert(state.canvas.width > 0 && state.canvas.height > 0);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(output, "internal-preview.png") });
      record("sandboxed cloud browser preview and save", "PASS", {
        ...state,
        runtimeErrors: errors,
      });
    } catch (error) {
      const diagnostic = stripVTControlCharacters(error.message)
        .split("\n")
        .filter((line) => /FATAL:|crashpad_handler:/.test(line))
        .slice(0, 3)
        .join("\n");
      record("sandboxed cloud browser preview and save", "FAIL", {
        reason: diagnostic || error.message.slice(0, 600),
        security_relaxation_attempted: false,
      });
    } finally {
      await browser?.close();
    }
  } else {
    record("sandboxed cloud browser preview and save", "UNKNOWN", "No browser adapter supplied");
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
assert.deepEqual(await hashes(fixtures), before);
record("fixture input preservation", "PASS", { input_files: Object.keys(before).length });
const smallResult = {
  completed_at_utc: new Date().toISOString(),
  checks,
  fixture_hashes: before,
  model_calls: 0,
  research_experiments: 0,
};
await writeFile(path.join(output, "result.json"), `${JSON.stringify(smallResult, null, 2)}\n`);
console.log(`Saved resumable result: ${path.join(output, "result.json")}`);
process.exitCode = checks.some((item) => item.status === "FAIL") ? 1 : 0;
