import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artifactDigest,
  createThreadEvent,
  jsonDigest,
  REDUCER_VERSION,
  replayEvents,
} from "jixu-core";
import type {
  AnyThreadEvent,
  EventStore,
} from "jixu-core";

export interface StoreContractFixture {
  readonly cleanup?: () => Promise<void> | void;
  readonly store: EventStore;
}

export type StoreContractFactory = () =>
  | Promise<StoreContractFixture>
  | StoreContractFixture;

const snapshot = {
  instructions: "Be precise.",
  model: { model: "deterministic", provider: "mock" },
  tools: [],
} as const;

function created(threadId: string, eventId: string): AnyThreadEvent {
  return createThreadEvent({
    id: eventId,
    payload: { agent: snapshot },
    threadId,
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "thread.created",
  });
}

function hasErrorCode(expectedCode: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === expectedCode;
}

export function defineStoreContract(
  name: string,
  factory: StoreContractFactory,
): void {
  test(`JX-AC-012 ${name}: create, immutable append, and revision conflict`, async () => {
    const fixture = await factory();
    try {
      const { store } = fixture;
      await store.createThread("run-contract");
      await assert.rejects(
        store.createThread("run-contract"),
        hasErrorCode("thread_already_exists"),
      );
      const first = created("run-contract", "event-contract-1");
      await store.append("run-contract", 0, first);

      const read = await store.read("run-contract");
      const mutable = read[0] as unknown as {
        payload: { agent: { instructions: string } };
      };
      mutable.payload.agent.instructions = "mutated outside Store";
      const stored = (await store.read("run-contract"))[0];
      assert.equal(stored?.type, "thread.created");
      assert.ok(stored !== undefined && stored.type === "thread.created");
      assert.equal(stored.payload.agent.instructions, "Be precise.");

      const competing = createThreadEvent({
        id: "event-contract-2",
        payload: { content: "stale" },
        threadId: "run-contract",
        sequence: 2,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "input.received",
      });
      const results = await Promise.allSettled([
        store.append("run-contract", 1, competing),
        store.append("run-contract", 1, {
          ...competing,
          id: "event-contract-3",
          payload: { content: "winner" },
        }),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected !== undefined && rejected.status === "rejected");
      assert.ok(hasErrorCode("revision_conflict")(rejected.reason));
    } finally {
      await fixture.cleanup?.();
    }
  });

  test(`JX-AC-006 ${name}: Fork creation is atomic and independently readable`, async () => {
    const fixture = await factory();
    try {
      const { store } = fixture;
      const event = created("fork-contract", "fork-event-1");
      await store.createFork("fork-contract", [event]);
      assert.deepEqual(await store.read("fork-contract"), [event]);
      assert.deepEqual(await store.listThreads(), ["fork-contract"]);

      const invalid = {
        ...created("partial-fork", "partial-event-1"),
        sequence: 2,
      };
      await assert.rejects(store.createFork("partial-fork", [invalid]));
      await assert.rejects(
        store.read("partial-fork"),
        hasErrorCode("thread_not_found"),
      );
    } finally {
      await fixture.cleanup?.();
    }
  });

  test(`JX-AC-008 ${name}: Checkpoint round-trips without becoming authority`, async () => {
    const fixture = await factory();
    try {
      const { store } = fixture;
      await store.createThread("checkpoint-contract");
      const event = created("checkpoint-contract", "checkpoint-event-1");
      await store.append("checkpoint-contract", 0, event);
      const state = replayEvents("checkpoint-contract", [event]);
      const checkpoint = {
        eventId: event.id,
        eventSchemaVersion: 1,
        reducerVersion: REDUCER_VERSION,
        threadId: "checkpoint-contract",
        sequence: 1,
        state,
        stateDigest: jsonDigest(state),
      } as const;
      await store.writeCheckpoint(checkpoint);
      assert.deepEqual(await store.readCheckpoint("checkpoint-contract"), checkpoint);
    } finally {
      await fixture.cleanup?.();
    }
  });

  test(`JX-AC-012 ${name}: Event IDs are unique across Threads`, async () => {
    const fixture = await factory();
    try {
      const { store } = fixture;
      await store.createThread("global-id-a");
      await store.createThread("global-id-b");
      await store.append("global-id-a", 0, created("global-id-a", "global-event"));
      await assert.rejects(
        store.append("global-id-b", 0, created("global-id-b", "global-event")),
      );
      assert.equal((await store.read("global-id-b")).length, 0);
    } finally {
      await fixture.cleanup?.();
    }
  });

  test(`JX-AC-052 ${name}: image Artifacts are immutable and verified on read`, async () => {
    const fixture = await factory();
    try {
      const { store } = fixture;
      const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
      const reference = {
        byteLength: bytes.byteLength,
        digest: await artifactDigest(bytes),
        mediaType: "image/png" as const,
      };

      await store.putArtifact(reference, bytes);
      bytes[8] = 2;
      const firstRead = await store.readArtifact(reference);
      assert.equal(firstRead[8], 1);
      firstRead[8] = 3;
      assert.equal((await store.readArtifact(reference))[8], 1);
      await store.putArtifact(
        reference,
        Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
      );

      await assert.rejects(
        store.readArtifact({ ...reference, digest: `sha256:${"0".repeat(64)}` }),
        hasErrorCode("artifact_missing"),
      );
      await assert.rejects(
        store.putArtifact(reference, Uint8Array.from([255, 216, 255])),
        hasErrorCode("artifact_corrupt"),
      );
    } finally {
      await fixture.cleanup?.();
    }
  });
}
