import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artifactDigest,
  createHarness,
  defineAgent,
  InMemoryEventStore,
  PLAN_CONTROL,
  PROGRESS_CONTROL,
} from "jixu-core";
import type {
  ModelDriverContext,
  ModelGenerateEffect,
  PlanSnapshot,
  Signal,
} from "jixu-core";

import * as llm from "../src/index.ts";
import {
  createLLMAdapter,
  createLLMModelDriver,
} from "../src/index.ts";
import type {
  AnthropicMessagesClient,
  AnthropicMessagesRequest,
  OpenAIChatCompletionsClient,
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

const activePlan: PlanSnapshot = {
  acceptanceCriteria: ["SPEC is understood"],
  assumptions: [],
  blockers: [],
  id: "plan-1",
  nextAction: "Read SPEC.md",
  objective: "Understand the repository",
  revision: 1,
  schemaVersion: 1,
  status: "active",
  steps: planProposal.steps,
};

const planRejectionFeedback =
  "Plan control call-invalid.steps[0] must be a JSON object";

function effect(
  provider = "fixture-provider",
  model = "fixture-model",
  plan: PlanSnapshot | null = activePlan,
  rejectionFeedback?: string,
): ModelGenerateEffect {
  return {
    attempt: 1,
    id: "effect-1",
    idempotencyKey: "effect-1",
    input: {
      activePlan: plan,
      instructions: "Use tools when useful.",
      messages: [
        { content: "Read it", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            { arguments: { path: "README.md" }, id: "call-read", name: "read" },
            { arguments: { path: "SPEC.md" }, id: "call-spec", name: "read" },
          ],
        },
        {
          name: "read",
          output: { content: "hello" },
          role: "tool",
          toolCallId: "call-read",
        },
        {
          name: "read",
          output: { content: "requirements" },
          role: "tool",
          toolCallId: "call-spec",
        },
      ],
      mode: "standard",
      model: { model, provider },
      planControl: PLAN_CONTROL,
      ...(rejectionFeedback === undefined
        ? {}
        : {
            planRejectionFeedback: rejectionFeedback,
            runtimeContext: {
              continuation: {
                causedByEventId: "event-plan-rejected",
                reason: "plan_rejected",
                receipt: {
                  errorCode: "plan_update_invalid",
                  errorMessage: rejectionFeedback,
                  eventId: "event-plan-rejected",
                  type: "plan.rejected",
                },
              },
              obligations: ["repair_plan_control", "respond_or_act"],
              planRepair: { attempt: 1, limit: 1 },
              prohibitions: ["repeat_rejected_plan_change"],
              schemaVersion: 1,
            },
          }),
      progressControl: PROGRESS_CONTROL,
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
    threadId: "thread-1",
    type: "model.generate",
  };
}

function context(
  signals: Signal[] = [],
  cancellation = new AbortController().signal,
  artifacts: ModelDriverContext["artifacts"] = new InMemoryEventStore(),
): ModelDriverContext {
  return {
    artifacts,
    cancellation,
    signals: { emit: (signal) => signals.push(structuredClone(signal)) },
  };
}

class FakeOpenAIChatClient implements OpenAIChatCompletionsClient {
  body: Parameters<OpenAIChatCompletionsClient["create"]>[0] | undefined;
  readonly #chunks: readonly unknown[];

  constructor(chunks: readonly unknown[]) {
    this.#chunks = chunks;
  }

  create(
    body: Parameters<OpenAIChatCompletionsClient["create"]>[0],
  ): Promise<AsyncIterable<unknown>> {
    this.body = structuredClone(body);
    const chunks = this.#chunks;
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield structuredClone(chunk);
      },
    });
  }
}

class FakeAnthropicClient implements AnthropicMessagesClient {
  body: AnthropicMessagesRequest | undefined;
  readonly #events: readonly unknown[];

  constructor(events: readonly unknown[]) {
    this.#events = events;
  }

  create(body: AnthropicMessagesRequest): Promise<AsyncIterable<unknown>> {
    this.body = structuredClone(body);
    const events = this.#events;
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield structuredClone(event);
      },
    });
  }
}

