import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialThreadState,
  createThreadEvent,
  CURRENT_EVENT_SCHEMA_VERSION,
  decodeThreadEvent,
  DEFAULT_CONTEXT_POLICY,
  InMemoryEventStore,
  jsonDigest,
  reduce,
  SchemaValidationError,
  UnsupportedEventError,
} from "../src/index.ts";
import type { AnyThreadEvent } from "../src/index.ts";

const snapshot = {
  contextPolicy: DEFAULT_CONTEXT_POLICY,
  instructions: "Be precise.",
  model: { model: "deterministic", provider: "mock" },
  modelCapabilities: {
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    resolvedModel: "deterministic",
    schemaVersion: 1,
    source: { kind: "explicit", name: "core-store-test" },
  },
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

test("JX-AC-052 schema 5 remains text-only while schemas 6 and 7 accept Artifact references", () => {
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
  assert.deepEqual(
    decodeThreadEvent({ ...structuredInput, schemaVersion: 6 }),
    { ...structuredInput, schemaVersion: 6 },
  );
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

test("JX-AC-053 schema 7 requires mode while schema 6 remains readable as Standard", () => {
  const threadId = "thread-mode-schema";
  const created = createThreadEvent({
    id: "event-created",
    payload: { agent: snapshot },
    threadId,
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "thread.created",
  });
  const state = reduce(createInitialThreadState(threadId), created).state;
  const input = createThreadEvent({
    id: "event-input",
    payload: { content: "Use the selected mode" },
    threadId,
    sequence: 2,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "input.received",
  });
  const effect = reduce(state, input).effects[0];
  assert.equal(effect?.type, "model.generate");
  if (effect?.type !== "model.generate") return;
  const {
    contextManifest: _contextManifest,
    continuityHandoff: _continuityHandoff,
    mode: _mode,
    runtimeContext: _runtimeContext,
    ...legacyInput
  } = effect.input;
  const legacyRequested = {
    id: "event-requested",
    payload: { effect: { ...effect, input: legacyInput } },
    schemaVersion: 6,
    sequence: 3,
    threadId,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "model.requested",
  };

  assert.equal(decodeThreadEvent(legacyRequested).type, "model.requested");
  let legacyState = reduce(
    createInitialThreadState(threadId),
    decodeThreadEvent({
      ...created,
      payload: {
        agent: {
          instructions: snapshot.instructions,
          model: snapshot.model,
          tools: snapshot.tools,
        },
      },
      schemaVersion: 6,
    }),
  ).state;
  legacyState = reduce(
    legacyState,
    decodeThreadEvent({ ...input, schemaVersion: 6 }),
  ).state;
  legacyState = reduce(
    legacyState,
    decodeThreadEvent(legacyRequested),
  ).state;
  assert.equal(legacyState.mode, "standard");
  assert.notEqual(legacyState.pendingEffects[effect.id], undefined);
  assert.throws(
    () => decodeThreadEvent({ ...legacyRequested, schemaVersion: 7 }),
    SchemaValidationError,
  );
  const modeChanged = createThreadEvent({
    id: "event-mode",
    payload: { mode: "ultra" },
    threadId,
    sequence: 2,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "thread.mode_changed",
  });
  assert.throws(
    () => decodeThreadEvent({ ...modeChanged, schemaVersion: 6 }),
    SchemaValidationError,
  );
});

test("JX-AC-056 schema 8 Context drafts remain readable while schema 9 requires capability metadata", () => {
  assert.equal(CURRENT_EVENT_SCHEMA_VERSION, 9);
  const threadId = "thread-schema-8-context";
  const created = createThreadEvent({
    id: "event-created",
    payload: { agent: snapshot },
    threadId,
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "thread.created",
  });
  const legacyAgent = {
    contextPolicy: snapshot.contextPolicy,
    instructions: snapshot.instructions,
    model: snapshot.model,
    tools: snapshot.tools,
  };
  assert.equal(
    decodeThreadEvent({
      ...created,
      payload: { agent: legacyAgent },
      schemaVersion: 8,
    }).type,
    "thread.created",
  );
  assert.equal(
    decodeThreadEvent({
      ...created,
      payload: {
        agent: {
          instructions: snapshot.instructions,
          model: snapshot.model,
          tools: snapshot.tools,
        },
      },
      schemaVersion: 8,
    }).type,
    "thread.created",
  );
  assert.throws(
    () => decodeThreadEvent({
      ...created,
      payload: { agent: legacyAgent },
    }),
    SchemaValidationError,
  );

  const state = reduce(createInitialThreadState(threadId), created).state;
  const input = createThreadEvent({
    id: "event-input",
    payload: { content: "Continue the historical Thread" },
    threadId,
    sequence: 2,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "input.received",
  });
  const effect = reduce(state, input).effects[0];
  assert.equal(effect?.type, "model.generate");
  if (effect?.type !== "model.generate" || effect.input.contextManifest === undefined) {
    return;
  }
  const manifest = effect.input.contextManifest;
  const agentDigest = jsonDigest({
    contextPolicy: snapshot.contextPolicy,
    instructions: effect.input.instructions,
    model: effect.input.model,
    tools: effect.input.tools,
  });
  const sources = manifest.sources.map((source) =>
    source.kind === "agent"
      ? { ...source, digest: agentDigest, id: `agent:${agentDigest}` }
      : source,
  );
  const legacyManifest = {
    ...manifest,
    logicalRequestDigest: jsonDigest({
      activePlan: effect.input.activePlan,
      continuityHandoff: effect.input.continuityHandoff ?? null,
      contextPolicy: snapshot.contextPolicy,
      instructions: effect.input.instructions,
      messages: effect.input.messages,
      mode: effect.input.mode,
      model: effect.input.model,
      planControl: effect.input.planControl,
      planRejectionFeedback: effect.input.planRejectionFeedback ?? null,
      progressControl: effect.input.progressControl,
      runtime: effect.input.runtimeContext,
      tools: effect.input.tools,
    }),
    sources,
  };
  const {
    modelCapabilities: _modelCapabilities,
    ...boundedSchema8Manifest
  } = legacyManifest;
  const schema8Requested = {
    id: "event-requested",
    payload: {
      effect: {
        ...effect,
        input: {
          ...effect.input,
          contextManifest: boundedSchema8Manifest,
        },
      },
    },
    schemaVersion: 8,
    sequence: 3,
    threadId,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "model.requested",
  };
  assert.equal(decodeThreadEvent(schema8Requested).type, "model.requested");
  const {
    contextManifest: _contextManifest,
    continuityHandoff: _continuityHandoff,
    runtimeContext: _runtimeContext,
    ...earlySchema8Input
  } = effect.input;
  assert.equal(
    decodeThreadEvent({
      ...schema8Requested,
      payload: {
        effect: { ...effect, input: earlySchema8Input },
      },
    }).type,
    "model.requested",
  );
  assert.throws(
    () => decodeThreadEvent({
      ...schema8Requested,
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
    }),
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
