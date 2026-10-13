import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { answerSchema } from "./answer.ts";
import { blockSchema, describeBlocks, duplicates, inBounds } from "./geometry.ts";

const count = z.int().nonnegative();
const length = z.int().positive();

export const taskFileSchema = z
  .strictObject({
    // instruction shown to the model
    prompt: z.string().trim().min(1),
    // groups variations of one puzzle, defaults to the task's own id
    parent: z.string().min(1).optional(),
    size: z.strictObject({ x: length, y: length, z: length }),
    initial: z.array(blockSchema).default([]),
    // paths relative to the task file
    images: z.array(z.string().min(1)).default([]),
    constraints: z
      .strictObject({
        maxEdits: count.optional(),
        exactEdits: count.optional(),
        maxBlocks: count.optional(),
        exactBlocks: count.optional(),
        // cells that must look the same before and after, filled or empty
        protected: z.array(blockSchema).default([]),
        only: z.enum(["add", "remove"]).optional(),
      })
      .default({ protected: [] }),
    // never shown to the model
    reference: answerSchema,
    // other final structures that are also correct, for tasks without a unique answer
    alternatives: z.array(z.array(blockSchema)).default([]),
  })
  .superRefine((task, ctx) => {
    if (task.reference.status === "impossible" && task.alternatives.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["alternatives"],
        message: "an impossible task has no alternative solutions",
      });
    }
    const groups = [
      { field: ["initial"], blocks: task.initial },
      { field: ["constraints", "protected"], blocks: task.constraints.protected },
    ];
    for (const { field, blocks } of groups) {
      const outside = blocks.filter((block) => !inBounds(block, task.size));
      if (outside.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: field,
          message: `outside the grid: ${describeBlocks(outside)}`,
        });
      }
      const repeated = duplicates(blocks);
      if (repeated.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: field,
          message: `listed twice: ${describeBlocks(repeated)}`,
        });
      }
    }
  });

type TaskFile = z.infer<typeof taskFileSchema>;

export type Task = TaskFile & {
  // "<family>/<name>", taken from the file path
  id: string;
  family: string;
  parent: string;
  file: string;
};

// a task file that cannot be loaded, as opposed to a bug in this code
export class TaskError extends Error {}

export const TASKS_DIR = path.resolve(import.meta.dirname, "../tasks");

export const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function findTaskFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true });
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => path.join(root, entry))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function loadTasks(root: string): Promise<Task[]> {
  const files = await findTaskFiles(root);
  return Promise.all(files.map((file) => loadTask(root, file)));
}

export async function loadTask(root: string, file: string): Promise<Task> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TaskError(`${path.relative(root, file)}: invalid JSON: ${reason}`);
  }
  return parseTask(root, file, json);
}

// checks a task's contents as if they were saved at file, which need not exist yet
export async function parseTask(root: string, file: string, json: unknown): Promise<Task> {
  const relative = path.relative(root, file);
  const [family, fileName, ...rest] = relative.split(path.sep);
  const name = fileName?.replace(/\.json$/, "");
  if (!family || !name || rest.length > 0) {
    throw new TaskError(`${relative}: tasks live at tasks/<family>/<name>.json`);
  }
  if (!NAME.test(family) || !NAME.test(name)) {
    throw new TaskError(`${relative}: use lowercase letters, digits and hyphens in names`);
  }

  const result = taskFileSchema.safeParse(json);
  if (!result.success) {
    throw new TaskError(`${relative}:\n${z.prettifyError(result.error)}`);
  }

  const id = `${family}/${name}`;
  const images = result.data.images.map((image) => path.resolve(path.dirname(file), image));
  for (const image of images) {
    // kept inside the family folder so a task and its images can be copied as one unit
    if (path.relative(path.dirname(file), image).split(path.sep)[0] === "..") {
      throw new TaskError(`${relative}: images must be inside tasks/${family}/`);
    }
    if (!Object.hasOwn(IMAGE_TYPES, path.extname(image).toLowerCase())) {
      throw new TaskError(`${relative}: unsupported image type ${path.basename(image)}`);
    }
    try {
      await access(image);
    } catch {
      throw new TaskError(`${relative}: missing image ${path.relative(root, image)}`);
    }
  }

  return { ...result.data, id, family, parent: result.data.parent ?? id, file, images };
}