function chatChunks(): readonly unknown[] {
  return [
    {
      choices: [
        {
          delta: { content: "I will read it." },
          finish_reason: null,
          index: 0,
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({ message: "Inspecting the SPEC" }),
                  name: PROGRESS_CONTROL.name,
                },
                id: "call-progress",
                index: 0,
                type: "function",
              },
              {
                function: {
                  arguments: JSON.stringify(planProposal),
                  name: PLAN_CONTROL.name,
                },
                id: "call-plan",
                index: 1,
                type: "function",
              },
              {
                function: {
                  arguments: '{"path":"SPEC.md"}',
                  name: "read",
                },
                id: "call-next",
                index: 2,
                type: "function",
              },
            ],
          },
          finish_reason: "tool_calls",
          index: 0,
        },
      ],
    },
    {
      choices: [],
      usage: {
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 8 },
        prompt_tokens: 80,
        prompt_tokens_details: { cached_tokens: 20 },
        total_tokens: 100,
      },
    },
  ];
}

function anthropicEvents(): readonly unknown[] {
  return [
    {
      message: {
        content: [],
        usage: {
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 20,
          input_tokens: 80,
          output_tokens: 1,
        },
      },
      type: "message_start",
    },
    {
      content_block: { text: "", type: "text" },
      index: 0,
      type: "content_block_start",
    },
    {
      delta: { text: "I will read it.", type: "text_delta" },
      index: 0,
      type: "content_block_delta",
    },
    {
      content_block: {
        id: "call-progress",
        input: {},
        name: PROGRESS_CONTROL.name,
        type: "tool_use",
      },
      index: 1,
      type: "content_block_start",
    },
    {
      delta: {
        partial_json: JSON.stringify({ message: "Inspecting the SPEC" }),
        type: "input_json_delta",
      },
      index: 1,
      type: "content_block_delta",
    },
    {
      content_block: {
        id: "call-plan",
        input: {},
        name: PLAN_CONTROL.name,
        type: "tool_use",
      },
      index: 2,
      type: "content_block_start",
    },
    {
      delta: {
        partial_json: JSON.stringify(planProposal),
        type: "input_json_delta",
      },
      index: 2,
      type: "content_block_delta",
    },
    {
      content_block: {
        id: "call-next",
        input: {},
        name: "read",
        type: "tool_use",
      },
      index: 3,
      type: "content_block_start",
    },
    {
      delta: {
        partial_json: '{"path":"SPEC.md"}',
        type: "input_json_delta",
      },
      index: 3,
      type: "content_block_delta",
    },
    {
      delta: { stop_reason: "tool_use", stop_sequence: null },
      type: "message_delta",
      usage: {
        output_tokens: 20,
        output_tokens_details: { thinking_tokens: 7 },
      },
    },
    { type: "message_stop" },
  ];
}

test("JX-PROV-002 JX-PROV-003 JX-AC-016 OpenAI Chat Completions normalizes controls, Tools, Signals, and usage", async () => {
  const client = new FakeOpenAIChatClient(chatChunks());
  const signals: Signal[] = [];
  const outcome = await createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://chat.example/v1",
    costCalculator: ({ usage }) => ({
      currency: "USD",
      pricingVersion: "fixture-1",
      source: "calculator",
      usdNanos: usage.totalTokens * 25_000,
    }),
    openAIChatCompletionsClient: client,
    provider: "chat-provider",
  }).generate(
    effect(
      "chat-provider",
      "fixture-model",
      activePlan,
      planRejectionFeedback,
    ),
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
      cacheWriteTokens: null,
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
      { arguments: { path: "SPEC.md" }, id: "call-next", name: "read" },
    ],
  });
  assert.deepEqual(client.body?.messages.slice(1, 5).map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "tool",
  ]);
  assert.match(
    JSON.stringify(client.body?.messages.at(-1)?.content),
    /call-invalid\.steps\[0\] must be a JSON object/,
  );
  assert.match(
    JSON.stringify(client.body?.messages.at(-1)?.content),
    /Continuation reason: plan_rejected/,
  );
  assert.match(
    JSON.stringify(client.body?.messages.at(-1)?.content),
    /Remaining obligations: repair_plan_control, respond_or_act/,
  );
  assert.match(
    JSON.stringify(client.body?.messages.at(-1)?.content),
    /Do not repeat: repeat_rejected_plan_change/,
  );
  assert.match(
    JSON.stringify(client.body?.messages.at(-1)?.content),
    /Plan repair budget: attempt 1 of 1/,
  );
  assert.deepEqual(
    (
      client.body?.tools as
        | readonly { readonly function: { readonly name: string } }[]
        | undefined
    )?.map((tool) => tool.function.name),
    ["read", PLAN_CONTROL.name, PROGRESS_CONTROL.name],
  );
  assert.equal(client.body?.reasoning_effort, undefined);
  assert.equal(signals[0]?.type, "model.output_text.delta");
  assert.deepEqual(signals.at(-1), {
    data: { message: "Inspecting the SPEC" },
    kind: "signal",
    threadId: "thread-1",
    type: "model.progress",
  });
});

