import { z } from "zod";
import { blockSchema } from "./geometry.ts";

// the full final structure, or a claim that the task cannot be solved as stated
export const answerSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("solved"), blocks: z.array(blockSchema) }),
  z.strictObject({ status: z.literal("impossible"), reason: z.string().trim().min(1) }),
]);

export type Answer = z.infer<typeof answerSchema>;

export type ParseFailure = { code: "invalid_json" | "invalid_answer"; message: string };

export type ParseResult = { ok: true; answer: Answer } | { ok: false; failure: ParseFailure };

// one optional ```json fence around the whole reply, nothing else is stripped
const FENCED = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/;

// strict on purpose: no searching for the best json object, no repairs
export function parseAnswer(raw: string): ParseResult {
  const text = raw.trim();
  const body = FENCED.exec(text)?.[1] ?? text;

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      failure: { code: "invalid_json", message: `reply is not one JSON value: ${reason}` },
    };
  }

  const result = answerSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      failure: { code: "invalid_answer", message: z.prettifyError(result.error) },
    };
  }
  return { ok: true, answer: result.data };
}
