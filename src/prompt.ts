import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Block } from "./geometry.ts";
import { IMAGE_TYPES, type Task } from "./task.ts";

export type Image = { mediaType: string; data: string };

// everything a model sees for one task, the reference answer is never part of it
export type ModelRequest = { system: string; text: string; images: Image[] };

export const SYSTEM_PROMPT = `You solve spatial reasoning tasks on a 3D grid of unit blocks.

Each block fills one cell with integer coordinates x, y and z. The y axis points up and y = 0 is the bottom layer. The x and z axes are horizontal.

Reply with exactly one JSON object and nothing else.

If the task can be done, give the complete final structure. List every block that exists at the end, including starting blocks you keep:
{"status": "solved", "blocks": [{"x": 0, "y": 0, "z": 0}]}

If the task cannot be done under its rules, or it does not give enough information to complete it as asked, say so instead:
{"status": "impossible", "reason": "one short sentence"}`;

export async function buildRequest(task: Task): Promise<ModelRequest> {
  const images = await Promise.all(
    task.images.map(async (file) => ({
      mediaType: IMAGE_TYPES[path.extname(file).toLowerCase()] ?? "",
      data: (await readFile(file)).toString("base64"),
    })),
  );
  return { system: SYSTEM_PROMPT, text: describeTask(task), images };
}

function describeTask(task: Task): string {
  const { size, initial, constraints: rules } = task;
  const sections = [
    task.prompt,
    `Grid: x from 0 to ${size.x - 1}, y from 0 to ${size.y - 1}, z from 0 to ${size.z - 1}.`,
    initial.length > 0
      ? `Starting structure (${plural(initial.length, "block")}):\n${blocksJson(initial)}`
      : "Starting structure: empty.",
  ];

  const lines: string[] = [];
  if (rules.maxEdits !== undefined) lines.push(`Make at most ${plural(rules.maxEdits, "edit")}.`);
  if (rules.exactEdits !== undefined)
    lines.push(`Make exactly ${plural(rules.exactEdits, "edit")}.`);
  if (rules.maxEdits !== undefined || rules.exactEdits !== undefined) {
    lines.push(
      "An edit adds one block or removes one block, counted by comparing the final structure with the starting structure. Moving a block counts as 2 edits.",
    );
  }
  if (rules.maxBlocks !== undefined) {
    lines.push(`The final structure has at most ${plural(rules.maxBlocks, "block")}.`);
  }
  if (rules.exactBlocks !== undefined) {
    lines.push(`The final structure has exactly ${plural(rules.exactBlocks, "block")}.`);
  }
  if (rules.only === "add") lines.push("Only add blocks. Do not remove any starting block.");
  if (rules.only === "remove") lines.push("Only remove blocks. Do not add any new block.");
  if (rules.protected.length > 0) {
    lines.push(
      `These cells must stay as they are, whether filled or empty:\n${blocksJson(rules.protected)}`,
    );
  }
  if (lines.length > 0) sections.push(`Rules:\n${lines.map((line) => `- ${line}`).join("\n")}`);

  return sections.join("\n\n");
}

// sorted bottom layer first so the listing does not depend on how a task was authored
function blocksJson(blocks: Block[]): string {
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  return JSON.stringify(sorted.map(({ x, y, z }) => ({ x, y, z })));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