test("JX-PROV-008 JX-AC-053 Ultra maps to the strongest compatible native effort without prompt changes", async () => {
  const base = effect("fixture-provider", "fixture-model", null);
  const ultra: ModelGenerateEffect = {
    ...base,
    input: { ...base.input, mode: "ultra" },
  };
  const chatClient = new FakeOpenAIChatClient(chatChunks());
  const anthropicClient = new FakeAnthropicClient(anthropicEvents());
  const directOpenAIXHigh = new FakeOpenAIChatClient(chatChunks());
  const directOpenAIHigh = new FakeOpenAIChatClient(chatChunks());
  const directAnthropicXHigh = new FakeAnthropicClient(anthropicEvents());
  const directAnthropicHigh = new FakeAnthropicClient(anthropicEvents());

  const chatOutcome = await createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://openrouter.ai/api/v1",
    openAIChatCompletionsClient: chatClient,
    provider: "openrouter",
  }).generate(ultra, context());
  const anthropicOutcome = await createLLMModelDriver({
    anthropicMessagesClient: anthropicClient,
    api: "anthropic-messages",
    baseURL: "https://api.anthropic.test",
    provider: "anthropic",
  }).generate(ultra, context());
  const directOpenAIXHighOutcome = await createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://api.openai.com/v1",
    openAIChatCompletionsClient: directOpenAIXHigh,
    provider: "openai",
  }).generate({
    ...ultra,
    input: {
      ...ultra.input,
      model: { model: "gpt-5.2", provider: "openai" },
    },
  }, context());
  const directOpenAIHighOutcome = await createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://api.openai.com/v1",
    openAIChatCompletionsClient: directOpenAIHigh,
    provider: "openai",
  }).generate({
    ...ultra,
    input: {
      ...ultra.input,
      model: { model: "gpt-5.1", provider: "openai" },
    },
  }, context());
  const directAnthropicXHighOutcome = await createLLMModelDriver({
    anthropicMessagesClient: directAnthropicXHigh,
    api: "anthropic-messages",
    baseURL: "https://api.anthropic.com",
    provider: "anthropic",
  }).generate({
    ...ultra,
    input: {
      ...ultra.input,
      model: { model: "claude-opus-4-8", provider: "anthropic" },
    },
  }, context());
  const directAnthropicHighOutcome = await createLLMModelDriver({
    anthropicMessagesClient: directAnthropicHigh,
    api: "anthropic-messages",
    baseURL: "https://api.anthropic.com",
    provider: "anthropic",
  }).generate({
    ...ultra,
    input: {
      ...ultra.input,
      model: { model: "claude-sonnet-4-6", provider: "anthropic" },
    },
  }, context());

  assert.equal(chatOutcome.status, "succeeded");
  assert.equal(anthropicOutcome.status, "succeeded");
  assert.equal(directOpenAIXHighOutcome.status, "succeeded");
  assert.equal(directOpenAIHighOutcome.status, "succeeded");
  assert.equal(directAnthropicXHighOutcome.status, "succeeded");
  assert.equal(directAnthropicHighOutcome.status, "succeeded");
  assert.equal(chatClient.body?.reasoning_effort, "xhigh");
  assert.deepEqual(anthropicClient.body?.thinking, { type: "adaptive" });
  assert.deepEqual(anthropicClient.body?.output_config, { effort: "high" });
  assert.equal(directOpenAIXHigh.body?.reasoning_effort, "xhigh");
  assert.equal(directOpenAIHigh.body?.reasoning_effort, "high");
  assert.deepEqual(directAnthropicXHigh.body?.output_config, {
    effort: "xhigh",
  });
  assert.deepEqual(directAnthropicHigh.body?.output_config, { effort: "high" });
  assert.deepEqual(chatClient.body?.messages[0], {
    content: "Use tools when useful.",
    role: "system",
  });
  assert.equal(anthropicClient.body?.system, "Use tools when useful.");
});

