import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { Agent } from "undici";
import type { ModelRequest } from "./prompt.ts";
import { callModel, type Resume } from "./providers.ts";

const resuming = (hooks: Partial<Resume> = {}): Resume => ({
  sending() {},
  started() {},
  ...hooks,
});

type Sent = { url: string; headers: Headers; body: Record<string, unknown>; dispatcher: unknown };

// replaces fetch with canned responses and records what each request sent
function fakeFetch(...responses: Response[]): Sent[] {
  const sent: Sent[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const request = new Request(input, init);
    const text = await request.text();
    sent.push({
      url: request.url,
      headers: request.headers,
      body: text ? JSON.parse(text) : {},
      dispatcher: init?.dispatcher,
    });
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

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

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
  assert.ok(sent[0]?.dispatcher instanceof Agent);
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
  assert.ok(sent[0]?.dispatcher instanceof Agent);
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

test("openai returns only the final answer, not commentary before it", async () => {
  const message = (phase: string, text: string) => ({
    type: "message",
    role: "assistant",
    phase,
    content: [{ type: "output_text", text, annotations: [] }],
  });
  fakeFetch(
    json(
      openaiResponse("completed", {
        output: [
          message("commentary", "Checking the grid first."),
          message("final_answer", answer),
        ],
      }),
    ),
  );
  const reply = await callModel({ provider: "openai", model: "gpt-6.1-sol", params: {} }, request);
  assert.equal(reply.text, answer);
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
  const started: string[] = [];
  const pending = callModel(
    { provider: "openai", model: "gpt-6.1-sol", params: { background: true } },
    request,
    resuming({ started: (id) => started.push(id) }),
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
  assert.deepEqual(started, ["resp_1"]);
  assert.equal(reply.text, '{"status":');
  assert.equal(reply.stopReason, "max_output_tokens");
});

const completed = () =>
  json(
    openaiResponse("completed", {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: answer, annotations: [] }],
        },
      ],
    }),
  );

test("openai picks up a saved response instead of sending the task again", async () => {
  const sent = fakeFetch(completed());
  let sending = 0;
  const reply = await callModel(
    { provider: "openai", model: "gpt-6.1-sol", params: { background: true } },
    request,
    resuming({ responseId: "resp_1", sending: () => sending++ }),
  );
  assert.equal(sending, 0);
  assert.deepEqual(
    sent.map((s) => s.url),
    ["https://api.openai.com/v1/responses/resp_1"],
  );
  assert.equal(reply.text, answer);
});

test("openai sends the task again only when the saved response failed or is gone", async () => {
  for (const saved of [
    json(openaiResponse("failed", { error: { code: "server_error", message: "boom" } })),
    json({ error: { message: "not found", type: "invalid_request_error" } }, 404),
  ]) {
    const sent = fakeFetch(saved, completed());
    // the new request is timed from when it is sent, after the saved one was looked up
    const sentBefore: number[] = [];
    const reply = await callModel(
      { provider: "openai", model: "gpt-6.1-sol", params: { background: true } },
      request,
      resuming({ responseId: "resp_1", sending: () => sentBefore.push(sent.length) }),
    );
    assert.deepEqual(sentBefore, [1]);
    assert.deepEqual(
      sent.map((s) => s.url),
      ["https://api.openai.com/v1/responses/resp_1", "https://api.openai.com/v1/responses"],
    );
    assert.equal(reply.text, answer);
    mock.restoreAll();
  }
});

test("openai hands over a replacement's id even if it fails right away", async () => {
  fakeFetch(
    json(openaiResponse("cancelled")),
    json(
      openaiResponse("failed", { id: "resp_2", error: { code: "server_error", message: "boom" } }),
    ),
  );
  const started: string[] = [];
  await assert.rejects(
    callModel(
      { provider: "openai", model: "gpt-6.1-sol", params: { background: true } },
      request,
      resuming({
        responseId: "resp_1",
        started: (id) => started.push(id),
      }),
    ),
    /resp_2 failed/,
  );
  assert.deepEqual(started, ["resp_2"]);
});

test("openai keeps a policy block as the model's answer instead of sending the task again", async () => {
  const blocked = (code: string) =>
    json(openaiResponse("failed", { error: { code, message: "Safety systems blocked this." } }));
  const config = { provider: "openai" as const, model: "gpt-6.1-sol", params: {} };
  const cases = [
    // a fresh request that fails, a saved one that already failed, and a block before it starts
    { responses: [blocked("image_content_policy_violation")], resume: undefined },
    { responses: [blocked("bio_policy")], resume: resuming({ responseId: "resp_1" }) },
    {
      responses: [
        json(
          {
            error: {
              type: "invalid_request_error",
              code: "misalignment_policy_violation",
              message: "Safety systems blocked this.",
            },
          },
          403,
        ),
      ],
      resume: undefined,
    },
  ];
  for (const { responses, resume } of cases) {
    const sent = fakeFetch(...responses);
    const reply = await callModel(config, request, resume);
    assert.equal(sent.length, 1);
    assert.equal(reply.text, "");
    assert.match(reply.refusal ?? "", /Safety systems blocked this/);
    mock.restoreAll();
  }
});

