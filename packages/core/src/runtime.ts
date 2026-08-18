import type { AgentDefinition, ExecutableTool } from "./agent.ts";
import { decodeCheckpoint, decodeRunEvent } from "./codec.ts";
import {
  createInitialRunState,
  parseModelResponse,
} from "./domain.ts";
import type { Checkpoint, DriverError, RunState } from "./domain.ts";
import type {
  EffectRequest,
  ModelGenerateEffect,
  ModelOutcome,
  ToolExecuteEffect,
} from "./effects.ts";
import {
  AgentMismatchError,
  InvalidForkPointError,
  InvalidTransitionError,
  RunNotFoundError,
} from "./errors.ts";
import { createRunEvent } from "./events.ts";
import type {
  AnyRunEvent,
  RunEventPayloads,
  RunEventType,
} from "./events.ts";
import {
  assertJsonValue,
  cloneJson,
  isJsonObject,
  jsonDigest,
  jsonEquals,
} from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type {
  Clock,
  EventStore,
  IdGenerator,
  ModelDriver,
  RunStreamItem,
  Signal,
  SignalSink,
} from "./ports.ts";
import { REDUCER_VERSION, reduce, replayEvents } from "./reducer.ts";
import { InMemoryEventStore } from "./store.ts";

class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

class RandomIdGenerator implements IdGenerator {
  next(prefix: "event" | "run"): string {
    return `${prefix}_${crypto.randomUUID()}`;
  }
}

class NoopSignalSink implements SignalSink {
  emit(): void {}
}

export interface RuntimeConfig {
  readonly checkpoints?: boolean;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly modelDrivers: Readonly<Record<string, ModelDriver>>;
  readonly signals?: SignalSink;
  readonly store?: EventStore;
}

export interface ForkOptions {
  readonly at: string;
  readonly input: string;
}

export interface RunHandle {
  readonly id: string;
  events(): Promise<readonly AnyRunEvent[]>;
  fork(options: ForkOptions): Promise<RunHandle>;
  pause(): Promise<RunState>;
  replay(): Promise<RunState>;
  resume(): Promise<void>;
  state(): Promise<RunState>;
  stream(options?: RunStreamOptions): AsyncIterable<RunStreamItem>;
  wait(): Promise<RunState>;
}

export interface RunStreamOptions {
  readonly fromSequence?: number;
  readonly signal?: AbortSignal;
}

interface PreparedEffect {
  readonly effect: EffectRequest;
  readonly requestEventId: string;
}

type OutcomeProposal = {
  [TType in
    | "model.completed"
    | "model.failed"
    | "tool.completed"
    | "tool.failed"]: {
    readonly payload: RunEventPayloads[TType];
    readonly type: TType;
  };
}[
  | "model.completed"
  | "model.failed"
  | "tool.completed"
  | "tool.failed"];

function driverError(code: string, message: string, retryable: boolean): DriverError {
  return { code, message, retryable };
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Driver error";
}

function terminal(status: RunState["status"]): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}

function toJsonObject(value: unknown, label: string): JsonObject {
  assertJsonValue(value, label);
  if (!isJsonObject(value)) {
    throw new InvalidTransitionError(`${label} must be a JSON object`);
  }
  return value;
}

class ObservationQueue {
  readonly #items: RunStreamItem[] = [];
  readonly #waiters: Array<(item: RunStreamItem | null) => void> = [];
  #closed = false;

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }

  drain(): readonly RunStreamItem[] {
    return this.#items.splice(0);
  }

  next(): Promise<RunStreamItem | null> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  push(item: RunStreamItem): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter(item);
  }
}

class ObservationBroker {
  readonly #queues = new Map<string, Set<ObservationQueue>>();

