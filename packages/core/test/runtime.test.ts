import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRuntime,
  defineAgent,
  defineSchema,
  defineTool,
  InMemoryEventStore,
} from "../src/index.ts";
import type { JsonObject } from "../src/index.ts";
import type {
  ModelDriver,
  ModelGenerateEffect,
  ModelOutcome,
  RunStreamItem,
} from "../src/index.ts";
import {
  FixedClock,
  SequenceIdGenerator,
  SequenceModelDriver,
  succeed,
} from "../../testkit/src/index.ts";

const objectSchema = defineSchema<JsonObject>({
  jsonSchema: { type: "object" },
  parse(value: unknown): JsonObject {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Expected an object");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.city !== "string") {
      throw new TypeError("city must be a string");
    }
    return { city: record.city };
  },
});

const stringSchema = defineSchema<string>({
  jsonSchema: { type: "string" },
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("Expected a string");
    }
    return value;
  },
});

test("JX-AC-001 basic model -> Tool -> model loop is durably ordered", async () => {
  const store = new InMemoryEventStore();
  let toolCalls = 0;
  const weather = defineTool({
    description: "Get current weather",
    execute: async (input, context) => {
      toolCalls += 1;
      assert.equal(input.city, "Shanghai");
      const eventsBeforeExecution = await store.read(context.runId);
      assert.equal(eventsBeforeExecution.at(-1)?.type, "tool.requested");
      return "sunny";
    },
    idempotency: "idempotent",
    input: objectSchema,
    name: "weather",
    output: stringSchema,
  });
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [
        {
          arguments: { city: "Shanghai" },
          id: "call-weather",
          name: "weather",
        },
      ],
    }),
    succeed({ content: "Shanghai is sunny.", toolCalls: [] }),
  ]);
  const runtime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
    store,
  });
  const agent = defineAgent({
    instructions: "Answer with tools when useful.",
    model: { model: "deterministic", provider: "mock" },
    tools: [weather],
  });

  const run = await runtime.run(agent, "What is the weather in Shanghai?");
  await run.wait();

  assert.equal(toolCalls, 1);
  assert.equal(model.effects.length, 2);
  assert.deepEqual(model.effects[1]?.input.messages.at(-1), {
    name: "weather",
    output: "sunny",
    role: "tool",
    toolCallId: "call-weather",
  });
  assert.deepEqual(
    (await run.events()).map((event) => event.type),
    [
      "run.created",
      "input.received",
      "model.requested",
      "model.completed",
      "tool.requested",
      "tool.completed",
      "model.requested",
      "model.completed",
    ],
  );
  assert.deepEqual(await run.state(), {
    agent: agent.snapshot,
    error: null,
    lineage: null,
    messages: [
      { content: "What is the weather in Shanghai?", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [
          {
            arguments: { city: "Shanghai" },
            id: "call-weather",
            name: "weather",
          },
        ],
      },
      {
        name: "weather",
        output: "sunny",
        role: "tool",
        toolCallId: "call-weather",
      },
      {
        content: "Shanghai is sunny.",
        role: "assistant",
        toolCalls: [],
      },
    ],
    pauseRequested: false,
    pendingEffects: {},
    readyEffects: [],
    result: "Shanghai is sunny.",
    revision: 8,
    runId: run.id,
    status: "completed",
    waitingReason: null,
  });
});

test("JX-AC-001 all Tool requests commit before the first Tool dispatch", async () => {
  const store = new InMemoryEventStore();
  const observedRequestCounts: number[] = [];
  const makeTool = (name: string) =>
    defineTool({
      description: name,
      execute: async (_input, context) => {
        const events = await store.read(context.runId);
        observedRequestCounts.push(
          events.filter((event) => event.type === "tool.requested").length,
        );
        return `${name}-result`;
      },
      input: objectSchema,
      name,
      output: stringSchema,
    });
  const first = makeTool("first");
  const second = makeTool("second");
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [
        { arguments: { city: "A" }, id: "call-1", name: "first" },
        { arguments: { city: "B" }, id: "call-2", name: "second" },
      ],
    }),
    succeed({ content: "done", toolCalls: [] }),
  ]);
  const runtime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
    store,
  });

  const run = await runtime.run(
    defineAgent({
      instructions: "Use both tools.",
      model: { model: "deterministic", provider: "mock" },
      tools: [first, second],
    }),
    "run both",
  );
  await run.wait();

  assert.deepEqual(observedRequestCounts, [2, 2]);
  assert.equal((await run.state()).status, "completed");
});

test("JX-AC-001 invalid Tool input fails durably without executing the Tool", async () => {
  let executions = 0;
  const tool = defineTool({
    description: "Requires a city",
    execute: () => {
      executions += 1;
      return "unused";
    },
    input: objectSchema,
    name: "weather",
    output: stringSchema,
  });
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [
        { arguments: { city: 42 }, id: "bad-call", name: "weather" },
      ],
    }),
  ]);
  const runtime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
  });

  const run = await runtime.run(
    defineAgent({
      instructions: "Use tools.",
      model: { model: "deterministic", provider: "mock" },
      tools: [tool],
    }),
    "bad input",
  );
  await run.wait();

  const state = await run.state();
  assert.equal(executions, 0);
  assert.equal(state.status, "failed");
  assert.equal(state.error?.code, "tool_input_invalid");
  assert.equal((await run.events()).at(-1)?.type, "tool.failed");
});

test("JX-AC-002 JX-API-008 Run stream catches up Events then observes live Signals without duplicate Events", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const driver: ModelDriver = {
    async generate(effect, context): Promise<ModelOutcome> {
      await gate;
      context.signals.emit({
        data: { delta: "done" },
        kind: "signal",
        runId: effect.runId,
        type: "model.output_text.delta",
      });
      return succeed({ content: "done", toolCalls: [] });
    },
  };
  const runtime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: driver },
  });
  const run = await runtime.run(
    defineAgent({
      instructions: "Answer once.",
      model: { model: "deterministic", provider: "mock" },
    }),
    "go",
  );

  const items: RunStreamItem[] = [];
  const observation = (async () => {
    for await (const item of run.stream()) items.push(item);
  })();
  release();
  await run.wait();
  await observation;

  const events = items.flatMap((item) =>
    item.kind === "event" ? [item.event] : [],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.created", "input.received", "model.requested", "model.completed"],
  );
  assert.deepEqual(
    items.filter((item) => item.kind === "signal"),
    [
      {
        data: { delta: "done" },
        kind: "signal",
        runId: run.id,
        type: "model.output_text.delta",
      },
    ],
  );
});

test("JX-API-008 Run stream can be stopped with an AbortSignal", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const driver: ModelDriver = {
    async generate(_effect: ModelGenerateEffect): Promise<ModelOutcome> {
      await gate;
      return succeed({ content: "done", toolCalls: [] });
    },
  };
  const runtime = createRuntime({
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: driver },
  });
  const run = await runtime.run(
    defineAgent({
      instructions: "Answer once.",
      model: { model: "deterministic", provider: "mock" },
    }),
    "go",
  );
  const cancellation = new AbortController();
  let observedEvents = 0;
  await (async () => {
    for await (const item of run.stream({ signal: cancellation.signal })) {
      if (item.kind === "event") observedEvents += 1;
      if (observedEvents === 2) cancellation.abort();
    }
  })();

  assert.equal(observedEvents, 2);
  release();
  await run.wait();
});