test("openai stops polling a background response at the deadline", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const deadline = new AbortController();
  mock.method(AbortSignal, "timeout", () => deadline.signal);
  const sent = fakeFetch(json(openaiResponse("queued")), completed());
  // the deadline passes while the first poll is waiting
  const pending = callModel(
    { provider: "openai", model: "gpt-6.1-sol", params: { background: true } },
    request,
    resuming({ started: () => deadline.abort() }),
  );
  pending.catch(() => {});
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(15_000);
  }
  await assert.rejects(pending, /resp_1 still queued at the deadline/);
  assert.equal(sent.length, 1);
});

test("a reply stopped by a content filter is a refusal, even if its text is an answer", async () => {
  const config = (provider: "openai" | "openrouter" | "gemini", model: string) => ({
    provider,
    model,
    params: {},
  });
  const cases = [
    {
      config: config("openai", "gpt-6.1-sol"),
      response: openaiResponse("incomplete", {
        incomplete_details: { reason: "content_filter" },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          },
        ],
      }),
      refusal: "content_filter",
    },
    {
      config: config("openrouter", "z-ai/glm-5.3"),
      response: {
        id: "gen-1",
        object: "chat.completion",
        created: 0,
        model: "z-ai/glm-5.3",
        choices: [
          {
            index: 0,
            finish_reason: "content_filter",
            message: { role: "assistant", content: answer },
          },
        ],
      },
      refusal: "content_filter",
    },
    {
      config: config("gemini", "gemini-3.8-flash"),
      response: {
        candidates: [{ content: { parts: [{ text: answer }] }, finishReason: "SAFETY" }],
      },
      refusal: "SAFETY",
    },
    {
      config: config("gemini", "gemini-3.8-flash"),
      response: {
        candidates: [{ content: { parts: [{ text: answer }] }, finishReason: "ESCALATION" }],
      },
      refusal: "ESCALATION",
    },
    {
      config: config("gemini", "gemini-3.8-flash"),
      response: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } },
      refusal: "PROHIBITED_CONTENT",
    },
  ];
  for (const { config, response, refusal } of cases) {
    fakeFetch(json(response));
    const reply = await callModel(config, request);
    assert.equal(reply.refusal, refusal, config.provider);
    mock.restoreAll();
  }
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
      params: { provider: { require_parameters: true, allow_fallbacks: true } },
    },
    request,
  );

  assert.equal(sent[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.ok(sent[0]?.dispatcher instanceof Agent);
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer test-openrouter");
  // a failed upstream is never handed to another provider within the same attempt
  assert.deepEqual(sent[0]?.body, {
    provider: { require_parameters: true, allow_fallbacks: false },
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
  assert.ok(sent[0]?.dispatcher instanceof Agent);
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
    refusal: null,
    usage: { promptTokenCount: 10 },
  });
});

test("gemini resends long decode hops with the latest token and joins them", async () => {
  const hop = (finishReason: string, parts: unknown[], token?: string) =>
    json({
      candidates: [{ content: { parts }, finishReason, continuationToken: token }],
      usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 100 },
      modelVersion: "gemini-4-argon",
      responseId: finishReason,
    });
  const sent = fakeFetch(
    hop("CONTINUATION", [{ text: "thinking...", thought: true }], "t1"),
    hop("CONTINUATION", [{ text: answer.slice(0, 10) }], "t2"),
    hop("STOP", [{ text: answer.slice(10) }]),
  );
  const reply = await callModel(
    { provider: "gemini", model: "gemini-4-argon", params: { generationConfig: {} } },
    request,
  );

  assert.equal(sent.length, 3);
  assert.equal(sent[0]?.body.continuationToken, undefined);
  assert.deepEqual(sent[2]?.body, { ...sent[0]?.body, continuationToken: "t2" });
  assert.equal(reply.text, answer);
  assert.equal(reply.stopReason, "STOP");
  assert.equal(reply.responseId, "STOP");
  assert.deepEqual(reply.usage, { promptTokenCount: 30, thoughtsTokenCount: 300 });
});

const chat = (choice: Record<string, unknown>) =>
  json({
    id: "gen-1",
    object: "chat.completion",
    created: 0,
    model: "z-ai/glm-5.3",
    choices: [choice],
  });