  publish(runId: string, item: RunStreamItem): void {
    for (const queue of this.#queues.get(runId) ?? []) queue.push(item);
  }

  subscribe(runId: string): {
    readonly dispose: () => void;
    readonly queue: ObservationQueue;
  } {
    const queue = new ObservationQueue();
    const queues = this.#queues.get(runId) ?? new Set<ObservationQueue>();
    queues.add(queue);
    this.#queues.set(runId, queues);
    return {
      dispose: () => {
        queue.close();
        queues.delete(queue);
        if (queues.size === 0) this.#queues.delete(runId);
      },
      queue,
    };
  }
}

export class Runtime {
  readonly #active = new Set<string>();
  readonly #agents = new Map<string, AgentDefinition>();
  readonly #checkpoints: boolean;
  readonly #clock: Clock;
  readonly #commitTails = new Map<string, Promise<void>>();
  readonly #executions = new Map<string, Promise<void>>();
  readonly #ids: IdGenerator;
  readonly #modelDrivers: Readonly<Record<string, ModelDriver>>;
  readonly #observations = new ObservationBroker();
  readonly #pauseRequests = new Map<string, Promise<void>>();
  readonly #signals: SignalSink;
  readonly #states = new Map<string, RunState>();
  readonly #store: EventStore;

  constructor(config: RuntimeConfig) {
    this.#checkpoints = config.checkpoints ?? true;
    this.#clock = config.clock ?? new SystemClock();
    this.#ids = config.ids ?? new RandomIdGenerator();
    this.#modelDrivers = config.modelDrivers;
    this.#signals = config.signals ?? new NoopSignalSink();
    this.#store = config.store ?? new InMemoryEventStore();
  }

  async run(agent: AgentDefinition, input: string): Promise<RunHandle> {
    const runId = this.#ids.next("run");
    await this.#store.createRun(runId);
    this.#agents.set(runId, agent);
    this.#states.set(runId, createInitialRunState(runId));

    await this.#commit(runId, "run.created", { agent: agent.snapshot });
    await this.#commit(runId, "input.received", { content: input });
    this.#schedule(runId);
    return this.#handle(runId);
  }

  async recover(agent: AgentDefinition, runId: string): Promise<RunHandle> {
    const events = await this.#store.read(runId);
    if (events.length === 0) {
      throw new RunNotFoundError(runId);
    }
    const state = await this.#restoreState(runId, events);
    if (state.agent === null || !jsonEquals(state.agent, agent.snapshot)) {
      throw new AgentMismatchError(runId);
    }
    this.#agents.set(runId, agent);
    this.#states.set(runId, state);
    if (state.status === "running") {
      this.#schedule(runId);
    }
    return this.#handle(runId);
  }

  #handle(runId: string): RunHandle {
    return {
      id: runId,
      events: () => this.#store.read(runId),
      fork: (options) => this.#fork(runId, options),
      pause: () => this.#pause(runId),
      replay: () => this.#replay(runId),
      resume: () => this.#resume(runId),
      state: () => this.#getState(runId),
      stream: (options) => this.#stream(runId, options),
      wait: () => this.#wait(runId),
    };
  }

