import { createBuild } from "./build.ts";
import { byId } from "./dom.ts";
import { createResults } from "./results.ts";
import { createScene } from "./scene.ts";

type Tab = "build" | "results";

const where = byId("where");
const scene = createScene(byId<HTMLCanvasElement>("canvas"), (cell) => {
  where.textContent = cell ? `x ${cell.x}   y ${cell.y}   z ${cell.z}` : "";
});
const tabs: Record<Tab, { activate: () => void }> = {
  build: createBuild(scene),
  results: createResults(scene),
};

function open(tab: Tab) {
  for (const name of ["build", "results"] as const) {
    byId(`tab-${name}`).setAttribute("aria-selected", String(name === tab));
    byId(name).hidden = name !== tab;
  }
  byId("layers").hidden = tab !== "build";
  byId("hint").hidden = tab !== "build";
  byId("legend").hidden = tab !== "results";
  history.replaceState(null, "", tab === "results" ? "#results" : "#");
  tabs[tab].activate();
}

byId("reset").addEventListener("click", () => scene.frame());
byId("tab-build").addEventListener("click", () => open("build"));
byId("tab-results").addEventListener("click", () => open("results"));
open(location.hash === "#results" ? "results" : "build");
