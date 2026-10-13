import type { TaskFile } from "./build.ts";
import { byId, cellKey, element, message, request } from "./dom.ts";
import type { Cell } from "./pick.ts";
import type { Layer, Scene } from "./scene.ts";

type Answer = { status: "solved"; blocks: Cell[] } | { status: "impossible"; reason: string };

type RunTask = Required<
  Pick<TaskFile, "prompt" | "size" | "initial" | "images" | "reference" | "alternatives">
> & {
  id: string;
};

// the latest record of one attempt, with its reply parsed when it could be
type Attempt = {
  task: string;
  model: string;
  attempt: number;
  status: "graded" | "started" | "error";
  latencyMs: number;
  pass?: boolean;
  failures?: { code: string; message: string }[];
  text?: string;
  refusal?: string | null;
  error?: string;
  answer: Answer | null;
};

type Run = { tasks: RunTask[]; attempts: Attempt[] };

// the blocks two structures share and where they differ
function compare(target: Cell[], answer: Cell[]) {
  const wanted = new Set(target.map(cellKey));
  const given = new Set(answer.map(cellKey));
  return {
    common: answer.filter((cell) => wanted.has(cellKey(cell))),
    missing: target.filter((cell) => !given.has(cellKey(cell))),
    extra: answer.filter((cell) => !wanted.has(cellKey(cell))),
  };
}

// an answer drawn over whichever accepted structure it is closest to, as the grader reports it
function layersFor(task: RunTask, attempt: Attempt): Layer[] {
  const answer = attempt.answer?.status === "solved" ? attempt.answer.blocks : null;
  // with no structure to grade, only the starting blocks are shown, faintly, as context
  if (task.reference.status === "impossible") {
    return answer
      ? [{ blocks: answer, style: "extra" }]
      : [{ blocks: task.initial, style: "faint" }];
  }
  const accepted = [task.reference.blocks, ...task.alternatives];
  // no structure at all, so every block of the answer key is missing
  if (!answer) return [{ blocks: task.reference.blocks, style: "missing" }];
  const [closest] = accepted
    .map((target) => compare(target, answer))
    .sort((a, b) => a.missing.length + a.extra.length - (b.missing.length + b.extra.length));
  if (!closest) return [];
  return [
    { blocks: closest.common, style: "solid" },
    { blocks: closest.missing, style: "missing" },
    { blocks: closest.extra, style: "extra" },
  ];
}

function outcome(attempt: Attempt): { label: string; kind: string } {
  if (attempt.status === "error") return { label: "Error", kind: "error" };
  if (attempt.status === "started") return { label: "Unfinished", kind: "error" };
  return attempt.pass ? { label: "Pass", kind: "pass" } : { label: "Fail", kind: "fail" };
}

