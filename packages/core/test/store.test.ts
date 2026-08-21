import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialThreadState,
  createThreadEvent,
  decodeThreadEvent,
  InMemoryEventStore,
  reduce,
  SchemaValidationError,
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
  for (const schemaVersion of [1, 2]) {
    assert.throws(
      () => decodeThreadEvent({ ...created, schemaVersion }),
      UnsupportedEventError,
    );
  }
  assert.equal((await store.read("run-1")).length, 0);
});

test("JX-AC-052 schema 5 remains text-only while schema 6 accepts Artifact references", () => {
  const textInput = createThreadEvent({
    id: "event-text",
    payload: { content: "legacy text" },
    threadId: "thread-input-schema",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "input.received",
  });
  const decodedTextInput = decodeThreadEvent({ ...textInput, schemaVersion: 5 });
  assert.equal(decodedTextInput.type, "input.received");
  if (decodedTextInput.type !== "input.received") return;
  assert.equal(decodedTextInput.payload.content, "legacy text");

  const structuredInput = createThreadEvent({
    id: "event-structured",
    payload: {
      content: "inspect [pasted image 1]",
      parts: [
        { text: "inspect ", type: "text" },
        {
          artifact: {
            byteLength: 9,
            digest: `sha256:${"0".repeat(64)}`,
            mediaType: "image/png",
          },
          placeholder: "pasted image 1",
          type: "image",
        },
      ],
    },
    threadId: "thread-input-schema",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "input.received",
  });
  assert.deepEqual(decodeThreadEvent(structuredInput), structuredInput);
  assert.throws(
    () => decodeThreadEvent({ ...structuredInput, schemaVersion: 5 }),
    SchemaValidationError,
  );

  const created = createThreadEvent({
    id: "event-created",
    payload: { agent: snapshot },
    threadId: "thread-input-schema",
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "thread.created",
  });
  const afterCreated = reduce(
    createInitialThreadState("thread-input-schema"),
    created,
  ).state;
  const reducedInput = reduce(afterCreated, {
    ...structuredInput,
    sequence: 2,
  });
  const effect = reducedInput.effects[0];
  assert.equal(effect?.type, "model.generate");
  if (effect?.type !== "model.generate") return;
  const requested = createThreadEvent({
    id: "event-requested",
    payload: { effect },
    threadId: "thread-input-schema",
    sequence: 3,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "model.requested",
  });
  assert.throws(
    () => decodeThreadEvent({ ...requested, schemaVersion: 5 }),
    SchemaValidationError,
  );
});

test("JX-AC-049 Context Manifest fails closed when the logical request digest drifts", () => {
  const threadId = "thread-context-manifest";
  const created = createThreadEvent({
    id: "event-1",
    payload: { agent: snapshot },
    threadId,
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "thread.created",
  });
  const afterCreated = reduce(
    createInitialThreadState(threadId),
    created,
  ).state;
  const input = createThreadEvent({
    id: "event-2",
    payload: { content: "Continue" },
    threadId,
    sequence: 2,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "input.received",
  });
  const effect = reduce(afterCreated, input).effects[0];
  assert.equal(effect?.type, "model.generate");
  if (effect?.type !== "model.generate") return;
  assert.notEqual(effect.input.contextManifest, undefined);
  if (effect.input.contextManifest === undefined) return;
  const requested = createThreadEvent({
    id: "event-3",
    payload: {
      effect: {
        ...effect,
        input: {
          ...effect.input,
          contextManifest: {
            ...effect.input.contextManifest,
            logicalRequestDigest: "tampered",
          },
        },
      },
    },
    threadId,
    sequence: 3,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "model.requested",
  });

  assert.throws(() => decodeThreadEvent(requested), SchemaValidationError);

  const driftedSource = createThreadEvent({
    id: "event-3",
    payload: {
      effect: {
        ...effect,
        input: {
          ...effect.input,
          contextManifest: {
            ...effect.input.contextManifest,
            sources: effect.input.contextManifest.sources.map((source, index) =>
              index === 0 ? { ...source, digest: "tampered" } : source,
            ),
          },
        },
      },
    },
    threadId,
    sequence: 3,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "model.requested",
  });
  assert.throws(() => decodeThreadEvent(driftedSource), SchemaValidationError);
});
