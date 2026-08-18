import assert from "node:assert/strict";
import { test } from "node:test";

import { PLAN_CONTROL } from "@jixu/core";
import type {
  ModelDriverContext,
  ModelGenerateEffect,
  Signal,
} from "@jixu/core";
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import {
  createLLMAdapter,
  createOpenAIModelDriver,
  createOpenAICompatibleModelDriver,
  createOpenRouterModelDriver,
} from "../src/index.ts";

const planProposal = {
  acceptanceCriteria: ["SPEC is understood"],
  assumptions: [],
  blockers: [],
  nextAction: "Read SPEC.md",
  objective: "Understand the repository",
  operation: "create" as const,
  steps: [
    {
      description: "Read the specification",
      evidence: [],
      id: "read-spec",
      status: "in_progress" as const,
    },
  ],
};
import type {
  OpenChatCompletionsClient,
  OpenResponsesClient,
} from "../src/index.ts";

function response(output: Response["output"]): Response {
  return {
    error: null,
    id: "resp_test",
    incomplete_details: null,
    output,
    output_text: "",
    status: "completed",
    usage: {
      input_tokens: 80,
      input_tokens_details: {
        cache_write_tokens: 4,
        cached_tokens: 20,
      },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 8 },
      total_tokens: 100,
      cost: 0.0042,
    },
  } as unknown as Response;
}

function effect(provider = "openai", model = "gpt-test"): ModelGenerateEffect {
  return {
    attempt: 1,
    id: "effect-1",
    idempotencyKey: "effect-1",
    input: {
      activePlan: null,
      instructions: "Use tools when useful.",
      messages: [
        { content: "Read it", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            { arguments: { path: "README.md" }, id: "call-read", name: "read" },
          ],
        },
        {
          name: "read",
          output: { content: "hello" },
          role: "tool",
          toolCallId: "call-read",
        },
      ],
      model: { model, provider },
      planControl: PLAN_CONTROL,
      tools: [
        {
          description: "Read a file",
          idempotency: "idempotent",
          inputSchema: {
            additionalProperties: false,
            properties: { path: { type: "string" } },
            required: ["path"],
            type: "object",
          },
          inputSchemaVersion: 1,
          name: "read",
          outputSchema: { type: "object" },
          outputSchemaVersion: 1,
        },
      ],
    },
    requestedByEventId: "event-1",
    threadId: "run-1",
    type: "model.generate",
  };
}

function context(signals: Signal[] = []): ModelDriverContext {
  return {
    cancellation: new AbortController().signal,
    signals: { emit: (signal) => signals.push(structuredClone(signal)) },
  };
}

class FakeResponsesClient implements OpenResponsesClient {
  body: ResponseCreateParamsStreaming | undefined;
  readonly #events: readonly ResponseStreamEvent[];

  constructor(events: readonly ResponseStreamEvent[]) {
    this.#events = events;
  }

  create(body: ResponseCreateParamsStreaming): Promise<AsyncIterable<unknown>> {
    this.body = structuredClone(body);
    const events = this.#events;
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield structuredClone(event);
      },
    });
  }
}

test("JX-PROV-005 JX-AC-002 OpenAI factory translates canonical input and emits deltas as Signals", async () => {
  const client = new FakeResponsesClient([
    {
      content_index: 0,
      delta: "I will",
      item_id: "message-1",
      logprobs: [],
      output_index: 0,
      sequence_number: 2,
      type: "response.output_text.delta",
    },
    {
      response: response([
        {
          content: [
            { annotations: [], text: "I will read it.", type: "output_text" },
          ],
          id: "message-1",
          role: "assistant",
          status: "completed",
          type: "message",
        },
        {
          arguments: JSON.stringify(planProposal),
          call_id: "call-plan",
          name: PLAN_CONTROL.name,
          status: "completed",
          type: "function_call",
        },
        {
          arguments: '{"path":"README.md"}',
          call_id: "call-next",
          name: "read",
          status: "completed",
          type: "function_call",
        },
      ]),
      sequence_number: 3,
      type: "response.completed",
    },
  ]);
  const signals: Signal[] = [];
  const outcome = await createOpenAIModelDriver({
    client,
    costCalculator: ({ usage }) => ({
      currency: "USD",
      pricingVersion: "fixture-1",
      source: "calculator",
      usdNanos: usage.totalTokens * 25_000,
    }),
  }).generate(
    effect(),
    context(signals),
  );

  assert.equal(outcome.status, "succeeded");
  if (outcome.status !== "succeeded") return;
  assert.deepEqual(outcome.accounting, {
    cost: {
      currency: "USD",
      pricingVersion: "fixture-1",
      source: "calculator",
      usdNanos: 2_500_000,
    },
    usage: {
      cacheWriteTokens: 4,
      cachedInputTokens: 20,
      inputTokens: 80,
      outputTokens: 20,
      reasoningTokens: 8,
      totalTokens: 100,
    },
  });
  assert.deepEqual(outcome.value, {
    content: "I will read it.",
    planUpdates: [planProposal],
    toolCalls: [
      { arguments: { path: "README.md" }, id: "call-next", name: "read" },
    ],
  });
  assert.deepEqual(client.body?.input, [
    { content: "Read it", role: "user" },
    {
      arguments: '{"path":"README.md"}',
      call_id: "call-read",
      name: "read",
      type: "function_call",
    },
    {
      call_id: "call-read",
      name: "read",
      output: '{"content":"hello"}',
      type: "function_call_output",
    },
  ]);
  assert.deepEqual(
    (client.body?.tools as Array<{ readonly name: string }> | undefined)?.map(
      (tool) => tool.name,
    ),
    ["read", PLAN_CONTROL.name],
  );
  assert.equal(signals[0]?.type, "model.output_text.delta");
});