test("JX-PROV-007 JX-AC-052 both protocols materialize ordered image content and fail before dispatch when an Artifact is missing", async () => {
  const artifacts = new InMemoryEventStore();
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 9]);
  const reference = {
    byteLength: png.byteLength,
    digest: await artifactDigest(png),
    mediaType: "image/png" as const,
  };
  await artifacts.putArtifact(reference, png);
  const baseEffect = effect("fixture", "multimodal", null);
  const multimodalEffect: ModelGenerateEffect = {
    ...baseEffect,
    input: {
      ...baseEffect.input,
      messages: [{
        content: "before [pasted image 1] after",
        parts: [
          { text: "before ", type: "text" },
          { artifact: reference, placeholder: "pasted image 1", type: "image" },
          { text: " after", type: "text" },
        ],
        role: "user",
      }],
    },
  };
  const chatClient = new FakeOpenAIChatClient(chatChunks());
  const anthropicClient = new FakeAnthropicClient(anthropicEvents());
  const chat = createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://chat.example/v1",
    openAIChatCompletionsClient: chatClient,
    provider: "chat-provider",
  });
  const anthropic = createLLMModelDriver({
    anthropicMessagesClient: anthropicClient,
    api: "anthropic-messages",
    baseURL: "https://api.anthropic.test",
    provider: "anthropic",
  });

  assert.equal(
    (await chat.generate(multimodalEffect, context([], undefined, artifacts))).status,
    "succeeded",
  );
  assert.equal(
    (await anthropic.generate(
      multimodalEffect,
      context([], undefined, artifacts),
    )).status,
    "succeeded",
  );
  const encoded = Buffer.from(png).toString("base64");
  assert.deepEqual(chatClient.body?.messages[1], {
    content: [
      { text: "before ", type: "text" },
      {
        image_url: { url: `data:image/png;base64,${encoded}` },
        type: "image_url",
      },
      { text: " after", type: "text" },
    ],
    role: "user",
  });
  assert.deepEqual(anthropicClient.body?.messages[0], {
    content: [
      { text: "before ", type: "text" },
      {
        source: {
          data: encoded,
          media_type: "image/png",
          type: "base64",
        },
        type: "image",
      },
      { text: " after", type: "text" },
    ],
    role: "user",
  });

  const missingReference = {
    ...reference,
    digest: `sha256:${"0".repeat(64)}`,
  };
  const missingEffect: ModelGenerateEffect = {
    ...multimodalEffect,
    input: {
      ...multimodalEffect.input,
      messages: [{
        content: "[pasted image 1]",
        parts: [{
          artifact: missingReference,
          placeholder: "pasted image 1",
          type: "image",
        }],
        role: "user",
      }],
    },
  };
  const unusedChatClient = new FakeOpenAIChatClient(chatChunks());
  const unusedAnthropicClient = new FakeAnthropicClient(anthropicEvents());
  const missingChat = await createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://chat.example/v1",
    openAIChatCompletionsClient: unusedChatClient,
    provider: "chat-provider",
  }).generate(missingEffect, context([], undefined, artifacts));
  const missingAnthropic = await createLLMModelDriver({
    anthropicMessagesClient: unusedAnthropicClient,
    api: "anthropic-messages",
    baseURL: "https://api.anthropic.test",
    provider: "anthropic",
  }).generate(missingEffect, context([], undefined, artifacts));
  assert.equal(missingChat.status, "failed");
  assert.equal(missingAnthropic.status, "failed");
  assert.equal(unusedChatClient.body, undefined);
  assert.equal(unusedAnthropicClient.body, undefined);
});

