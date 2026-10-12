import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Agent } from "undici";
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

// a request is given up after this long, whether it is waiting, streaming or being polled
// generous so a long generation is never cut off and then paid for again
const DEADLINE_MS = 3 * 60 * 60 * 1000;
// node's fetch gives up after 5 minutes without a byte, and a long generation can stay silent longer
const dispatcher = new Agent({ headersTimeout: DEADLINE_MS, bodyTimeout: DEADLINE_MS });
// sdk retries are off so one attempt is always exactly one generation request
const CLIENT = { maxRetries: 0, timeout: DEADLINE_MS, fetchOptions: { dispatcher } };
const POLL_INTERVAL_MS = 15_000;

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
    .stream(
      {
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
      } as Anthropic.MessageStreamParams,
      { signal: AbortSignal.timeout(DEADLINE_MS) },
    )
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

  const body = {
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
  } as OpenAI.Responses.ResponseCreateParamsNonStreaming;

  // one deadline covers picking up, sending, waiting and polling
  const signal = AbortSignal.timeout(DEADLINE_MS);
  // a saved response is picked up again unless it is gone or failed in a way a new request could fix
  let response = resume.responseId ? await retrieve(poller, resume.responseId, signal) : undefined;
  if (
    !response ||
    response.status === "cancelled" ||
    (response.status === "failed" && !isOpenAIPolicyBlock(response.error?.code))
  ) {
    try {
      response = await client.responses.create(body, { signal });
    } catch (error) {
      // a policy block before generation starts comes back as an http 403
      if (error instanceof OpenAI.APIError && isOpenAIPolicyBlock(error.code)) {
        return blocked(error.code, error.message);
      }
      throw error;
    }
    // handed over before its status is checked, so even a reply that already failed is named and timed
    resume.started(response.id);
  }

  // with "background": true the request returns right away and is polled until it finishes
  while (response.status === "queued" || response.status === "in_progress") {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (signal.aborted) throw new Error(`${response.id} still ${response.status} at the deadline`);
    response = await poller.responses.retrieve(response.id, {}, { signal });
  }
  const { error } = response;
  if (response.status === "failed" && error && isOpenAIPolicyBlock(error.code)) {
    return blocked(error.code, error.message, {
      servedModel: response.model,
      responseId: response.id,
      usage: response.usage ?? null,
    });
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
    refusal:
      refusals.join("\n") ||
      (response.incomplete_details?.reason === "content_filter" ? "content_filter" : null),
    usage: response.usage ?? null,
  };
}

async function openrouter(config: ModelConfig, request: ModelRequest, apiKey: string) {
  const client = new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1", ...CLIENT });
  const body = {
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
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
  let completion: OpenAI.Chat.ChatCompletion & { provider?: string; error?: OpenRouterError };
  try {
    completion = await client.chat.completions.create(body, {
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch (error) {
    // a policy block usually comes back as an http 403
    const blocked = error instanceof OpenAI.APIError ? policyRefusal(error.error, null) : undefined;
    if (blocked) return blocked;
    throw error;
  }
  // a 200 response can still carry a policy block, or an upstream failure that is not an answer
  const choice = completion.choices?.[0] as
    | (OpenAI.Chat.ChatCompletion.Choice & { error?: OpenRouterError })
    | undefined;
  const failure = completion.error ?? choice?.error;
  const blocked = policyRefusal(failure, completion.id);
  if (blocked) return blocked;
  if (failure || (choice?.finish_reason as string) === "error") {
    throw new Error(`${completion.id}: ${failure?.message ?? "upstream error"}`);
  }
  if (!choice) throw new Error(`${completion.id} returned no choices`);
  return {
    text: choice.message.content ?? "",
    stopReason: choice.finish_reason,
    servedModel: completion.model,
    servedBy: completion.provider ?? null,
    responseId: completion.id,
    refusal:
      choice.message.refusal ||
      (choice.finish_reason === "content_filter" ? "content_filter" : null),
    usage: completion.usage ?? null,
  };
}

type OpenRouterError = {
  message?: string;
  metadata?: { error_type?: string; provider_name?: string };
};

function policyRefusal(error: unknown, responseId: string | null): ModelReply | undefined {
  const { message, metadata } = (error ?? {}) as OpenRouterError;
  const type = metadata?.error_type;
  if (type !== "refusal" && type !== "content_policy_violation") return undefined;
  return blocked(type, message, { servedBy: metadata?.provider_name ?? null, responseId });
}

// openai names every safety block with "policy", as in bio_policy or image_content_policy_violation
const isOpenAIPolicyBlock = (code: unknown): code is string =>
  typeof code === "string" && code.includes("policy");

// the model or a filter around it declined, which is its answer and the same on every retry
const blocked = (
  type: string,
  message: string | undefined,
  reply: Partial<ModelReply> = {},
): ModelReply => ({
  text: "",
  stopReason: type,
  servedModel: null,
  servedBy: null,
  responseId: null,
  refusal: message || type,
  usage: null,
  ...reply,
});

async function retrieve(poller: OpenAI, id: string, signal: AbortSignal) {
  try {
    return await poller.responses.retrieve(id, {}, { signal });
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
    signal: AbortSignal.timeout(DEADLINE_MS),
    dispatcher,
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
  const finish = candidate?.finishReason;
  return {
    text: parts.flatMap((part) => (part.thought || !part.text ? [] : [part.text])).join(""),
    stopReason: finish ?? data.promptFeedback?.blockReason ?? null,
    servedModel: data.modelVersion ?? null,
    servedBy: null,
    responseId: data.responseId ?? null,
    // gemini signals a block through a blocked prompt or a filter stop rather than a refusal
    refusal:
      data.promptFeedback?.blockReason ?? (finish && GEMINI_FILTERS.has(finish) ? finish : null),
    usage: data.usageMetadata ?? null,
  };
}

const GEMINI_FILTERS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "ESCALATION",
]);