export function createResults(scene: Scene) {
  const runs = byId<HTMLSelectElement>("run-list");
  const failedOnly = byId<HTMLInputElement>("failed-only");
  const detail = byId("detail");
  let run: Run | null = null;
  let selected: Attempt | null = null;

  const note = (text: string) => detail.replaceChildren(element("p", { className: "empty" }, text));

  function renderList() {
    if (!run) return;
    const attempts = run.attempts
      .filter((attempt) => !failedOnly.checked || outcome(attempt).kind !== "pass")
      .sort(
        (a, b) =>
          a.task.localeCompare(b.task) || a.model.localeCompare(b.model) || a.attempt - b.attempt,
      );
    const items = attempts.map((attempt) => {
      const { label, kind } = outcome(attempt);
      return element(
        "li",
        {},
        element(
          "button",
          {
            type: "button",
            ariaCurrent: String(attempt === selected),
            onclick: () => select(attempt),
          },
          element("span", {}, attempt.task),
          element("span", { className: `outcome ${kind}` }, label),
          element("span", { className: "who" }, `${attempt.model}, attempt ${attempt.attempt}`),
        ),
      );
    });
    byId("attempts").replaceChildren(...items);
    if (attempts.length === 0)
      note(failedOnly.checked ? "Every attempt passed." : "This run has no attempts yet.");
  }

  function select(attempt: Attempt) {
    if (!run) return;
    selected = attempt;
    renderList();
    const task = run.tasks.find((candidate) => candidate.id === attempt.task);
    if (!task) return note(`${attempt.task} is not in this run's copy of the tasks.`);
    scene.setGrid(task.size);
    scene.show(layersFor(task, attempt));

    const parts: Node[] = [
      element("h2", {}, task.id),
      element("p", {}, task.prompt),
      element(
        "p",
        {},
        `${attempt.model}, attempt ${attempt.attempt}: ${outcome(attempt).label.toLowerCase()}`,
        attempt.latencyMs ? ` in ${(attempt.latencyMs / 1000).toFixed(1)} s` : "",
      ),
    ];
    if (task.images.length > 0) {
      parts.push(
        element(
          "ul",
          { className: "images" },
          ...task.images.map((src) =>
            element(
              "li",
              {},
              element("a", { href: src, target: "_blank" }, element("img", { src, alt: "" })),
            ),
          ),
        ),
      );
    }
    if (task.reference.status === "impossible") {
      parts.push(element("p", {}, `The task is impossible: ${task.reference.reason}`));
    }
    if (attempt.answer?.status === "impossible") {
      parts.push(element("p", {}, `The model answered impossible: ${attempt.answer.reason}`));
    }
    if (attempt.failures && attempt.failures.length > 0) {
      parts.push(
        element(
          "ul",
          {},
          ...attempt.failures.map((failure) =>
            element("li", {}, element("code", {}, failure.code), " ", failure.message),
          ),
        ),
      );
    }
    if (attempt.refusal) parts.push(element("p", {}, `Refusal: ${attempt.refusal}`));
    if (attempt.error) parts.push(element("pre", {}, attempt.error));
    if (attempt.text !== undefined) {
      parts.push(
        element("details", {}, element("summary", {}, "Reply"), element("pre", {}, attempt.text)),
      );
    }
    detail.replaceChildren(...parts);
  }

  // bumped on every run opened, so only the latest one fills the page
  let loading = 0;
  // the scene is shared with Build, so a late answer only draws while Results is the open tab
  const current = (mine: number) => mine === loading && !byId("results").hidden;

  // reloaded each time, since a run that is still going keeps adding attempts
  async function openRun(name: string, keep: Attempt | null = null) {
    const mine = ++loading;
    selected = null;
    try {
      const loaded = (await (await request(`/api/runs/${encodeURIComponent(name)}`)).json()) as Run;
      if (!current(mine)) return;
      run = loaded;
      // the same attempt as before if it is still there, in its newest state
      const same = keep
        ? run.attempts.find(
            (attempt) =>
              attempt.task === keep.task &&
              attempt.model === keep.model &&
              attempt.attempt === keep.attempt,
          )
        : undefined;
      if (same) return select(same);
      renderList();
      const first = byId("attempts").querySelector("button");
      if (first) first.click();
      else scene.show([]);
    } catch (error) {
      if (!current(mine)) return;
      run = null;
      byId("attempts").replaceChildren();
      note(`Could not open ${name}: ${message(error)}`);
    }
  }

  runs.addEventListener("change", () => void openRun(runs.value));
  // the shown attempt must stay in the list, otherwise the first one left is shown, or nothing
  failedOnly.addEventListener("change", () => {
    renderList();
    const list = byId("attempts");
    if (list.querySelector('[aria-current="true"]')) return;
    const first = list.querySelector("button");
    if (first) return first.click();
    selected = null;
    scene.show([]);
  });

  return {
    async activate() {
      scene.edit(null);
      const mine = ++loading;
      try {
        const names = (await (await request("/api/runs")).json()) as string[];
        if (!current(mine)) return;
        const keep = names.includes(runs.value) ? runs.value : names.at(-1);
        // the attempt on screen stays selected when its run is reloaded
        const reopened = keep === runs.value ? selected : null;
        runs.replaceChildren(...names.map((name) => element("option", { value: name }, name)));
        if (!keep) {
          scene.show([]);
          byId("attempts").replaceChildren();
          return note("No runs yet. Results appear here after pnpm bench.");
        }
        runs.value = keep;
        await openRun(keep, reopened);
      } catch (error) {
        if (current(mine)) note(message(error));
      }
    },
  };
}