test("JX-PLAN-008 JX-AC-031 active Plan exposes minimal abandon and derives its snapshot", async () => {
  const client = new FakeOpenAIChatClient([
    {
      choices: [{
        delta: {
          tool_calls: [{
            function: {
              arguments: JSON.stringify({
                operation: "abandon",
                steps: ["malformed fields are ignored for abandon"],
              }),
              name: PLAN_CONTROL.name,
            },
            id: "call-abandon",
            index: 0,
            type: "function",
          }],
        },
        finish_reason: "tool_calls",
        index: 0,
      }],
    },
    {
      choices: [],
      usage: { completion_tokens: 8, prompt_tokens: 24, total_tokens: 32 },
    },
  ]);
  const outcome = await createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://chat.example/v1",
    openAIChatCompletionsClient: client,
    provider: "chat-provider",
  }).generate(effect("chat-provider"), context());

  assert.equal(outcome.status, "succeeded");
  if (outcome.status !== "succeeded") return;
  assert.deepEqual(outcome.planRejections, []);
  assert.deepEqual(outcome.value.planUpdates, [{
    acceptanceCriteria: activePlan.acceptanceCriteria,
    assumptions: activePlan.assumptions,
    blockers: activePlan.blockers,
    nextAction: null,
    objective: activePlan.objective,
    operation: "abandon",
    steps: [{ ...activePlan.steps[0], status: "skipped" }],
  }]);
});

test("JX-PLAN-009 JX-AC-031 malformed Plan control preserves public text and Tools", async () => {
  const client = new FakeOpenAIChatClient([
    {
      choices: [{
        delta: {
          content: "The ordinary response remains usable.",
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({
                  ...planProposal,
                  operation: "revise",
                  steps: ["not-an-object"],
                }),
                name: PLAN_CONTROL.name,
              },
              id: "call-invalid-plan",
              index: 0,
              type: "function",
            },
            {
              function: { arguments: '{"path":"SPEC.md"}', name: "read" },
              id: "call-read-after-invalid-plan",
              index: 1,
              type: "function",
            },
          ],
        },
        finish_reason: "tool_calls",
        index: 0,
      }],
    },
    {
      choices: [],
      usage: { completion_tokens: 16, prompt_tokens: 40, total_tokens: 56 },
    },
  ]);
  const outcome = await createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://chat.example/v1",
    openAIChatCompletionsClient: client,
    provider: "chat-provider",
  }).generate(effect("chat-provider"), context());

  assert.equal(outcome.status, "succeeded");
  if (outcome.status !== "succeeded") return;
  assert.equal(outcome.value.content, "The ordinary response remains usable.");
  assert.deepEqual(outcome.value.planUpdates, []);
  assert.deepEqual(outcome.value.toolCalls, [{
    arguments: { path: "SPEC.md" },
    id: "call-read-after-invalid-plan",
    name: "read",
  }]);
  assert.equal(outcome.planRejections?.[0]?.code, "plan_update_invalid");
  assert.match(
    outcome.planRejections?.[0]?.message ?? "",
    /steps\[0\] must be a JSON object/,
  );
});

test("JX-PROV-002 JX-PROV-004 JX-PROV-005 JX-AC-016 Anthropic Messages groups Tool results and normalizes streaming usage", async () => {
  const client = new FakeAnthropicClient(anthropicEvents());
  const signals: Signal[] = [];
  const outcome = await createLLMModelDriver({
    anthropicMessagesClient: client,
    api: "anthropic-messages",
    baseURL: "https://api.anthropic.test",
    costCalculator: ({ usage }) => ({
      currency: "USD",
      pricingVersion: "anthropic-fixture-1",
      source: "calculator",
      usdNanos: usage.totalTokens * 10_000,
    }),
    provider: "anthropic",
  }).generate(
    effect(
      "anthropic",
      "claude-fixture",
      activePlan,
      planRejectionFeedback,
    ),
    context(signals),
  );

  assert.equal(outcome.status, "succeeded");
  if (outcome.status !== "succeeded") return;
  assert.deepEqual(outcome.accounting, {
    cost: {
      currency: "USD",
      pricingVersion: "anthropic-fixture-1",
      source: "calculator",
      usdNanos: 1_240_000,
    },
    usage: {
      cacheWriteTokens: 4,
      cachedInputTokens: 20,
      inputTokens: 104,
      outputTokens: 20,
      reasoningTokens: 7,
      totalTokens: 124,
    },
  });
  assert.deepEqual(outcome.value, {
    content: "I will read it.",
    planUpdates: [planProposal],
    toolCalls: [
      { arguments: { path: "SPEC.md" }, id: "call-next", name: "read" },
    ],
  });
  assert.equal(client.body?.max_tokens, 4096);
  assert.equal(client.body?.thinking, undefined);
  assert.equal(client.body?.output_config, undefined);
  assert.deepEqual(client.body?.messages.map((message) => message.role), [
    "user",
    "assistant",
    "user",
  ]);
  const resultMessage = client.body?.messages[2];
  assert.ok(Array.isArray(resultMessage?.content));
  assert.deepEqual(
    resultMessage.content.map((block) => block.type),
    ["tool_result", "tool_result"],
  );
  assert.ok(Array.isArray(client.body?.system));
  assert.equal(client.body.system[0]?.text, "Use tools when useful.");
  assert.match(client.body.system[1]?.text ?? "", /Current active Plan/);
  assert.match(
    client.body.system[1]?.text ?? "",
    /Continuation reason: plan_rejected/,
  );
  assert.match(
    client.body.system[1]?.text ?? "",
    /Remaining obligations: repair_plan_control, respond_or_act/,
  );
  assert.match(
    client.body.system[1]?.text ?? "",
    /Plan repair budget: attempt 1 of 1/,
  );
  assert.match(
    client.body.system[1]?.text ?? "",
    /call-invalid\.steps\[0\] must be a JSON object/,
  );
  assert.deepEqual(client.body.tools.map((tool) => tool.name), [
    "read",
    PLAN_CONTROL.name,
    PROGRESS_CONTROL.name,
  ]);
  assert.equal(signals[0]?.type, "model.output_text.delta");
  assert.equal(signals.at(-1)?.type, "model.progress");
});