test("JX-PROV-007 JX-AC-019 OpenRouter factory uses the stateless Responses endpoint with attribution headers", async () => {
  let url = "";
  let headers = new Headers();
  let body: unknown;
  const completed = {
    response: response([
      {
        content: [{ annotations: [], text: "done", type: "output_text" }],
        id: "message-1",
        role: "assistant",
        status: "completed",
        type: "message",
      },
    ]),
    sequence_number: 1,
    type: "response.completed",
  };
  const fetchMock: typeof fetch = async (input, init) => {
    url = input instanceof Request ? input.url : input.toString();
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body));
    return new Response(
      `data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    );
  };
  const driver = createOpenRouterModelDriver({
    apiKey: "or-secret",
    appName: "Jixu",
    appUrl: "https://github.com/joe960913/Jixu",
    fetch: fetchMock,
  });
  const outcome = await driver.generate(
    effect("openrouter", "openai/gpt-test"),
    context(),
  );

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(outcome.accounting?.cost, {
    currency: "USD",
    pricingVersion: null,
    source: "provider_reported",
    usdNanos: 4_200_000,
  });
  assert.equal(url, "https://openrouter.ai/api/v1/responses");
  assert.equal(headers.get("authorization"), "Bearer or-secret");
  assert.equal(headers.get("http-referer"), "https://github.com/joe960913/Jixu");
  assert.equal(headers.get("x-openrouter-title"), "Jixu");
  assert.equal((body as { store?: unknown }).store, false);
});

test("JX-PROV-008 JX-AC-019 compatible Responses format uses the caller Base URL", async () => {
  let url = "";
  const completed = {
    response: response([
      {
        content: [{ annotations: [], text: "compatible", type: "output_text" }],
        id: "message-compatible",
        role: "assistant",
        status: "completed",
        type: "message",
      },
    ]),
    sequence_number: 1,
    type: "response.completed",
  };
  const fetchMock: typeof fetch = async (input) => {
    url = input instanceof Request ? input.url : input.toString();
    return new Response(
      `data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    );
  };
  const outcome = await createOpenAICompatibleModelDriver({
    apiFormat: "responses",
    apiKey: "compatible-secret",
    baseURL: "https://gateway.example/v1",
    fetch: fetchMock,
  }).generate(effect("openai-compatible"), context());

  assert.equal(url, "https://gateway.example/v1/responses");
  assert.equal(outcome.status, "succeeded");
  if (outcome.status === "succeeded") {
    assert.equal(outcome.accounting?.cost, null);
    assert.equal(outcome.accounting?.usage?.totalTokens, 100);
    assert.equal(outcome.value.content, "compatible");
  }
});

