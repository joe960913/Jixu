import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHarness,
  defineAgent,
  defineSchema,
  defineTool,
  InMemoryEventStore,
} from "../src/index.ts";
import type {
  AgentConfig,
  JsonObject,
  ModelDriver,
  ModelOutcome,
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
    return value as JsonObject;
  },
});

const stringSchema = defineSchema<string>({
  jsonSchema: { type: "string" },
  parse(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("Expected a string");
    return value;
  },
});

function agentWith(driverTools: NonNullable<AgentConfig["tools"]> = []) {
  return defineAgent({
    instructions: "Be precise.",
    model: { model: "deterministic", provider: "mock" },
    tools: driverTools,
  });
}

test("JX-AC-001 JX-AC-002 JX-AC-014 Tool use and later send continue one Thread", async () => {
  const store = new InMemoryEventStore();
  const weather = defineTool({
    description: "Get weather",
    execute: async (_input, context) => {
      assert.equal((await store.read(context.threadId)).at(-1)?.type, "tool.requested");
      return "sunny";
    },
    input: objectSchema,
    name: "weather",
    output: stringSchema,
  });
  const model = new SequenceModelDriver([
    succeed({
      content: "",
      toolCalls: [
        { arguments: { city: "Shanghai" }, id: "weather-1", name: "weather" },
      ],
    }),
    succeed({ content: "Shanghai is sunny.", toolCalls: [] }),
    succeed({ content: "The strongest caveat is humidity.", toolCalls: [] }),
  ]);
  const harness = createHarness({
    agent: agentWith([weather]),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator(),
    modelDrivers: { mock: model },
    store,
  });

  const thread = await harness.createThread();
  await thread.send("What is the weather?");
  await thread.send("Challenge that answer.");

  assert.equal((await thread.state()).status, "idle");
  assert.equal(model.effects.length, 3);
  assert.deepEqual(model.effects[2]?.input.messages.slice(-2), [
    { content: "Shanghai is sunny.", role: "assistant", toolCalls: [] },
    { content: "Challenge that answer.", role: "user" },
  ]);
  assert.deepEqual(
    (await thread.events()).map((event) => event.type),
    [
      "thread.created",
      "input.received",
      "model.requested",
      "model.completed",
      "tool.requested",
      "tool.completed",
      "model.requested",
      "model.completed",
      "input.received",
      "model.requested",
      "model.completed",
    ],
  );
});

test("JX-AC-020 input accepted while running is durable and starts in Event order", async () => {
  let release!: (outcome: ModelOutcome) => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const effects: Parameters<ModelDriver["generate"]>[0][] = [];
  const driver: ModelDriver = {
    generate(effect) {
      effects.push(structuredClone(effect));
      if (effects.length === 1) {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(
        succeed({ content: "second reply", toolCalls: [] }),
      );
    },
  };
  const store = new InMemoryEventStore();
  const harness = createHarness({
    agent: agentWith(),
    modelDrivers: { mock: driver },
    store,
  });
  const thread = await harness.createThread();

  const first = thread.send("first");
  await firstStarted;
  const second = thread.send("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    (await thread.events())
      .filter((event) => event.type === "input.received")
      .map((event) => event.payload.content),
    ["first", "second"],
  );

  release(succeed({ content: "first reply", toolCalls: [] }));
  await Promise.all([first, second]);
  assert.equal((await thread.state()).status, "idle");
  assert.deepEqual(effects[1]?.input.messages.slice(-3), [
    { content: "first", role: "user" },
    { content: "first reply", role: "assistant", toolCalls: [] },
    { content: "second", role: "user" },
  ]);
});

test("JX-AC-003 clear retains Thread history but resets later model context", async () => {
  const model = new SequenceModelDriver([
    succeed({ content: "before", toolCalls: [] }),
    succeed({ content: "after", toolCalls: [] }),
  ]);
  const harness = createHarness({
    agent: agentWith(),
    modelDrivers: { mock: model },
  });
  const thread = await harness.createThread();
  await thread.send("old context");
  const id = thread.id;
  await thread.clear();
  await thread.send("fresh context");

  assert.equal(thread.id, id);
  assert.deepEqual(model.effects[1]?.input.messages, [
    { content: "fresh context", role: "user" },
  ]);
  assert.ok((await thread.events()).some((event) => event.type === "context.cleared"));
});

test("JX-API-004 Thread stream catches up Events and observes live Signals", async () => {
  const driver: ModelDriver = {
    async generate(effect, context) {
      context.signals.emit({
        data: { delta: "live" },
        kind: "signal",
        threadId: effect.threadId,
        type: "model.output_text.delta",
      });
      return succeed({ content: "done", toolCalls: [] });
    },
  };
  const harness = createHarness({
    agent: agentWith(),
    modelDrivers: { mock: driver },
  });
  const thread = await harness.createThread();
  const cancellation = new AbortController();
  const observed = [] as Array<{ readonly kind: string; readonly type?: string }>;
  const observation = (async () => {
    for await (const item of thread.stream({ signal: cancellation.signal })) {
      observed.push(
        item.kind === "event"
          ? { kind: item.kind, type: item.event.type }
          : { kind: item.kind, type: item.type },
      );
      if (item.kind === "event" && item.event.type === "model.completed") {
        cancellation.abort();
      }
    }
  })();

  await thread.send("observe");
  await observation;
  assert.ok(observed.some((item) => item.type === "thread.created"));
  assert.ok(observed.some((item) => item.type === "model.output_text.delta"));
  assert.equal(
    observed.filter((item) => item.type === "model.completed").length,
    1,
  );
});