test("JX-PROV-005 JX-MET-003 trusted OpenRouter usage.cost remains provider-reported", async () => {
  const client = new FakeOpenAIChatClient([
    {
      choices: [
        { delta: { content: "priced" }, finish_reason: "stop", index: 0 },
      ],
    },
    {
      choices: [],
      usage: {
        completion_tokens: 5,
        cost: 0.0042,
        prompt_tokens: 15,
      },
    },
  ]);
  const outcome = await createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://openrouter.ai/api/v1",
    openAIChatCompletionsClient: client,
    provider: "openrouter",
  }).generate(effect("openrouter", "fixture", null), context());

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(outcome.accounting?.cost, {
    currency: "USD",
    pricingVersion: null,
    source: "provider_reported",
    usdNanos: 4_200_000,
  });
  assert.equal(outcome.accounting?.usage?.totalTokens, 20);
});

function progressOnlyChatClient(): FakeOpenAIChatClient {
  return new FakeOpenAIChatClient([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({ message: "Preparing the answer" }),
                  name: PROGRESS_CONTROL.name,
                },
                id: "call-progress-only",
                index: 0,
                type: "function",
              },
            ],
          },
          finish_reason: "tool_calls",
          index: 0,
        },
      ],
    },
    {
      choices: [],
      usage: { completion_tokens: 4, prompt_tokens: 16, total_tokens: 20 },
    },
  ]);
}

function progressOnlyAnthropicClient(): FakeAnthropicClient {
  return new FakeAnthropicClient([
    {
      message: { usage: { input_tokens: 16, output_tokens: 1 } },
      type: "message_start",
    },
    {
      content_block: {
        id: "call-progress-only",
        input: { message: "Preparing the answer" },
        name: PROGRESS_CONTROL.name,
        type: "tool_use",
      },
      index: 0,
      type: "content_block_start",
    },
    {
      delta: { stop_reason: "tool_use" },
      type: "message_delta",
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ]);
}

test("JX-SIG-005 JX-AC-034 both protocols fail closed on progress-only output and persist model.failed", async () => {
  for (const [api, driver] of [
    [
      "openai-chat-completions",
      createLLMModelDriver({
        api: "openai-chat-completions",
        baseURL: "https://chat.example/v1",
        openAIChatCompletionsClient: progressOnlyChatClient(),
        provider: "chat",
      }),
    ],
    [
      "anthropic-messages",
      createLLMModelDriver({
        anthropicMessagesClient: progressOnlyAnthropicClient(),
        api: "anthropic-messages",
        baseURL: "https://anthropic.example",
        provider: "anthropic",
      }),
    ],
  ] as const) {
    const outcome = await driver.generate(effect(api, "fixture", null), context());
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") {
      assert.match(outcome.error.code, /_progress_only$/);
      assert.equal(outcome.error.retryable, false);
    }
  }

  const harness = createHarness({
    agent: defineAgent({
      instructions: "Answer directly.",
      model: { model: "fixture", provider: "chat" },
      tools: [],
    }),
    modelDrivers: {
      chat: createLLMModelDriver({
        api: "openai-chat-completions",
        baseURL: "https://chat.example/v1",
        openAIChatCompletionsClient: progressOnlyChatClient(),
        provider: "chat",
      }),
    },
  });
  const thread = await harness.createThread();
  const state = await thread.send("Answer the question");
  const events = await thread.events();
  assert.equal(state.status, "idle");
  assert.equal(state.error?.code, "chat_progress_only");
  assert.equal(events.filter((event) => event.type === "model.completed").length, 0);
  assert.equal(events.filter((event) => event.type === "model.failed").length, 1);
});