  async *#stream(
    runId: string,
    options: RunStreamOptions = {},
  ): AsyncIterable<RunStreamItem> {
    if (!this.#states.has(runId)) throw new RunNotFoundError(runId);
    const fromSequence = options.fromSequence ?? 1;
    if (!Number.isInteger(fromSequence) || fromSequence < 1) {
      throw new RangeError("Run stream fromSequence must be a positive integer");
    }

    const subscription = this.#observations.subscribe(runId);
    const abort = () => subscription.queue.close();
    const aborted = () => options.signal?.aborted ?? false;
    options.signal?.addEventListener("abort", abort, { once: true });
    let lastSequence = fromSequence - 1;

    const observe = (item: RunStreamItem): RunStreamItem | null => {
      if (item.kind === "event") {
        if (item.event.sequence <= lastSequence) return null;
        lastSequence = item.event.sequence;
      }
      return cloneJson(item);
    };

    try {
      if (aborted()) return;
      for (const event of await this.#store.read(runId, fromSequence)) {
        if (aborted()) return;
        lastSequence = event.sequence;
        yield { event: cloneJson(event), kind: "event" };
        if (aborted()) return;
      }

      for (const queued of subscription.queue.drain()) {
        if (aborted()) return;
        const item = observe(queued);
        if (item !== null) yield item;
      }
      if (terminal((await this.#getState(runId)).status)) return;

      while (true) {
        const queued = await subscription.queue.next();
        if (queued === null) return;
        const item = observe(queued);
        if (item === null) continue;
        yield item;
        if (
          item.kind === "event" &&
          terminal((await this.#getState(runId)).status)
        ) {
          return;
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      subscription.dispose();
    }
  }

  async #getState(runId: string): Promise<RunState> {
    const state = this.#states.get(runId);
    if (state === undefined) {
      throw new RunNotFoundError(runId);
    }
    return cloneJson(state);
  }

  async #withCommitLock<TValue>(
    runId: string,
    operation: () => Promise<TValue>,
  ): Promise<TValue> {
    const previous = this.#commitTails.get(runId) ?? Promise.resolve();
    const current = previous.then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#commitTails.set(runId, tail);
    try {
      return await current;
    } finally {
      if (this.#commitTails.get(runId) === tail) {
        this.#commitTails.delete(runId);
      }
    }
  }

  async #commit<TType extends RunEventType>(
    runId: string,
    type: TType,
    payload: RunEventPayloads[TType],
    causationId?: string,
  ): Promise<{
    readonly effects: readonly EffectRequest[];
    readonly event: AnyRunEvent;
  }> {
    return this.#withCommitLock(runId, async () => {
      const current = this.#states.get(runId);
      if (current === undefined) {
        throw new RunNotFoundError(runId);
      }

      const common = {
        id: this.#ids.next("event"),
        payload,
        runId,
        sequence: current.revision + 1,
        timestamp: this.#clock.now(),
        type,
      };
      const event = createRunEvent(
        causationId === undefined ? common : { ...common, causationId },
      ) as AnyRunEvent;

      const decoded = decodeRunEvent(event);
      const preview = reduce(current, decoded);
      await this.#store.append(runId, current.revision, decoded);
      this.#states.set(runId, preview.state);
      this.#observations.publish(runId, {
        event: cloneJson(decoded),
        kind: "event",
      });
      return { effects: preview.effects, event: decoded };
    });
  }

  #schedule(runId: string): void {
    if (this.#active.has(runId)) {
      return;
    }
    this.#active.add(runId);
    const execution = Promise.resolve()
      .then(() => this.#continue(runId))
      .finally(() => {
        this.#active.delete(runId);
      });
    this.#executions.set(runId, execution);
    void execution.catch(() => undefined);
  }

  async #wait(runId: string): Promise<RunState> {
    const execution = this.#executions.get(runId);
    if (execution !== undefined) {
      await execution;
    }
    return this.#getState(runId);
  }

  async #continue(runId: string): Promise<void> {
    while (true) {
      const pauseRequest = this.#pauseRequests.get(runId);
      if (pauseRequest !== undefined) {
        await pauseRequest;
      }

      const state = this.#states.get(runId);
      if (state === undefined) {
        throw new RunNotFoundError(runId);
      }
      if (
        terminal(state.status) ||
        state.status === "paused" ||
        state.status === "waiting" ||
        state.status === "created"
      ) {
        await this.#writeCheckpoint(runId);
        return;
      }
      if (state.pauseRequested) {
        await this.#commit(runId, "run.paused", {});
        await this.#writeCheckpoint(runId);
        return;
      }

      const pending = Object.values(state.pendingEffects);
      if (pending.length > 0) {
        const unsafe = pending.find(
          (effect) =>
            effect.type === "tool.execute" &&
            effect.input.idempotency !== "idempotent",
        );
        if (unsafe !== undefined) {
          await this.#commit(runId, "run.waiting", {
            effectId: unsafe.id,
            reasonCode: "effect_outcome_unknown",
          });
          await this.#writeCheckpoint(runId);
          return;
        }
        await this.#dispatchBatch(
          runId,
          pending.map((effect) => ({ ...effect, attempt: effect.attempt + 1 })),
        );
        continue;
      }

      if (state.readyEffects.length > 0) {
        await this.#dispatchBatch(runId, state.readyEffects);
        continue;
      }

      throw new InvalidTransitionError(
        `Running Run ${runId} has no ready or pending Effect`,
      );
    }
  }

  async #dispatchBatch(
    runId: string,
    effects: readonly EffectRequest[],
  ): Promise<void> {
    const prepared: PreparedEffect[] = [];
    for (const effect of effects) {
      const committed =
        effect.type === "model.generate"
          ? await this.#commit(
              runId,
              "model.requested",
              { effect },
              effect.requestedByEventId,
            )
          : await this.#commit(
              runId,
              "tool.requested",
              { effect },
              effect.requestedByEventId,
            );
      prepared.push({ effect, requestEventId: committed.event.id });
    }

    const proposals = await Promise.all(
      prepared.map(async ({ effect, requestEventId }) => ({
        proposal: await this.#dispatch(runId, effect),
        requestEventId,
      })),
    );
    for (const { proposal, requestEventId } of proposals) {
      await this.#commitProposal(runId, proposal, requestEventId);
    }
  }

  async #commitProposal(
    runId: string,
    proposal: OutcomeProposal,
    causationId: string,
  ): Promise<void> {
    switch (proposal.type) {
      case "model.completed":
        await this.#commit(runId, proposal.type, proposal.payload, causationId);
        return;
      case "model.failed":
        await this.#commit(runId, proposal.type, proposal.payload, causationId);
        return;
      case "tool.completed":
        await this.#commit(runId, proposal.type, proposal.payload, causationId);
        return;
      case "tool.failed":
        await this.#commit(runId, proposal.type, proposal.payload, causationId);
        return;
    }
  }

  async #pause(runId: string): Promise<RunState> {
    const current = this.#states.get(runId);
    if (current === undefined) {
      throw new RunNotFoundError(runId);
    }
    if (terminal(current.status) || current.status === "paused") {
      return cloneJson(current);
    }
    if (current.status !== "running") {
      throw new InvalidTransitionError(
        `Run ${runId} cannot pause while ${current.status}`,
      );
    }

    let request = this.#pauseRequests.get(runId);
    if (request === undefined) {
      request = this.#commit(runId, "run.pause_requested", {}).then(
        () => undefined,
      );
      this.#pauseRequests.set(runId, request);
    }
    try {
      await request;
      this.#schedule(runId);
      return await this.#wait(runId);
    } catch (error) {
      const latest = this.#states.get(runId);
      if (latest !== undefined && terminal(latest.status)) {
        return cloneJson(latest);
      }
      throw error;
    } finally {
      this.#pauseRequests.delete(runId);
    }
  }

  async #resume(runId: string): Promise<void> {
    if (!this.#states.has(runId)) {
      throw new RunNotFoundError(runId);
    }
    const events = await this.#store.read(runId);
    if (events.length === 0) {
      throw new RunNotFoundError(runId);
    }
    const state = await this.#restoreState(runId, events);
    this.#states.set(runId, state);
    requirePaused(state);
    await this.#commit(runId, "run.resumed", {});
    this.#schedule(runId);
  }

  async #replay(runId: string): Promise<RunState> {
    return replayEvents(runId, await this.#store.read(runId));
  }

  async #restoreState(
    runId: string,
    events: readonly AnyRunEvent[],
  ): Promise<RunState> {
    let checkpoint: Checkpoint | null = null;
    try {
      const stored = await this.#store.readCheckpoint(runId);
      checkpoint = stored === null ? null : decodeCheckpoint(stored);
    } catch {
      checkpoint = null;
    }

    if (checkpoint !== null && this.#validCheckpoint(checkpoint, events)) {
      let state = cloneJson(checkpoint.state);
      for (const event of events.slice(checkpoint.sequence)) {
        state = reduce(state, event).state;
      }
      return state;
    }
    return replayEvents(runId, events);
  }

  #validCheckpoint(
    checkpoint: Checkpoint,
    events: readonly AnyRunEvent[],
  ): boolean {
    if (
      checkpoint.reducerVersion !== REDUCER_VERSION ||
      checkpoint.eventSchemaVersion !== 1 ||
      checkpoint.sequence < 1 ||
      checkpoint.sequence > events.length ||
      checkpoint.state.runId !== checkpoint.runId ||
      checkpoint.state.revision !== checkpoint.sequence ||
      checkpoint.stateDigest !== jsonDigest(checkpoint.state)
    ) {
      return false;
    }
    const event = events[checkpoint.sequence - 1];
    return (
      event !== undefined &&
      event.runId === checkpoint.runId &&
      event.id === checkpoint.eventId
    );
  }

  async #writeCheckpoint(runId: string): Promise<void> {
    if (!this.#checkpoints) {
      return;
    }
    const state = this.#states.get(runId);
    if (state === undefined || state.revision < 1) {
      return;
    }
    try {
      const events = await this.#store.read(runId, state.revision);
      const event = events[0];
      if (event === undefined || event.sequence !== state.revision) {
        return;
      }
      await this.#store.writeCheckpoint({
        eventId: event.id,
        eventSchemaVersion: event.schemaVersion,
        reducerVersion: REDUCER_VERSION,
        runId,
        sequence: state.revision,
        state: cloneJson(state),
        stateDigest: jsonDigest(state),
      });
    } catch {
      // Checkpoints are disposable caches and never determine Run correctness.
    }
  }

  async #fork(parentRunId: string, options: ForkOptions): Promise<RunHandle> {
    const agent = this.#agents.get(parentRunId);
    if (agent === undefined) {
      throw new RunNotFoundError(parentRunId);
    }
    const parentEvents = await this.#store.read(parentRunId);
    const forkIndex = parentEvents.findIndex((event) => event.id === options.at);
    if (forkIndex < 0) {
      throw new InvalidForkPointError(parentRunId, options.at);
    }
    const prefix = parentEvents.slice(0, forkIndex + 1);
    const childRunId = this.#ids.next("run");
    const copied = this.#copyPrefix(prefix, childRunId);
    let state = replayEvents(childRunId, copied);
    const parentEvent = parentEvents[forkIndex];
    if (parentEvent === undefined) {
      throw new InvalidForkPointError(parentRunId, options.at);
    }

    const forked = createRunEvent({
      id: this.#ids.next("event"),
      payload: {
        parentEventId: parentEvent.id,
        parentRunId,
        parentSequence: parentEvent.sequence,
      },
      runId: childRunId,
      sequence: state.revision + 1,
      timestamp: this.#clock.now(),
      type: "run.forked",
    });
    const decodedFork = decodeRunEvent(forked);
    state = reduce(state, decodedFork).state;

    const input = createRunEvent({
      causationId: decodedFork.id,
      id: this.#ids.next("event"),
      payload: { content: options.input },
      runId: childRunId,
      sequence: state.revision + 1,
      timestamp: this.#clock.now(),
      type: "input.received",
    });
    const decodedInput = decodeRunEvent(input);
    state = reduce(state, decodedInput).state;
    const history = [...copied, decodedFork, decodedInput];

    await this.#store.createFork(childRunId, history);
    this.#agents.set(childRunId, agent);
    this.#states.set(childRunId, state);
    this.#schedule(childRunId);
    return this.#handle(childRunId);
  }

  #copyPrefix(
    parentEvents: readonly AnyRunEvent[],
    childRunId: string,
  ): readonly AnyRunEvent[] {
    const eventIds = new Map<string, string>();
    const effectIds = new Map<string, string>();
    for (const event of parentEvents) {
      eventIds.set(event.id, this.#ids.next("event"));
      if (event.type === "model.requested" || event.type === "tool.requested") {
        if (!effectIds.has(event.payload.effect.id)) {
          const effect = event.payload.effect;
          const requestedByEventId = eventIds.get(effect.requestedByEventId);
          const originalPrefix = `${effect.requestedByEventId}:effect:`;
          const id =
            requestedByEventId !== undefined && effect.id.startsWith(originalPrefix)
              ? `${requestedByEventId}:effect:${effect.id.slice(originalPrefix.length)}`
              : `${childRunId}:fork-effect:${effectIds.size}`;
          effectIds.set(effect.id, id);
        }
      }
    }

    return parentEvents.map((event) => {
      const id = eventIds.get(event.id);
      if (id === undefined) {
        throw new InvalidTransitionError(`Fork could not map Event ${event.id}`);
      }
      const payload = this.#copyPayload(
        event,
        childRunId,
        eventIds,
        effectIds,
      );
      const copied = {
        id,
        payload,
        runId: childRunId,
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
      };
      return decodeRunEvent(copied);
    });
  }

  #copyPayload(
    event: AnyRunEvent,
    childRunId: string,
    eventIds: ReadonlyMap<string, string>,
    effectIds: ReadonlyMap<string, string>,
  ): JsonObject {
    if (event.type === "model.requested" || event.type === "tool.requested") {
      const effect = event.payload.effect;
      const id = effectIds.get(effect.id);
      if (id === undefined) {
        throw new InvalidTransitionError(`Fork could not map Effect ${effect.id}`);
      }
      return toJsonObject(
        {
          effect: {
            ...effect,
            id,
            idempotencyKey: id,
            requestedByEventId:
              eventIds.get(effect.requestedByEventId) ?? effect.requestedByEventId,
            runId: childRunId,
          },
        },
        `Fork payload for ${event.id}`,
      );
    }

    if (
      event.type === "model.completed" ||
      event.type === "model.failed" ||
      event.type === "tool.completed" ||
      event.type === "tool.failed"
    ) {
      const effectId = effectIds.get(event.payload.effectId);
      if (effectId === undefined) {
        throw new InvalidTransitionError(
          `Fork outcome ${event.id} has no copied Effect request`,
        );
      }
      return toJsonObject(
        { ...event.payload, effectId },
        `Fork payload for ${event.id}`,
      );
    }

    if (event.type === "run.waiting") {
      const effectId = effectIds.get(event.payload.effectId);
      if (effectId === undefined) {
        throw new InvalidTransitionError(
          `Fork waiting Event ${event.id} has no copied Effect request`,
        );
      }
      return { ...event.payload, effectId };
    }

    return toJsonObject(event.payload, `Fork payload for ${event.id}`);
  }

  async #dispatch(
    runId: string,
    effect: EffectRequest,
  ): Promise<OutcomeProposal> {
    if (effect.type === "model.generate") {
      return this.#dispatchModel(effect);
    }
    return this.#dispatchTool(runId, effect);
  }

  async #dispatchModel(effect: ModelGenerateEffect): Promise<OutcomeProposal> {
    const driver = this.#modelDrivers[effect.input.model.provider];
    if (driver === undefined) {
      return {
        payload: {
          disposition: "failed",
          effectId: effect.id,
          error: driverError(
            "model_driver_missing",
            `No Model Driver is registered for ${effect.input.model.provider}`,
            false,
          ),
        },
        type: "model.failed",
      };
    }

    let outcome: ModelOutcome;
    try {
      outcome = await driver.generate(cloneJson(effect), {
        cancellation: new AbortController().signal,
        signals: this.#signalsFor(effect.runId),
      });
    } catch (error) {
      outcome = {
        error: driverError("model_driver_exception", messageFrom(error), true),
        status: "indeterminate",
      };
    }

    if (outcome.status !== "succeeded") {
      return {
        payload: {
          disposition: outcome.status,
          effectId: effect.id,
          error: outcome.error,
        },
        type: "model.failed",
      };
    }

    try {
      return {
        payload: {
          effectId: effect.id,
          response: parseModelResponse(outcome.value),
        },
        type: "model.completed",
      };
    } catch (error) {
      return {
        payload: {
          disposition: "failed",
          effectId: effect.id,
          error: driverError("model_response_invalid", messageFrom(error), false),
        },
        type: "model.failed",
      };
    }
  }

  async #dispatchTool(
    runId: string,
    effect: ToolExecuteEffect,
  ): Promise<OutcomeProposal> {
    const agent = this.#agents.get(runId);
    const tool = agent?.tools.find(
      (candidate) => candidate.descriptor.name === effect.input.name,
    );
    if (tool === undefined) {
      return this.#toolFailure(
        effect,
        "failed",
        driverError(
          "tool_missing",
          `Tool ${effect.input.name} is not registered`,
          false,
        ),
      );
    }

    let input: JsonValue;
    try {
      input = tool.parseInput(cloneJson(effect.input.arguments));
    } catch (error) {
      return this.#toolFailure(
        effect,
        "failed",
        driverError("tool_input_invalid", messageFrom(error), false),
      );
    }

    let output: JsonValue;
    try {
      output = await this.#executeTool(tool, input, effect);
    } catch (error) {
      return this.#toolFailure(
        effect,
        "indeterminate",
        driverError("tool_driver_exception", messageFrom(error), false),
      );
    }

    try {
      const parsed = tool.parseOutput(output);
      assertJsonValue(parsed, `Output from Tool ${effect.input.name}`);
      return {
        payload: {
          effectId: effect.id,
          name: effect.input.name,
          output: parsed,
          toolCallId: effect.input.toolCallId,
        },
        type: "tool.completed",
      };
    } catch (error) {
      return this.#toolFailure(
        effect,
        "failed",
        driverError("tool_output_invalid", messageFrom(error), false),
      );
    }
  }

  async #executeTool(
    tool: ExecutableTool,
    input: JsonValue,
    effect: ToolExecuteEffect,
  ): Promise<JsonValue> {
    return tool.execute(cloneJson(input), {
      cancellation: new AbortController().signal,
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      runId: effect.runId,
      signals: this.#signalsFor(effect.runId),
    });
  }

  #signalsFor(runId: string): SignalSink {
    return {
      emit: (signal: Signal) => {
        if (signal.runId !== runId) {
          throw new InvalidTransitionError(
            `Signal Run ${signal.runId} does not match active Run ${runId}`,
          );
        }
        const copied = cloneJson(signal);
        this.#observations.publish(runId, copied);
        try {
          this.#signals.emit(copied);
        } catch {
          // Observation sinks cannot change authoritative execution.
        }
      },
    };
  }

  #toolFailure(
    effect: ToolExecuteEffect,
    disposition: "failed" | "indeterminate",
    error: DriverError,
  ): OutcomeProposal {
    return {
      payload: {
        disposition,
        effectId: effect.id,
        error,
        name: effect.input.name,
        toolCallId: effect.input.toolCallId,
      },
      type: "tool.failed",
    };
  }
}

function requirePaused(state: RunState): void {
  if (state.status !== "paused") {
    throw new InvalidTransitionError(
      `Run ${state.runId} cannot resume while ${state.status}`,
    );
  }
}

export function createRuntime(config: RuntimeConfig): Runtime {
  return new Runtime(config);
}
