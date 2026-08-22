import type { AgentDefinition } from "./agent.ts";
import { contextPolicyFor } from "./context-policy.ts";
import { modelCapabilityProfileFor } from "./model-capabilities.ts";
import { decodeThreadEvent } from "./codec.ts";
import {
  copyContextCompactionForFork,
  copyContinuityHandoffForFork,
  copyModelContextForFork,
} from "./context.ts";
import type { AcceptedContinuityHandoff } from "./context.ts";
import { createInitialThreadState } from "./domain.ts";
import type { ThreadState } from "./domain.ts";
import type { AgentSnapshot } from "./domain.ts";
import { EffectDispatcher } from "./effect-dispatcher.ts";
import {
  AgentMismatchError,
  InvalidForkPointError,
  InvalidTransitionError,
  ThreadNotFoundError,
} from "./errors.ts";
import { createThreadEvent } from "./events.ts";
import type { AnyThreadEvent } from "./events.ts";
import {
  assertJsonValue,
  canonicalJson,
  isJsonObject,
  jsonEquals,
} from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import {
  artifactDigest,
  CONTINUITY_HANDOFF_MEDIA_TYPE,
  prepareThreadInput,
} from "./input.ts";
import { ObservationBroker } from "./observation.ts";
import type {
  Clock,
  EventStore,
  IdGenerator,
  ModelDriver,
  SignalSink,
} from "./ports.ts";
import { reduce, replayEvents } from "./reducer.ts";
import { InMemoryEventStore } from "./store.ts";
import type { ForkOptions, Thread } from "./thread.ts";
import type { ToolPermissionPolicy } from "./tool-permissions.ts";
import {
  restoreThreadState,
  ThreadExecution,
} from "./thread-execution.ts";

class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

class RandomIdGenerator implements IdGenerator {
  next(prefix: "event" | "thread"): string {
    return `${prefix}_${crypto.randomUUID()}`;
  }
}

class NoopSignalSink implements SignalSink {
  emit(): void {}
}

function comparableAgentSnapshot(agent: AgentSnapshot): AgentSnapshot {
  const modelCapabilities = modelCapabilityProfileFor(agent.modelCapabilities);
  return {
    ...agent,
    contextPolicy: contextPolicyFor(agent.contextPolicy, modelCapabilities),
    modelCapabilities,
  };
}

export interface HarnessConfig {
  readonly agent: AgentDefinition;
  readonly checkpoints?: boolean;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly modelDrivers: Readonly<Record<string, ModelDriver>>;
  readonly signals?: SignalSink;
  readonly store?: EventStore;
  readonly toolPermissionPolicy?: ToolPermissionPolicy;
}

export class Harness {
  readonly #agent: AgentDefinition;
  readonly #checkpoints: boolean;
  readonly #clock: Clock;
  readonly #dispatcher: EffectDispatcher;
  readonly #ids: IdGenerator;
  readonly #observations = new ObservationBroker();
  readonly #openings = new Map<string, Promise<ThreadExecution>>();
  readonly #store: EventStore;
  readonly #threads = new Map<string, ThreadExecution>();

