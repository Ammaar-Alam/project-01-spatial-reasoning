import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { ModelRequest } from "./prompt.ts";
import { callModel } from "./providers.ts";

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

// replaces fetch with canned responses and records what each request sent
function fakeFetch(...responses: Response[]): Sent[] {
  const sent: Sent[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    sent.push({ url: request.url, headers: request.headers, body: text ? JSON.parse(text) : {} });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  });
  return sent;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const request: ModelRequest = {
  system: "system prompt",
  text: "task text",
  images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
};

const answer = '{"status": "impossible", "reason": "no room"}';

beforeEach(() => {
  for (const name of ["ANTHROPIC", "OPENAI", "GEMINI", "OPENROUTER"]) {
    process.env[`${name}_API_KEY`] = `test-${name.toLowerCase()}`;
  }
});

afterEach(() => mock.restoreAll());

test("anthropic streams one message with the image before the text", async () => {
  const sent = fakeFetch(
    sse([
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 30 },
      },
      { type: "message_stop" },
    ]),
  );
  const reply = await callModel(
    {
      provider: "anthropic",
      model: "claude-opus-5-5",
      params: { max_tokens: 1000, model: "ignored" },
    },
    request,
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent[0]?.headers.get("x-api-key"), "test-anthropic");
  assert.deepEqual(sent[0]?.body, {
    max_tokens: 1000,
    model: "claude-opus-5-5",
    system: "system prompt",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
          { type: "text", text: "task text" },
        ],
      },
    ],
    stream: true,
  });
  assert.equal(reply.text, answer);
  assert.equal(reply.stopReason, "end_turn");
  assert.equal(reply.servedModel, "claude-opus-5-5");
  assert.equal(reply.responseId, "msg_1");
});

const openaiResponse = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  object: "response",
  model: "gpt-6.1-sol",
  status,
  output: [],
  usage: null,
  ...extra,
});

test("openai sends one responses request and returns its text", async () => {
  const sent = fakeFetch(
    json(
      openaiResponse("completed", {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    ),
  );
  const reply = await callModel(
    { provider: "openai", model: "gpt-6.1-sol", params: { reasoning: { effort: "high" } } },
    request,
  );

  assert.equal(sent[0]?.url, "https://api.openai.com/v1/responses");
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer test-openai");
  assert.deepEqual(sent[0]?.body, {
    reasoning: { effort: "high" },
    model: "gpt-6.1-sol",
    instructions: "system prompt",
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=", detail: "high" },
          { type: "input_text", text: "task text" },
        ],
      },
    ],
    stream: false,
  });
  assert.equal(reply.text, answer);
  assert.equal(reply.stopReason, "completed");
  assert.deepEqual(reply.usage, { input_tokens: 10, output_tokens: 20 });
});

test("openai polls a background response without sending it again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const sent = fakeFetch(
    json(openaiResponse("queued")),
    json(openaiResponse("in_progress")),
    json(
      openaiResponse("incomplete", {
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: '{"status":', annotations: [] }],
          },
        ],
      }),
    ),
  );
  const pending = callModel(
    { provider: "openai", model: "gpt-6.1-sol", params: { background: true } },
    request,
  );
  while (sent.length < 3) {
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(15_000);
  }
  const reply = await pending;

  assert.deepEqual(
    sent.map((s) => s.url),
    [
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses/resp_1",
      "https://api.openai.com/v1/responses/resp_1",
    ],
  );
  assert.equal(reply.text, '{"status":');
  assert.equal(reply.stopReason, "max_output_tokens");
});

test("openai reports a failed response as an error", async () => {
  fakeFetch(json(openaiResponse("failed", { error: { code: "server_error", message: "boom" } })));
  await assert.rejects(
    callModel({ provider: "openai", model: "gpt-6.1-sol", params: {} }, request),
    /resp_1 failed: boom/,
  );
});

test("openrouter sends a chat completion and records the upstream host", async () => {
  const sent = fakeFetch(
    json({
      id: "gen-1",
      object: "chat.completion",
      created: 0,
      model: "z-ai/glm-5.3",
      provider: "Z.AI",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: answer },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.01 },
    }),
  );
  const reply = await callModel(
    {
      provider: "openrouter",
      model: "z-ai/glm-5.3",
      params: { provider: { require_parameters: true } },
    },
    request,
  );

  assert.equal(sent[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer test-openrouter");
  assert.deepEqual(sent[0]?.body, {
    provider: { require_parameters: true },
    model: "z-ai/glm-5.3",
    messages: [
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aW1hZ2U=", detail: "high" },
          },
          { type: "text", text: "task text" },
        ],
      },
    ],
    stream: false,
  });
  assert.equal(reply.text, answer);
  assert.equal(reply.servedBy, "Z.AI");
  assert.deepEqual(reply.usage, {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
    cost: 0.01,
  });
});

test("gemini skips thought parts and keeps the answer text", async () => {
  const sent = fakeFetch(
    json({
      candidates: [
        {
          content: { parts: [{ text: "thinking...", thought: true }, { text: answer }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10 },
      modelVersion: "gemini-3.8-flash",
      responseId: "abc",
    }),
  );
  const reply = await callModel(
    {
      provider: "gemini",
      model: "gemini-3.8-flash",
      params: { generationConfig: { thinkingConfig: { thinkingLevel: "high" } } },
    },
    request,
  );

  assert.equal(
    sent[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  );
  assert.equal(sent[0]?.headers.get("x-goog-api-key"), "test-gemini");
  assert.deepEqual(sent[0]?.body, {
    generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
    systemInstruction: { parts: [{ text: "system prompt" }] },
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }, { text: "task text" }],
      },
    ],
  });
  assert.deepEqual(reply, {
    text: answer,
    stopReason: "STOP",
    servedModel: "gemini-3.8-flash",
    servedBy: null,
    responseId: "abc",
    usage: { promptTokenCount: 10 },
  });
});

test("gemini reports http errors with the status", async () => {
  fakeFetch(json({ error: { message: "bad key" } }, 403));
  await assert.rejects(
    callModel({ provider: "gemini", model: "gemini-3.8-flash", params: {} }, request),
    /Gemini 403/,
  );
});

test("refuses to call a provider without its api key", async () => {
  delete process.env.OPENROUTER_API_KEY;
  const sent = fakeFetch();
  await assert.rejects(
    callModel({ provider: "openrouter", model: "z-ai/glm-5.3", params: {} }, request),
    /OPENROUTER_API_KEY is not set/,
  );
  assert.equal(sent.length, 0);
});
