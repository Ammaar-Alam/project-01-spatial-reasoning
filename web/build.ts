import { byId, cellKey, element, message, request } from "./dom.ts";
import type { Cell } from "./pick.ts";
import type { Layer, Scene, View } from "./scene.ts";

const RULES = ["maxEdits", "exactEdits", "maxBlocks", "exactBlocks"] as const;

// a task file as stored in tasks/, every field the schema allows
export type TaskFile = {
  prompt: string;
  parent?: string;
  size: Cell;
  initial?: Cell[];
  images?: string[];
  constraints?: Partial<Record<(typeof RULES)[number], number>> & {
    protected?: Cell[];
    only?: "add" | "remove";
  };
  reference: { status: "solved"; blocks: Cell[] } | { status: "impossible"; reason: string };
  alternatives?: Cell[][];
};

const BLANK: TaskFile = {
  prompt: "",
  size: { x: 8, y: 6, z: 8 },
  reference: { status: "solved", blocks: [] },
};

type Active = "initial" | "answer" | "protected" | number;

export function createBuild(scene: Scene) {
  const field = <T extends HTMLElement = HTMLInputElement>(id: string) => byId<T>(id);
  const list = field<HTMLSelectElement>("task-list");
  const status = field<HTMLPreElement>("status");
  const reason = field<HTMLTextAreaElement>("reason");

  // the task being edited, null until it is saved for the first time
  let id: string | null = null;
  let layers = {
    initial: [] as Cell[],
    answer: [] as Cell[],
    protected: [] as Cell[],
    alternatives: [] as Cell[][],
  };
  let active: Active = "initial";
  let images: string[] = [];
  let dirty = false;
  // bumped on every edit, so a save only clears dirty if nothing changed while it was in flight
  let revision = 0;
  // bumped on every task opened, so a late load or snapshot never lands in another task
  let opened = 0;

  // the scene is shared with Results, so a late load only draws while Build is the open tab
  const showing = () => !byId("build").hidden;
  const current = (): Cell[] =>
    typeof active === "number" ? (layers.alternatives[active] ?? []) : layers[active];
  const impossible = () =>
    document.querySelector<HTMLInputElement>('input[name="status"]:checked')?.value ===
    "impossible";

  function say(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }

  function touch() {
    dirty = true;
    revision += 1;
    say("Unsaved changes");
  }

  function size(): Cell {
    const axis = (name: string) =>
      Math.max(1, Math.floor(Number(field(`size-${name}`).value) || 1));
    return { x: axis("x"), y: axis("y"), z: axis("z") };
  }

  function draw() {
    const shown = new Set(current().map(cellKey));
    const start = layers.initial.filter((cell) => !shown.has(cellKey(cell)));
    const drawn: Layer[] = [
      { blocks: active === "initial" ? [] : start, style: "faint" },
      { blocks: current(), style: active === "protected" ? "protected" : "solid" },
    ];
    scene.show(drawn);
    renderLayers();
  }

  function renderLayers() {
    const tab = (label: string, which: Active, cells: Cell[]) =>
      element(
        "button",
        {
          type: "button",
          ariaPressed: String(which === active),
          onclick: () => {
            active = which;
            draw();
          },
        },
        label,
        element("span", { className: "count" }, String(cells.length)),
      );
    const buttons = [
      tab("Start", "initial", layers.initial),
      tab("Answer", "answer", layers.answer),
      tab("Protected", "protected", layers.protected),
      ...layers.alternatives.map((cells, i) => tab(`Alternative ${i + 1}`, i, cells)),
    ];
    const action = (label: string, run: () => void) =>
      element("button", { type: "button", className: "action", onclick: run }, label);
    const actions = [
      action("Add alternative", () => {
        layers.alternatives.push([...layers.answer]);
        active = layers.alternatives.length - 1;
        touch();
        draw();
      }),
    ];
    if (active === "answer" || typeof active === "number") {
      actions.push(
        action("Copy start here", () => {
          current().splice(0, Infinity, ...layers.initial);
          touch();
          draw();
        }),
      );
    }
    if (typeof active === "number") {
      const index = active;
      actions.push(
        action("Delete alternative", () => {
          layers.alternatives.splice(index, 1);
          active = "answer";
          touch();
          draw();
        }),
      );
    }
    byId("layers").replaceChildren(...buttons, ...actions);
  }

  function renderImages() {
    const family = encodeURIComponent(familyAndName()?.family ?? "");
    // each part encoded so a # or ? in a file name stays part of the name
    const url = (image: string) =>
      `/tasks/${family}/${image.split("/").map(encodeURIComponent).join("/")}`;
    const items = images.map((image) =>
      element(
        "li",
        {},
        element(
          "figure",
          {},
          element(
            "a",
            { href: url(image), target: "_blank" },
            element("img", { src: `${url(image)}?v=${Date.now()}`, alt: image }),
          ),
          element("figcaption", {}, image),
        ),
        element(
          "button",
          {
            type: "button",
            title: "Remove from this task, the file stays",
            ariaLabel: `Remove ${image}`,
            onclick: () => {
              images = images.filter((other) => other !== image);
              touch();
              renderImages();
            },
          },
          "×",
        ),
      ),
    );
    byId("images").replaceChildren(...items);
  }

  function familyAndName(): { family: string; name: string } | null {
    const [family, name] = id
      ? id.split("/")
      : [field("family").value.trim(), field("name").value.trim()];
    return family && name ? { family, name } : null;
  }

  function fill(file: TaskFile) {
    const { constraints = {} } = file;
    field<HTMLTextAreaElement>("prompt").value = file.prompt ?? "";
    field("parent").value = file.parent ?? "";
    for (const axis of ["x", "y", "z"] as const)
      field(`size-${axis}`).value = String(file.size?.[axis] ?? 1);
    for (const rule of RULES) field(rule).value = constraints[rule]?.toString() ?? "";
    field<HTMLSelectElement>("only").value = constraints.only ?? "";
    const solved = file.reference?.status !== "impossible";
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="status"]')) {
      radio.checked = radio.value === (solved ? "solved" : "impossible");
    }
    reason.value = file.reference?.status === "impossible" ? file.reference.reason : "";
    reason.hidden = solved;
    layers = {
      initial: file.initial ?? [],
      answer: file.reference?.status === "solved" ? file.reference.blocks : [],
      protected: constraints.protected ?? [],
      alternatives: file.alternatives ?? [],
    };
    images = file.images ?? [];
  }

  // only the fields that are set, so saved files stay as short as the ones written by hand
  function toFile(): TaskFile {
    const constraints: NonNullable<TaskFile["constraints"]> = {};
    for (const rule of RULES) {
      const value = field(rule).value.trim();
      if (value !== "") constraints[rule] = Number(value);
    }
    const only = field<HTMLSelectElement>("only").value;
    if (only === "add" || only === "remove") constraints.only = only;
    if (layers.protected.length > 0) constraints.protected = layers.protected;
    const some = <T>(items: T[]) => (items.length > 0 ? items : undefined);
    // in the order the README documents, unset fields are dropped when this is sent as JSON
    return {
      prompt: field<HTMLTextAreaElement>("prompt").value.trim(),
      parent: field("parent").value.trim() || undefined,
      size: size(),
      initial: some(layers.initial),
      images: some(images),
      constraints: Object.keys(constraints).length > 0 ? constraints : undefined,
      reference: impossible()
        ? { status: "impossible", reason: reason.value.trim() }
        : { status: "solved", blocks: layers.answer },
      alternatives: some(layers.alternatives),
    };
  }

  async function refreshList(selected: string | null) {
    const ids = (await (await request("/api/tasks")).json()) as string[];
    list.replaceChildren(
      element("option", { value: "" }, "New task"),
      ...ids.map((task) => element("option", { value: task }, task)),
    );
    list.value = selected ?? "";
  }

  async function open(task: string | null) {
    const mine = ++opened;
    // nothing can be edited while the task loads, it would replace those edits
    const locked = [byId("build"), byId("layers")];
    for (const part of locked) part.inert = true;
    scene.edit(null);
    try {
      const file = task
        ? ((await (await request(`/api/tasks/${task}`)).json()) as TaskFile)
        : structuredClone(BLANK);
      // another task was picked while this one loaded
      if (mine !== opened) return;
      id = task;
      fill(file);
      active = task ? "answer" : "initial";
      byId("new-name").hidden = task !== null;
      dirty = false;
      say("");
      renderImages();
      if (showing()) {
        scene.setGrid(size());
        scene.frame();
        draw();
      }
    } catch (error) {
      say(`Could not open ${task}: ${message(error)}`, true);
    } finally {
      if (mine === opened) {
        for (const part of locked) part.inert = false;
        if (showing()) scene.edit(edit);
      }
    }
  }

  async function save() {
    const named = familyAndName();
    if (!named) return say("Give the task a family and a name first", true);
    const { family, name } = named;
    const save = byId<HTMLButtonElement>("save");
    // switching tasks mid save would leave the page pointing at the wrong file
    save.disabled = true;
    list.disabled = true;
    const sent = revision;
    try {
      await request(`/api/tasks/${encodeURIComponent(family)}/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(id ? {} : { "if-none-match": "*" }) },
        body: JSON.stringify(toFile()),
      });
      id = `${family}/${name}`;
      dirty = revision !== sent;
      byId("new-name").hidden = true;
      await refreshList(id);
      say(dirty ? "Saved, with newer unsaved changes" : `Saved tasks/${id}.json`);
    } catch (error) {
      say(message(error), true);
    } finally {
      save.disabled = false;
      list.disabled = false;
    }
  }

  async function snapshot(view: View) {
    // an unsaved name may belong to an existing task, whose images a snapshot would replace
    if (!id) return say("Save the task first, then take snapshots", true);
    const [family = "", name = ""] = id.split("/");
    const image = `${name}-${view}.png`;
    const task = opened;
    try {
      const blob = await scene.snapshot(view, [{ blocks: current(), style: "solid" }]);
      await request(`/api/images/${encodeURIComponent(family)}/${image}`, {
        method: "PUT",
        body: blob,
      });
      // saved next to the task it was taken for, but only listed if that task is still open
      if (task !== opened) return;
      if (!images.includes(image)) images.push(image);
      touch();
      renderImages();
    } catch (error) {
      say(message(error), true);
    }
  }

  function edit(cell: Cell, mode: "add" | "remove") {
    const cells = current();
    const at = cells.findIndex((other) => cellKey(other) === cellKey(cell));
    if (mode === "add" && at === -1) cells.push(cell);
    else if (mode === "remove" && at !== -1) cells.splice(at, 1);
    else return;
    touch();
    draw();
  }

  list.addEventListener("change", () => {
    if (dirty && !confirm("Discard unsaved changes?")) {
      list.value = id ?? "";
      return;
    }
    void open(list.value || null);
  });
  byId("build").addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (target === list) return;
    if (target.id.startsWith("size-")) {
      scene.setGrid(size());
      draw();
    }
    if (target.getAttribute("name") === "status") reason.hidden = !impossible();
    touch();
  });
  byId("save").addEventListener("click", () => void save());
  for (const button of document.querySelectorAll<HTMLButtonElement>(".snapshots button")) {
    button.title = "Saves the blocks in the current layer as a task image";
    button.addEventListener("click", () => void snapshot(button.dataset.view as View));
  }
  addEventListener("beforeunload", (event) => {
    if (dirty) event.preventDefault();
  });

  let loaded = false;
  return {
    async activate() {
      // a task still loading turns editing on when it arrives
      if (!byId("build").inert) scene.edit(edit);
      if (loaded) {
        scene.setGrid(size());
        draw();
        return;
      }
      loaded = true;
      try {
        await refreshList(null);
      } catch (error) {
        say(message(error), true);
      }
      await open(null);
    },
  };
}
