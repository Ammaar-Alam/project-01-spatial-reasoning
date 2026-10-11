import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const modelSchema = z.strictObject({
  provider: z.enum(["anthropic", "openai", "gemini", "openrouter"]),
  // the id the provider's API expects
  model: z.string().min(1),
  // merged into the request body as-is, e.g. output limits and reasoning effort
  params: z.record(z.string(), z.unknown()).default({}),
});

const catalogSchema = z.record(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/), modelSchema);

export type ModelConfig = z.infer<typeof modelSchema>;

export const MODELS_FILE = path.resolve(import.meta.dirname, "../models.json");

export async function loadModels(file = MODELS_FILE): Promise<Record<string, ModelConfig>> {
  const result = catalogSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!result.success) {
    throw new Error(`${path.basename(file)}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
