import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialRunState,
  createRunEvent,
  reduce,
} from "../src/index.ts";

const snapshot = {
  instructions: "Be precise.",
  model: { model: "deterministic", provider: "mock" },
  tools: [],
} as const;

test("JX-AC-007 foundation: Reducer is deterministic and does not mutate input State", () => {
  const initial = createInitialRunState("run-1");
  const created = createRunEvent({
    id: "event-1",
    payload: { agent: snapshot },
    runId: "run-1",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "run.created",
  });
  const afterCreated = reduce(initial, created).state;
  const input = createRunEvent({
    id: "event-2",
    payload: { content: "hello" },
    runId: "run-1",
    sequence: 2,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "input.received",
  });
  const before = structuredClone(afterCreated);

  const first = reduce(afterCreated, input);
  const second = reduce(afterCreated, input);

  assert.deepEqual(first, second);
  assert.deepEqual(afterCreated, before);
  assert.equal(first.effects[0]?.id, "event-2:effect:0");
});
