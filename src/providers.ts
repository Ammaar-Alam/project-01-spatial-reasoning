import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ModelConfig } from "./models.ts";
import type { ModelRequest } from "./prompt.ts";

export type ModelReply = {
  // the final answer text, the only part that is graded
  text: string;
  stopReason: string | null;
  servedModel: string | null;
  // the upstream host, for routers that pick one
  servedBy: string | null;
  responseId: string | null;
  // a refusal the provider returned instead of an answer, kept for review and graded as a failure
  refusal: string | null;
  // token counts and cost exactly as the provider reported them
  usage: unknown;
};

type Provider = ModelConfig["provider"];

export const API_KEYS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// sdk retries are off so one attempt is always exactly one generation request
const CLIENT = { maxRetries: 0, timeout: 30 * 60 * 1000 };
const POLL_INTERVAL_MS = 15_000;
const POLL_LIMIT_MS = 3 * 60 * 60 * 1000;

// lets a long background request outlive a failed poll or a crash
// started hands over the provider's id right away, a later run passes it back to keep polling
export type Resume = { responseId?: string; started: (responseId: string) => void };

// params go first so a config can never replace the model, prompt or images
export async function callModel(
  config: ModelConfig,
  request: ModelRequest,
  resume: Resume = { started: () => {} },
): Promise<ModelReply> {
  const apiKey = process.env[API_KEYS[config.provider]];
  if (!apiKey) throw new Error(`${API_KEYS[config.provider]} is not set`);
  switch (config.provider) {
    case "anthropic":
      return anthropic(config, request, apiKey);
    case "openai":
      return openai(config, request, apiKey, resume);
    case "gemini":
      return gemini(config, request, apiKey);
    case "openrouter":
      return openrouter(config, request, apiKey);
  }
}

const dataUrl = (image: ModelRequest["images"][number]) =>
  `data:${image.mediaType};base64,${image.data}`;

// streamed so long reasoning does not hit http idle timeouts
async function anthropic(config: ModelConfig, request: ModelRequest, apiKey: string) {
  const client = new Anthropic({ apiKey, ...CLIENT });
  const message = await client.messages
    .stream({
      ...config.params,
      model: config.model,
      system: request.system,
      messages: [
        {
          role: "user",
          content: [
            ...request.images.map((image) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mediaType as "image/png",
                data: image.data,
              },
            })),
            { type: "text" as const, text: request.text },
          ],
        },
      ],
    } as Anthropic.MessageStreamParams)
    .finalMessage();
  const details = message.stop_details;
  return {
    text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
    stopReason: message.stop_reason,
    servedModel: message.model,
    servedBy: null,
    responseId: message.id,
    refusal:
      message.stop_reason === "refusal"
        ? [details?.category, details?.explanation].filter(Boolean).join(": ") || "refused"
        : null,
    usage: message.usage,
  };
}

async function openai(config: ModelConfig, request: ModelRequest, apiKey: string, resume: Resume) {
  const client = new OpenAI({ apiKey, ...CLIENT });
  // checking on an existing response is not a new attempt, so this client may retry
  const poller = new OpenAI({ apiKey });

  // a saved response is picked up again unless it failed or no longer exists
  let response = resume.responseId ? await retrieve(poller, resume.responseId) : undefined;
  if (!response || response.status === "failed" || response.status === "cancelled") {
    response = await client.responses.create({
      ...config.params,
      model: config.model,
      instructions: request.system,
      input: [
        {
          role: "user",
          content: [
            ...request.images.map((image) => ({
              type: "input_image" as const,
              image_url: dataUrl(image),
              detail: "high" as const,
            })),
            { type: "input_text" as const, text: request.text },
          ],
        },
      ],
      stream: false,
    } as OpenAI.Responses.ResponseCreateParamsNonStreaming);
    if (response.status === "queued" || response.status === "in_progress") {
      resume.started(response.id);
    }
  }

  // with "background": true the request returns right away and is polled until it finishes
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (response.status === "queued" || response.status === "in_progress") {
    if (Date.now() > deadline) throw new Error(`${response.id} still ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    response = await poller.responses.retrieve(response.id);
  }
  if (response.status === "failed" || response.status === "cancelled") {
    throw new Error(
      `${response.id} ${response.status}: ${response.error?.message ?? "no details"}`,
    );
  }

  // commentary messages are progress notes before the answer, so only the rest is graded
  const messages = response.output.flatMap((item) =>
    item.type === "message" && item.phase !== "commentary" ? [item] : [],
  );
  const parts = messages.flatMap((message) => message.content);
  const refusals = parts.flatMap((part) => (part.type === "refusal" ? [part.refusal] : []));
  return {
    text: parts.flatMap((part) => (part.type === "output_text" ? [part.text] : [])).join(""),
    stopReason: response.incomplete_details?.reason ?? response.status ?? null,
    servedModel: response.model,
    servedBy: null,
    responseId: response.id,
    refusal: refusals.length > 0 ? refusals.join("\n") : null,
    usage: response.usage ?? null,
  };
}

async function openrouter(config: ModelConfig, request: ModelRequest, apiKey: string) {
  const client = new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1", ...CLIENT });
  const completion = await client.chat.completions.create({
    ...config.params,
    // otherwise a failed upstream is quietly sent on to another provider, a second generation
    provider: { ...(config.params.provider as object | undefined), allow_fallbacks: false },
    model: config.model,
    messages: [
      { role: "system", content: request.system },
      {
        role: "user",
        content: [
          ...request.images.map((image) => ({
            type: "image_url" as const,
            image_url: { url: dataUrl(image), detail: "high" as const },
          })),
          { type: "text" as const, text: request.text },
        ],
      },
    ],
    stream: false,
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
  // openrouter reports an upstream failure inside a 200 response, which is a failed call, not an answer
  const choice = completion.choices[0] as
    | (OpenAI.Chat.ChatCompletion.Choice & { error?: { message?: string } })
    | undefined;
  if (!choice) throw new Error(`${completion.id} returned no choices`);
  if (choice.error || (choice.finish_reason as string) === "error") {
    throw new Error(`${completion.id}: ${choice.error?.message ?? "upstream error"}`);
  }
  return {
    text: choice.message.content ?? "",
    stopReason: choice.finish_reason,
    servedModel: completion.model,
    servedBy: (completion as { provider?: string }).provider ?? null,
    responseId: completion.id,
    refusal: choice.message.refusal ?? null,
    usage: completion.usage ?? null,
  };
}

async function retrieve(poller: OpenAI, id: string) {
  try {
    return await poller.responses.retrieve(id);
  } catch (error) {
    if (error instanceof OpenAI.NotFoundError) return undefined;
    throw error;
  }
}

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: unknown;
  modelVersion?: string;
  responseId?: string;
};

// plain rest call, the google sdk retries on its own
async function gemini(config: ModelConfig, request: ModelRequest, apiKey: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    signal: AbortSignal.timeout(CLIENT.timeout),
    body: JSON.stringify({
      ...config.params,
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [
        {
          role: "user",
          parts: [
            ...request.images.map((image) => ({
              inlineData: { mimeType: image.mediaType, data: image.data },
            })),
            { text: request.text },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const data = (await response.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  return {
    text: parts.flatMap((part) => (part.thought || !part.text ? [] : [part.text])).join(""),
    stopReason: candidate?.finishReason ?? data.promptFeedback?.blockReason ?? null,
    servedModel: data.modelVersion ?? null,
    servedBy: null,
    responseId: data.responseId ?? null,
    // gemini signals a block through finishReason or blockReason, kept in stopReason
    refusal: null,
    usage: data.usageMetadata ?? null,
  };
}