  constructor(config: HarnessConfig) {
    this.#agent = config.agent;
    this.#checkpoints = config.checkpoints ?? true;
    this.#clock = config.clock ?? new SystemClock();
    this.#ids = config.ids ?? new RandomIdGenerator();
    this.#store = config.store ?? new InMemoryEventStore();
    this.#dispatcher = new EffectDispatcher({
      agent: config.agent,
      artifacts: this.#store,
      modelDrivers: config.modelDrivers,
      observations: this.#observations,
      signals: config.signals ?? new NoopSignalSink(),
      ...(config.toolPermissionPolicy === undefined
        ? {}
        : { toolPermissionPolicy: config.toolPermissionPolicy }),
    });
  }

  async createThread(): Promise<Thread> {
    const threadId = this.#ids.next("thread");
    await this.#store.createThread(threadId);
    const thread = this.#execution(createInitialThreadState(threadId));
    try {
      await thread.initialize(this.#agent.snapshot);
    } catch (error) {
      this.#threads.delete(threadId);
      throw error;
    }
    return thread;
  }

  openThread(threadId: string): Promise<Thread> {
    return this.#open(threadId, true);
  }

  async listThreads(): Promise<readonly Thread[]> {
    const threads: Thread[] = [];
    for (const threadId of await this.#store.listThreads()) {
      const events = await this.#store.read(threadId, 1);
      const created = events[0];
      if (
        created?.type === "thread.created" &&
        jsonEquals(
          comparableAgentSnapshot(created.payload.agent),
          comparableAgentSnapshot(this.#agent.snapshot),
        )
      ) {
        threads.push(await this.#open(threadId, false));
      }
    }
    return threads;
  }

  async #open(
    threadId: string,
    startRecovery: boolean,
  ): Promise<ThreadExecution> {
    const cached = this.#threads.get(threadId);
    if (cached !== undefined) {
      if (startRecovery) cached.startRecovery();
      return cached;
    }

    let opening = this.#openings.get(threadId);
    if (opening === undefined) {
      opening = this.#restore(threadId);
      this.#openings.set(threadId, opening);
    }
    try {
      const thread = await opening;
      if (startRecovery) thread.startRecovery();
      return thread;
    } finally {
      if (this.#openings.get(threadId) === opening) {
        this.#openings.delete(threadId);
      }
    }
  }

  async #restore(threadId: string): Promise<ThreadExecution> {
    const events = await this.#store.read(threadId);
    if (events.length === 0) throw new ThreadNotFoundError(threadId);
    const state = await restoreThreadState(this.#store, threadId, events);
    if (
      state.agent === null ||
      !jsonEquals(
        comparableAgentSnapshot(state.agent),
        comparableAgentSnapshot(this.#agent.snapshot),
      )
    ) {
      throw new AgentMismatchError(threadId);
    }
    return this.#execution(state);
  }

  #execution(state: ThreadState): ThreadExecution {
    const thread = new ThreadExecution({
      checkpoints: this.#checkpoints,
      clock: this.#clock,
      dispatcher: this.#dispatcher,
      fork: (threadId, options) => this.#fork(threadId, options),
      ids: this.#ids,
      observations: this.#observations,
      state,
      store: this.#store,
    });
    this.#threads.set(thread.id, thread);
    return thread;
  }

  async #fork(parentThreadId: string, options: ForkOptions): Promise<Thread> {
    const preparedInput = await prepareThreadInput(options.input);
    for (const artifact of preparedInput.artifacts) {
      await this.#store.putArtifact(artifact.reference, artifact.bytes);
    }
    const parentEvents = await this.#store.read(parentThreadId);
    const forkIndex = parentEvents.findIndex((event) => event.id === options.at);
    if (forkIndex < 0) {
      throw new InvalidForkPointError(parentThreadId, options.at);
    }

    const childThreadId = this.#ids.next("thread");
    const copied = await this.#copyPrefix(
      parentEvents.slice(0, forkIndex + 1),
      childThreadId,
    );
    let state = replayEvents(childThreadId, copied);
    const parentEvent = parentEvents[forkIndex];
    if (parentEvent === undefined) {
      throw new InvalidForkPointError(parentThreadId, options.at);
    }

    const forked = decodeThreadEvent(
      createThreadEvent({
        id: this.#ids.next("event"),
        payload: {
          parentEventId: parentEvent.id,
          parentThreadId,
          parentSequence: parentEvent.sequence,
        },
        threadId: childThreadId,
        sequence: state.revision + 1,
        timestamp: this.#clock.now(),
        type: "thread.forked",
      }),
    );
    state = reduce(state, forked).state;

    const input = decodeThreadEvent(
      createThreadEvent({
        causationId: forked.id,
        id: this.#ids.next("event"),
        payload: preparedInput.payload,
        threadId: childThreadId,
        sequence: state.revision + 1,
        timestamp: this.#clock.now(),
        type: "input.received",
      }),
    );
    state = reduce(state, input).state;

    await this.#store.createFork(childThreadId, [...copied, forked, input]);
    const child = this.#execution(state);
    child.startRecovery();
    return child;
  }

  async #copyPrefix(
    parentEvents: readonly AnyThreadEvent[],
    childThreadId: string,
  ): Promise<readonly AnyThreadEvent[]> {
    const eventIds = new Map<string, string>();
    const effectIds = new Map<string, string>();
    for (const event of parentEvents) {
      eventIds.set(event.id, this.#ids.next("event"));
      if (
        event.type === "context.compaction_requested" ||
        event.type === "model.requested" ||
        event.type === "tool.requested"
      ) {
        const effect = event.payload.effect;
        if (effectIds.has(effect.id)) continue;
        const requestedByEventId = eventIds.get(effect.requestedByEventId);
        const prefix = `${effect.requestedByEventId}:effect:`;
        const effectId =
          requestedByEventId !== undefined && effect.id.startsWith(prefix)
            ? `${requestedByEventId}:effect:${effect.id.slice(prefix.length)}`
            : `${childThreadId}:fork-effect:${effectIds.size}`;
        effectIds.set(effect.id, effectId);
      }
    }

    const handoffs = new Map<string, AcceptedContinuityHandoff>();
    const copied: AnyThreadEvent[] = [];
    for (const event of parentEvents) {
      const id = eventIds.get(event.id);
      if (id === undefined) {
        throw new InvalidTransitionError(`Fork could not map Event ${event.id}`);
      }
      copied.push(decodeThreadEvent({
        id,
        payload: await this.#copyPayload(
          event,
          childThreadId,
          eventIds,
          effectIds,
          handoffs,
        ),
        threadId: childThreadId,
        schemaVersion: event.schemaVersion,
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
        ...(event.causationId === undefined
          ? {}
          : { causationId: eventIds.get(event.causationId) ?? event.causationId }),
        ...(event.correlationId === undefined
          ? {}
          : { correlationId: event.correlationId }),
      }));
    }
    return copied;
  }

  async #copyPayload(
    event: AnyThreadEvent,
    childThreadId: string,
    eventIds: ReadonlyMap<string, string>,
    effectIds: ReadonlyMap<string, string>,
    handoffs: Map<string, AcceptedContinuityHandoff>,
  ): Promise<JsonObject> {
    if (
      event.type === "context.compaction_requested" ||
      event.type === "model.requested" ||
      event.type === "tool.requested"
    ) {
      const effect = event.payload.effect;
      const id = effectIds.get(effect.id);
      if (id === undefined) {
        throw new InvalidTransitionError(`Fork could not map Effect ${effect.id}`);
      }
      return toJsonObject({
        effect: {
          ...effect,
          id,
          idempotencyKey: id,
          input: (() => {
            const mapEventId = (eventId: string) =>
              eventIds.get(eventId) ?? eventId;
            if (effect.type === "model.generate") {
              const digest = effect.input.contextManifest?.acceptedHandoffDigest;
              return copyModelContextForFork(
                effect.input,
                mapEventId,
                digest === null || digest === undefined
                  ? undefined
                  : handoffs.get(digest),
              );
            }
            if (effect.type === "context.compact") {
              const digest = effect.input.previousHandoff?.artifact.digest;
              const previous =
                digest === undefined ? null : handoffs.get(digest);
              if (digest !== undefined && previous === undefined) {
                throw new InvalidTransitionError(
                  `Fork could not map Continuity Handoff ${digest}`,
                );
              }
              return copyContextCompactionForFork(
                effect.input,
                mapEventId,
                childThreadId,
                previous ?? null,
              );
            }
            return effect.input;
          })(),
          requestedByEventId:
            eventIds.get(effect.requestedByEventId) ?? effect.requestedByEventId,
          threadId: childThreadId,
        },
      });
    }
    if (event.type === "context.compacted") {
      const effectId = effectIds.get(event.payload.effectId);
      if (effectId === undefined) {
        throw new InvalidTransitionError(
          `Fork Event ${event.id} has no copied Context Effect request`,
        );
      }
      const previousDigest = event.payload.handoff.previousHandoffDigest;
      const copiedPrevious =
        previousDigest === null ? undefined : handoffs.get(previousDigest);
      if (previousDigest !== null && copiedPrevious === undefined) {
        throw new InvalidTransitionError(
          `Fork could not map previous Continuity Handoff ${previousDigest}`,
        );
      }
      const handoff = copyContinuityHandoffForFork(
        event.payload.handoff,
        (eventId) => eventIds.get(eventId) ?? eventId,
        childThreadId,
        copiedPrevious?.artifact.digest ?? null,
      );
      const bytes = new TextEncoder().encode(
        canonicalJson(handoff as unknown as JsonValue),
      );
      const artifact = {
        byteLength: bytes.byteLength,
        digest: await artifactDigest(bytes),
        mediaType: CONTINUITY_HANDOFF_MEDIA_TYPE,
      } as const;
      await this.#store.putArtifact(artifact, bytes);
      handoffs.set(event.payload.artifact.digest, { artifact, handoff });
      return toJsonObject({
        ...event.payload,
        artifact,
        effectId,
        handoff,
      });
    }
    if (
      event.type === "context.compaction_failed" ||
      event.type === "model.cancelled" ||
      event.type === "model.completed" ||
      event.type === "model.failed" ||
      event.type === "approval.requested" ||
      event.type === "approval.decided" ||
      event.type === "tool.cancelled" ||
      event.type === "tool.completed" ||
      event.type === "tool.failed" ||
      event.type === "thread.waiting"
    ) {
      const effectId = effectIds.get(event.payload.effectId);
      if (effectId === undefined) {
        throw new InvalidTransitionError(
          `Fork Event ${event.id} has no copied Effect request`,
        );
      }
      return toJsonObject({ ...event.payload, effectId });
    }
    return toJsonObject(event.payload);
  }
}

function toJsonObject(value: unknown): JsonObject {
  assertJsonValue(value, "Fork Event payload");
  if (!isJsonObject(value)) {
    throw new InvalidTransitionError("Fork Event payload must be a JSON object");
  }
  return value;
}

export function createHarness(config: HarnessConfig): Harness {
  return new Harness(config);
}
