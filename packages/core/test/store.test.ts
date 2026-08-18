import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRunEvent,
  InMemoryEventStore,
  UnsupportedEventError,
} from "../src/index.ts";
import type { AnyRunEvent } from "../src/index.ts";

const snapshot = {
  instructions: "Be precise.",
  model: { model: "deterministic", provider: "mock" },
  tools: [],
} as const;

test("JX-AC-003 foundation: persisted Event schemas and types fail closed", async () => {
  const store = new InMemoryEventStore();
  await store.createRun("run-1");
  const created = createRunEvent({
    id: "event-1",
    payload: { agent: snapshot },
    runId: "run-1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "run.created",
  });
  await assert.rejects(
    store.append("run-1", 0, {
      ...created,
      schemaVersion: 2,
    } as unknown as AnyRunEvent),
    UnsupportedEventError,
  );
  await assert.rejects(
    store.append("run-1", 0, {
      ...created,
      type: "run.unknown",
    } as unknown as AnyRunEvent),
    UnsupportedEventError,
  );
  assert.equal((await store.read("run-1")).length, 0);
});