test("openrouter treats an error inside a 200 response as a failed call", async () => {
  for (const choice of [
    {
      index: 0,
      finish_reason: "error",
      error: { code: 502, message: "Provider disconnected" },
      message: { role: "assistant", content: '{"status":' },
    },
    {
      index: 0,
      finish_reason: "stop",
      error: { code: 502, message: "Provider disconnected" },
      message: { role: "assistant", content: "" },
    },
  ]) {
    fakeFetch(chat(choice));
    await assert.rejects(
      callModel({ provider: "openrouter", model: "z-ai/glm-5.3", params: {} }, request),
      /Provider disconnected/,
    );
    mock.restoreAll();
  }

  // cut off upstream, with reasoning billed and no text
  fakeFetch(
    json({
      id: "gen-1",
      object: "chat.completion",
      created: 0,
      model: "z-ai/glm-5.3",
      choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: " " } }],
      usage: { completion_tokens: 8084, cost: 0.007 },
    }),
  );
  await assert.rejects(
    callModel({ provider: "openrouter", model: "z-ai/glm-5.3", params: {} }, request),
    (error: Error & { usage?: { cost?: number } }) =>
      /no finish reason/.test(error.message) && error.usage?.cost === 0.007,
  );
  mock.restoreAll();

  // a refusal is still the model's answer
  fakeFetch(
    chat({
      index: 0,
      finish_reason: null,
      message: { role: "assistant", content: "", refusal: "I can't help with that." },
    }),
  );
  const refused = await callModel(
    { provider: "openrouter", model: "z-ai/glm-5.3", params: {} },
    request,
  );
  assert.equal(refused.refusal, "I can't help with that.");
  mock.restoreAll();

  // text with no finish reason is graded as it is
  fakeFetch(
    chat({ index: 0, finish_reason: null, message: { role: "assistant", content: '{"status":' } }),
  );
  const partial = await callModel(
    { provider: "openrouter", model: "z-ai/glm-5.3", params: {} },
    request,
  );
  assert.equal(partial.text, '{"status":');
  mock.restoreAll();

  fakeFetch(json({ id: "gen-1", object: "chat.completion", created: 0, model: "m", choices: [] }));
  await assert.rejects(
    callModel({ provider: "openrouter", model: "z-ai/glm-5.3", params: {} }, request),
    /no choices/,
  );
});

test("openrouter keeps a refusal reported as an error as the model's answer", async () => {
  const blocked = (error_type: string) => ({
    code: 403,
    message: "The model declined this request.",
    metadata: { error_type, provider_name: "Z.AI" },
  });
  for (const response of [
    json({ error: blocked("refusal") }, 403),
    json({ error: blocked("content_policy_violation") }, 403),
    json({ id: "gen-1", object: "chat.completion", created: 0, error: blocked("refusal") }),
  ]) {
    fakeFetch(response);
    const reply = await callModel(
      { provider: "openrouter", model: "z-ai/glm-5.3", params: {} },
      request,
    );
    assert.equal(reply.text, "");
    assert.equal(reply.refusal, "The model declined this request.");
    assert.equal(reply.servedBy, "Z.AI");
    mock.restoreAll();
  }
});

test("keeps refusal text while the answer itself stays empty", async () => {
  fakeFetch(
    chat({
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: null, refusal: "I can't help with that." },
    }),
  );
  const routed = await callModel(
    { provider: "openrouter", model: "z-ai/glm-5.3", params: {} },
    request,
  );
  assert.equal(routed.text, "");
  assert.equal(routed.refusal, "I can't help with that.");
  mock.restoreAll();

  fakeFetch(
    json(
      openaiResponse("completed", {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "I won't do that." }],
          },
        ],
      }),
    ),
  );
  const direct = await callModel({ provider: "openai", model: "gpt-6.1-sol", params: {} }, request);
  assert.equal(direct.text, "");
  assert.equal(direct.refusal, "I won't do that.");
  mock.restoreAll();

  fakeFetch(
    sse([
      {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_sequence: null,
          stop_details: { type: "refusal", category: "cyber", explanation: "Declined." },
        },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]),
  );
  const claude = await callModel(
    { provider: "anthropic", model: "claude-opus-5-5", params: { max_tokens: 100 } },
    request,
  );
  assert.equal(claude.text, "");
  assert.equal(claude.stopReason, "refusal");
  assert.equal(claude.refusal, "cyber: Declined.");
});

test("gemini reports http errors with the status", async () => {
  fakeFetch(json({ error: { message: "bad key" } }, 403));
  await assert.rejects(
    callModel({ provider: "gemini", model: "gemini-3.8-flash", params: {} }, request),
    /Gemini 403/,
  );
});

test("gives up on a request once the deadline passes, even while a reply is streaming", async () => {
  // stands in for the deadline having already passed
  mock.method(AbortSignal, "timeout", () => AbortSignal.abort(new Error("deadline passed")));
  const configs = [
    { provider: "anthropic", model: "claude-opus-5-5", params: { max_tokens: 100 } },
    { provider: "openai", model: "gpt-6.1-sol", params: {} },
    { provider: "openrouter", model: "z-ai/glm-5.3", params: {} },
    { provider: "gemini", model: "gemini-3.8-flash", params: {} },
  ] as const;
  for (const config of configs) {
    fakeFetch(json({}));
    await assert.rejects(callModel({ ...config }, request), /aborted|deadline passed/);
    mock.restoreAll();
    mock.method(AbortSignal, "timeout", () => AbortSignal.abort(new Error("deadline passed")));
  }
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