test("JX-PROV-008 JX-AC-002 JX-AC-019 Chat Completions maps full Tool history and streamed output", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const chunks = [
    {
      choices: [
        {
          delta: { content: "Checking" },
          finish_reason: null,
          index: 0,
        },
      ],
      created: 1,
      id: "chatcmpl-test",
      model: "chat-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                function: { arguments: '{"path":', name: "read" },
                id: "call-chat",
                index: 0,
                type: "function",
              },
              {
                function: {
                  arguments: JSON.stringify(planProposal),
                  name: PLAN_CONTROL.name,
                },
                id: "call-plan-chat",
                index: 1,
                type: "function",
              },
            ],
          },
          finish_reason: null,
          index: 0,
        },
      ],
      created: 1,
      id: "chatcmpl-test",
      model: "chat-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { function: { arguments: '"SPEC.md"}' }, index: 0 },
            ],
          },
          finish_reason: "tool_calls",
          index: 0,
        },
      ],
      created: 1,
      id: "chatcmpl-test",
      model: "chat-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [],
      created: 1,
      id: "chatcmpl-test",
      model: "chat-model",
      object: "chat.completion.chunk",
      usage: {
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 6 },
        cost: 0.0035,
        prompt_tokens: 60,
        prompt_tokens_details: { cached_tokens: 10 },
        total_tokens: 80,
      },
    },
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    url = input instanceof Request ? input.url : input.toString();
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    );
  };
  const signals: Signal[] = [];
  const outcome = await createOpenAICompatibleModelDriver({
    apiFormat: "chat-completions",
    apiKey: "chat-secret",
    baseURL: "https://chat.example/v1",
    fetch: fetchMock,
    providerReportsUsdCost: true,
  }).generate(
    effect("openai-compatible", "chat-model"),
    context(signals),
  );

  assert.equal(url, "https://chat.example/v1/chat/completions");
  assert.equal(body.model, "chat-model");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(
    (body.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    ),
    ["read", PLAN_CONTROL.name],
  );
  assert.deepEqual(body.messages, [
    { content: "Use tools when useful.", role: "system" },
    { content: "Read it", role: "user" },
    {
      content: null,
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: '{"path":"README.md"}', name: "read" },
          id: "call-read",
          type: "function",
        },
      ],
    },
    {
      content: '{"content":"hello"}',
      role: "tool",
      tool_call_id: "call-read",
    },
  ]);
  assert.equal(signals[0]?.type, "model.output_text.delta");
  assert.equal(signals[1]?.type, "model.tool_arguments.delta");
  assert.equal(outcome.status, "succeeded");
  if (outcome.status === "succeeded") {
    assert.deepEqual(outcome.accounting, {
      cost: {
        currency: "USD",
        pricingVersion: null,
        source: "provider_reported",
        usdNanos: 3_500_000,
      },
      usage: {
        cacheWriteTokens: null,
        cachedInputTokens: 10,
        inputTokens: 60,
        outputTokens: 20,
        reasoningTokens: 6,
        totalTokens: 80,
      },
    });
    assert.deepEqual(outcome.value, {
      content: "Checking",
      planUpdates: [planProposal],
      toolCalls: [
        { arguments: { path: "SPEC.md" }, id: "call-chat", name: "read" },
      ],
    });
  }
});

test("JX-PROV-006 unified LLM adapter registers both providers under one ModelDriver contract", () => {
  const client = new FakeResponsesClient([]);
  const adapter = createLLMAdapter({
    openai: createOpenAIModelDriver({ client }),
    openrouter: createOpenRouterModelDriver({ client }),
  });

  assert.deepEqual(Object.keys(adapter), ["openai", "openrouter"]);
  assert.equal(typeof adapter.openai?.generate, "function");
  assert.equal(typeof adapter.openrouter?.generate, "function");
  assert.equal(Object.isFrozen(adapter), true);
});

test("JX-SEC-001 provider credentials are redacted from typed failures", async () => {
  const client: OpenResponsesClient = {
    create(): Promise<AsyncIterable<unknown>> {
      return Promise.reject(
        Object.assign(new Error("Rejected sk-private"), { status: 401 }),
      );
    },
  };
  const outcome = await createOpenAIModelDriver({
    apiKey: "sk-private",
    client,
  }).generate(effect(), context());

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.equal(outcome.error.code, "openai_http_401");
    assert.equal(outcome.error.message, "Rejected [REDACTED]");
  }
});

test("JX-PROV-008 JX-SEC-001 Chat Completions credentials are redacted", async () => {
  const client: OpenChatCompletionsClient = {
    create(): Promise<AsyncIterable<unknown>> {
      return Promise.reject(
        Object.assign(new Error("Rejected chat-private"), { status: 401 }),
      );
    },
  };
  const outcome = await createOpenAICompatibleModelDriver({
    apiFormat: "chat-completions",
    apiKey: "chat-private",
    baseURL: "https://chat.example/v1",
    chatCompletionsClient: client,
  }).generate(effect("openai-compatible"), context());

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.equal(outcome.error.code, "openai-compatible_http_401");
    assert.equal(outcome.error.message, "Rejected [REDACTED]");
  }
});
