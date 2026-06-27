import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createThreadEvent,
  decodeThreadEvent,
  InMemoryEventStore,
  replayEvents,
  UnsupportedEventError,
} from "../src/index.ts";
import type { AnyThreadEvent } from "../src/index.ts";

const snapshot = {
  instructions: "Be precise.",
  model: { model: "deterministic", provider: "mock" },
  tools: [],
} as const;

test("JX-AC-011 foundation: persisted Event schemas and types fail closed", async () => {
  const store = new InMemoryEventStore();
  await store.createThread("run-1");
  const created = createThreadEvent({
    id: "event-1",
    payload: { agent: snapshot },
    threadId: "run-1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "thread.created",
  });
  await assert.rejects(
    store.append("run-1", 0, {
      ...created,
      schemaVersion: 99,
    } as unknown as AnyThreadEvent),
    UnsupportedEventError,
  );
  await assert.rejects(
    store.append("run-1", 0, {
      ...created,
      type: "run.unknown",
    } as unknown as AnyThreadEvent),
    UnsupportedEventError,
  );
  assert.equal((await store.read("run-1")).length, 0);
});

test("JX-AC-011 JX-AC-028 schema v1 Thread Events upcast with unknown accounting", () => {
  const legacy = [
    {
      id: "event-1",
      payload: { agent: snapshot },
      schemaVersion: 1,
      sequence: 1,
      threadId: "run-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "thread.created",
    },
    {
      id: "event-2",
      payload: { content: "hello" },
      schemaVersion: 1,
      sequence: 2,
      threadId: "run-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "input.received",
    },
    {
      id: "event-3",
      payload: {
        effect: {
          attempt: 1,
          id: "event-2:effect:0",
          idempotencyKey: "event-2:effect:0",
          input: {
            instructions: "Be precise.",
            messages: [{ content: "hello", role: "user" }],
            model: snapshot.model,
            tools: [],
          },
          requestedByEventId: "event-2",
          threadId: "run-1",
          type: "model.generate",
        },
      },
      schemaVersion: 1,
      sequence: 3,
      threadId: "run-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "model.requested",
    },
    {
      id: "event-4",
      payload: {
        effectId: "event-2:effect:0",
        response: { content: "hi", toolCalls: [] },
      },
      schemaVersion: 1,
      sequence: 4,
      threadId: "run-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "model.completed",
    },
  ].map(decodeThreadEvent);

  const state = replayEvents("run-1", legacy);
  assert.equal(state.result, "hi");
  assert.equal(state.metrics.model.calls, 1);
  assert.equal(state.metrics.model.attempts, 1);
  assert.equal(state.metrics.model.succeeded, 1);
  assert.equal(state.metrics.tokens.missingReports, 1);
  assert.equal(state.metrics.cost.unpricedOutcomes, 1);
});