function sse(events: readonly unknown[]): string {
  return events
    .map((event) => `event: ${String((event as { type: string }).type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

test("JX-PROV-003 JX-PROV-006 JX-AC-016 native Anthropic client targets /v1/messages with required headers and parses SSE", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  let calls = 0;
  const fetchFixture: typeof fetch = async (input, init) => {
    calls += 1;
    requestUrl = input instanceof Request ? input.url : String(input);
    requestInit = init;
    return new Response(sse([
      {
        message: { usage: { input_tokens: 5, output_tokens: 1 } },
        type: "message_start",
      },
      {
        content_block: { text: "", type: "text" },
        index: 0,
        type: "content_block_start",
      },
      {
        delta: { text: "hello", type: "text_delta" },
        index: 0,
        type: "content_block_delta",
      },
      {
        delta: { stop_reason: "end_turn" },
        type: "message_delta",
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]), {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    });
  };
  const outcome = await createLLMModelDriver({
    api: "anthropic-messages",
    apiKey: "anthropic-secret",
    baseURL: "https://gateway.example/v1/",
    fetch: fetchFixture,
  }).generate(effect("anthropic", "claude-fixture", null), context());

  assert.equal(outcome.status, "succeeded");
  assert.equal(calls, 1);
  assert.equal(requestUrl, "https://gateway.example/v1/messages");
  assert.equal(requestInit?.method, "POST");
  assert.deepEqual(requestInit?.headers, {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "x-api-key": "anthropic-secret",
  });
  if (outcome.status === "succeeded") {
    assert.equal(outcome.value.content, "hello");
  }
});

test("JX-PROV-006 recognized OpenRouter Messages endpoint uses Bearer auth without duplicating the secret", async () => {
  let headers: HeadersInit | undefined;
  const fetchFixture: typeof fetch = async (_input, init) => {
    headers = init?.headers;
    return Response.json(
      { error: { message: "fixture rejection" } },
      { status: 401 },
    );
  };
  await createLLMModelDriver({
    api: "anthropic-messages",
    apiKey: "openrouter-secret",
    baseURL: "https://openrouter.ai/api/v1",
    fetch: fetchFixture,
  }).generate(effect("openrouter", "fixture", null), context());

  assert.deepEqual(headers, {
    "anthropic-version": "2023-06-01",
    authorization: "Bearer openrouter-secret",
    "content-type": "application/json",
  });
});

test("JX-PROV-003 JX-SEC-001 JX-AC-016 provider clients dispatch once and redact credentials on HTTP failure", async () => {
  for (const api of ["openai-chat-completions", "anthropic-messages"] as const) {
    let calls = 0;
    const secret = `${api}-secret`;
    const fetchFixture: typeof fetch = async () => {
      calls += 1;
      return Response.json(
        { error: { message: `credential ${secret} rejected` } },
        { status: 500 },
      );
    };
    const outcome = await createLLMModelDriver({
      api,
      apiKey: secret,
      baseURL: "https://failure.example/v1",
      fetch: fetchFixture,
      provider: api,
    }).generate(effect(api, "fixture", null), context());

    assert.equal(calls, 1, `${api} performed an internal retry`);
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") {
      assert.equal(outcome.error.code, `${api}_http_500`);
      assert.equal(outcome.error.retryable, true);
      assert.doesNotMatch(outcome.error.message, new RegExp(secret, "u"));
    }
  }
});

test("JX-PROV-002 JX-AC-016 mid-stream failures are typed without a fallback dispatch", async () => {
  let chatDispatches = 0;
  const chatClient: OpenAIChatCompletionsClient = {
    create() {
      chatDispatches += 1;
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [
              { delta: { content: "partial" }, finish_reason: null, index: 0 },
            ],
          };
          throw new Error("connection lost");
        },
      });
    },
  };
  const chatOutcome = await createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://chat.example/v1",
    openAIChatCompletionsClient: chatClient,
    provider: "chat",
  }).generate(effect("chat", "fixture", null), context());
  assert.equal(chatDispatches, 1);
  assert.equal(chatOutcome.status, "indeterminate");
  if (chatOutcome.status === "indeterminate") {
    assert.equal(chatOutcome.error.code, "chat_request_error");
  }

  let anthropicDispatches = 0;
  const anthropicClient: AnthropicMessagesClient = {
    create() {
      anthropicDispatches += 1;
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          yield {
            message: { usage: { input_tokens: 10, output_tokens: 1 } },
            type: "message_start",
          };
          yield {
            error: { message: "temporarily overloaded", type: "overloaded_error" },
            type: "error",
          };
        },
      });
    },
  };
  const anthropicOutcome = await createLLMModelDriver({
    anthropicMessagesClient: anthropicClient,
    api: "anthropic-messages",
    baseURL: "https://anthropic.example",
    provider: "anthropic",
  }).generate(effect("anthropic", "fixture", null), context());
  assert.equal(anthropicDispatches, 1);
  assert.equal(anthropicOutcome.status, "failed");
  if (anthropicOutcome.status === "failed") {
    assert.equal(anthropicOutcome.error.code, "overloaded_error");
    assert.equal(anthropicOutcome.error.retryable, true);
    assert.equal(anthropicOutcome.accounting?.usage?.totalTokens, 11);
  }
});

test("JX-PROV-002 JX-AC-016 cancellation is a typed non-retryable failure for both protocols", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  const abortingChat: OpenAIChatCompletionsClient = {
    create() {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    },
  };
  const abortingAnthropic: AnthropicMessagesClient = {
    create() {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    },
  };
  const drivers = [
    createLLMModelDriver({
      api: "openai-chat-completions",
      baseURL: "https://chat.example/v1",
      openAIChatCompletionsClient: abortingChat,
      provider: "chat",
    }),
    createLLMModelDriver({
      anthropicMessagesClient: abortingAnthropic,
      api: "anthropic-messages",
      baseURL: "https://anthropic.example",
      provider: "anthropic",
    }),
  ];

  for (const driver of drivers) {
    const outcome = await driver.generate(
      effect("fixture", "fixture", null),
      context([], cancellation.signal),
    );
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") {
      assert.match(outcome.error.code, /_cancelled$/);
      assert.equal(outcome.error.retryable, false);
    }
  }
});

test("JX-PROV-001 JX-AC-016 published surface contains only the unified two-protocol factory", () => {
  assert.equal(typeof createLLMModelDriver, "function");
  assert.equal("createOpenAIModelDriver" in llm, false);
  assert.equal("createOpenRouterModelDriver" in llm, false);
  assert.equal("createOpenAICompatibleModelDriver" in llm, false);
  assert.equal("OpenAIChatCompletionsModelDriver" in llm, false);
  assert.equal("AnthropicMessagesModelDriver" in llm, false);
  assert.throws(
    () => createLLMModelDriver({
      api: "anthropic-messages",
      apiKey: "fixture",
      baseURL: "https://anthropic.example",
      maxOutputTokens: 0,
    }),
    /positive integer/,
  );
  assert.throws(
    () => createLLMModelDriver({
      api: "openai-chat-completions",
      apiKey: "fixture",
      baseURL: "https://user:password@example.com/v1",
    }),
    /must not contain credentials/,
  );
  assert.throws(
    () => createLLMModelDriver({
      api: "responses" as never,
      apiKey: "fixture",
      baseURL: "https://api.example/v1",
    }),
    /Unsupported LLM API responses/,
  );
});

test("JX-PROV-002 JX-AC-019 LLM adapter registry is immutable and rejects invalid entries", () => {
  const driver = createLLMModelDriver({
    api: "openai-chat-completions",
    baseURL: "https://chat.example/v1",
    openAIChatCompletionsClient: new FakeOpenAIChatClient([]),
  });
  const adapter = createLLMAdapter({ fixture: driver });
  assert.equal(adapter.fixture, driver);
  assert.equal(Object.isFrozen(adapter), true);
  assert.throws(() => createLLMAdapter({}), /at least one/);
  assert.throws(() => createLLMAdapter({ "": driver }), /Invalid/);
});
