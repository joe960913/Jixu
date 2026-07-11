import { decodeCheckpoint, decodeThreadEvent } from "./codec.ts";
import type {
  AgentSnapshot,
  Checkpoint,
  ThreadState,
  ToolApprovalDecision,
} from "./domain.ts";
import type { EffectRequest } from "./effects.ts";
import type { EffectDispatcher, OutcomeProposal } from "./effect-dispatcher.ts";
import {
  InvalidTransitionError,
  ThreadNotFoundError,
} from "./errors.ts";
import {
  createThreadEvent,
  CURRENT_EVENT_SCHEMA_VERSION,
} from "./events.ts";
import type {
  AnyThreadEvent,
  ThreadEventPayloads,
  ThreadEventType,
} from "./events.ts";
import { cloneJson, jsonDigest } from "./json.ts";
import type { ObservationBroker } from "./observation.ts";
import type {
  Clock,
  EventStore,
  IdGenerator,
  ThreadStreamItem,
} from "./ports.ts";
import { REDUCER_VERSION, reduce, replayEvents } from "./reducer.ts";
import { materializePlanUpdates } from "./plan.ts";
import type { ForkOptions, Thread, ThreadStreamOptions } from "./thread.ts";

interface PreparedEffect {
  readonly effect: EffectRequest;
  readonly requestEventId: string;
}

export interface ThreadExecutionConfig {
  readonly checkpoints: boolean;
  readonly clock: Clock;
  readonly dispatcher: EffectDispatcher;
  readonly fork: (threadId: string, options: ForkOptions) => Promise<Thread>;
  readonly ids: IdGenerator;
  readonly observations: ObservationBroker;
  readonly state: ThreadState;
  readonly store: EventStore;
}

export class ThreadExecution implements Thread {
  readonly id: string;
  readonly #checkpoints: boolean;
  readonly #clock: Clock;
  readonly #dispatcher: EffectDispatcher;
  readonly #forkThread: ThreadExecutionConfig["fork"];
  readonly #ids: IdGenerator;
  readonly #observations: ObservationBroker;
  readonly #store: EventStore;
  #commitTail: Promise<void> = Promise.resolve();
  #execution: Promise<void> | null = null;
  #executionError: unknown = null;
  #rerun = false;
  #state: ThreadState;

  constructor(config: ThreadExecutionConfig) {
    this.id = config.state.threadId;
    this.#checkpoints = config.checkpoints;
    this.#clock = config.clock;
    this.#dispatcher = config.dispatcher;
    this.#forkThread = config.fork;
    this.#ids = config.ids;
    this.#observations = config.observations;
    this.#state = config.state;
    this.#store = config.store;
  }

  clear(): Promise<ThreadState> {
    return this.#commit("context.cleared", {}).then(() => this.state());
  }

  async decideApproval(
    effectId: string,
    decision: ToolApprovalDecision,
  ): Promise<ThreadState> {
    if (decision !== "allow_once" && decision !== "deny") {
      throw new InvalidTransitionError(`Unknown approval decision ${decision}`);
    }
    const approval = this.#state.toolApprovals[effectId];
    const effect = this.#state.pendingEffects[effectId];
    if (
      approval === undefined ||
      approval.decision !== null ||
      effect === undefined ||
      effect.type !== "tool.execute"
    ) {
      throw new InvalidTransitionError(
        `Tool Effect ${effectId} is not awaiting approval`,
      );
    }

    const decided = await this.#commit("approval.decided", {
      decision,
      effectId,
    });
    const proposal =
      decision === "deny"
        ? this.#dispatcher.rejectToolPermission(
            effect,
            `Tool ${effect.input.name} was denied by the user`,
          )
        : await this.#dispatcher.dispatch(effect);
    await this.#commitProposal(proposal, decided.event.id);
    this.#schedule();
    return this.wait();
  }

  async continue(): Promise<ThreadState> {
    if (this.#state.status !== "paused") {
      throw new InvalidTransitionError(
        `Thread ${this.id} cannot continue while ${this.#state.status}`,
      );
    }
    await this.#commit("thread.continued", {});
    this.#schedule();
    return this.wait();
  }

  events(): Promise<readonly AnyThreadEvent[]> {
    return this.#store.read(this.id);
  }

  fork(options: ForkOptions): Promise<Thread> {
    return this.#forkThread(this.id, options);
  }

  async pause(): Promise<ThreadState> {
    if (this.#state.status === "paused") return this.state();
    if (this.#state.status !== "running") {
      throw new InvalidTransitionError(
        `Thread ${this.id} cannot pause while ${this.#state.status}`,
      );
    }
    if (!this.#state.pauseRequested) {
      await this.#commit("thread.pause_requested", {});
    }
    this.#schedule();
    return this.wait();
  }

  replay(): Promise<ThreadState> {
    return this.#store.read(this.id).then((events) => replayEvents(this.id, events));
  }

  async send(input: string): Promise<ThreadState> {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new InvalidTransitionError("Thread input must be a non-empty string");
    }
    await this.#commit("input.received", { content: input });
    this.#schedule();
    return this.wait();
  }

  state(): Promise<ThreadState> {
    return Promise.resolve(cloneJson(this.#state));
  }

  async *stream(
    options: ThreadStreamOptions = {},
  ): AsyncIterable<ThreadStreamItem> {
    const fromSequence = options.fromSequence ?? 1;
    if (!Number.isInteger(fromSequence) || fromSequence < 1) {
      throw new RangeError("Thread stream fromSequence must be a positive integer");
    }

    const subscription = this.#observations.subscribe(this.id);
    const abort = () => subscription.queue.close();
    const aborted = () => options.signal?.aborted ?? false;
    options.signal?.addEventListener("abort", abort, { once: true });
    let lastSequence = fromSequence - 1;

    const observe = (item: ThreadStreamItem): ThreadStreamItem | null => {
      if (item.kind === "event") {
        if (item.event.sequence <= lastSequence) return null;
        lastSequence = item.event.sequence;
      }
      return cloneJson(item);
    };

    try {
      if (aborted()) return;
      for (const event of await this.#store.read(this.id, fromSequence)) {
        if (aborted()) return;
        lastSequence = event.sequence;
        yield { event: cloneJson(event), kind: "event" };
      }
      for (const queued of subscription.queue.drain()) {
        if (aborted()) return;
        const item = observe(queued);
        if (item !== null) yield item;
      }
      while (!aborted()) {
        const queued = await subscription.queue.next();
        if (queued === null) return;
        const item = observe(queued);
        if (item !== null) yield item;
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      subscription.dispose();
    }
  }

  async wait(): Promise<ThreadState> {
    while (this.#execution !== null) {
      const current = this.#execution;
      await current;
      if (current === this.#execution) break;
    }
    if (this.#executionError !== null) throw this.#executionError;
    return this.state();
  }

  startRecovery(): void {
    if (
      this.#state.status === "running" ||
      this.#state.pendingPlanUpdates.length > 0
    ) {
      this.#schedule();
    }
  }

  async initialize(agent: AgentSnapshot): Promise<void> {
    if (this.#state.revision !== 0) {
      throw new InvalidTransitionError(`Thread ${this.id} is already initialized`);
    }
    await this.#commit("thread.created", { agent });
  }

  async #withCommitLock<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    const current = this.#commitTail.then(operation);
    this.#commitTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  #commit<TType extends ThreadEventType>(
    type: TType,
    payload: ThreadEventPayloads[TType],
    causationId?: string,
  ): Promise<{
    readonly effects: readonly EffectRequest[];
    readonly event: AnyThreadEvent;
  }> {
    return this.#withCommitLock(async () => {
      const common = {
        id: this.#ids.next("event"),
        payload,
        threadId: this.id,
        sequence: this.#state.revision + 1,
        timestamp: this.#clock.now(),
        type,
      };
      const event = createThreadEvent(
        causationId === undefined ? common : { ...common, causationId },
      ) as AnyThreadEvent;
      const decoded = decodeThreadEvent(event);
      const preview = reduce(this.#state, decoded);
      await this.#store.append(this.id, this.#state.revision, decoded);
      this.#state = preview.state;
      this.#observations.publish(this.id, { event: decoded, kind: "event" });
      return { effects: preview.effects, event: decoded };
    });
  }

  #schedule(): void {
    this.#rerun = true;
    if (this.#execution !== null) return;
    this.#executionError = null;
    const execution = this.#runScheduled();
    this.#execution = execution;
    void execution.then(
      () => {
        if (this.#execution === execution) this.#execution = null;
      },
      (error: unknown) => {
        this.#executionError = error;
        if (this.#execution === execution) this.#execution = null;
      },
    );
  }

  async #runScheduled(): Promise<void> {
    do {
      this.#rerun = false;
      await this.#drive();
    } while (this.#rerun);
  }

  async #drive(): Promise<void> {
    while (true) {
      const state = this.#state;
      const pendingPlanRejection = state.pendingPlanRejections[0];
      if (pendingPlanRejection !== undefined) {
        await this.#commit("plan.rejected", pendingPlanRejection);
        continue;
      }
      const pendingPlanUpdate = state.pendingPlanUpdates[0];
      if (pendingPlanUpdate !== undefined) {
        const plan = materializePlanUpdates(
          state.activePlan,
          [pendingPlanUpdate.proposal],
          pendingPlanUpdate.identitySeed,
        )[0];
        if (plan === undefined) {
          throw new InvalidTransitionError("Pending Plan update did not materialize");
        }
        await this.#commit("plan.updated", { plan });
        continue;
      }
      const deniedApproval = Object.values(state.toolApprovals).find(
        (approval) => approval.decision === "deny",
      );
      if (deniedApproval !== undefined) {
        const effect = state.pendingEffects[deniedApproval.effectId];
        if (effect === undefined || effect.type !== "tool.execute") {
          throw new InvalidTransitionError(
            `Denied approval ${deniedApproval.effectId} has no pending Tool Effect`,
          );
        }
        await this.#commitProposal(
          this.#dispatcher.rejectToolPermission(
            effect,
            `Tool ${effect.input.name} was denied by the user`,
          ),
          deniedApproval.decisionEventId ?? effect.requestedByEventId,
        );
        continue;
      }
      if (state.status !== "running") {
        await this.#writeCheckpoint();
        return;
      }
      if (state.pauseRequested) {
        await this.#commit("thread.paused", {});
        await this.#writeCheckpoint();
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
          await this.#commit("thread.waiting", {
            effectId: unsafe.id,
            reasonCode: "effect_outcome_unknown",
          });
          await this.#writeCheckpoint();
          return;
        }
        await this.#dispatchBatch(
          pending.map((effect) => ({ ...effect, attempt: effect.attempt + 1 })),
        );
        continue;
      }

      if (state.readyEffects.length > 0) {
        await this.#dispatchBatch(state.readyEffects);
        continue;
      }
      throw new InvalidTransitionError(
        `Running Thread ${this.id} has no ready or pending Effect`,
      );
    }
  }

  async #dispatchBatch(effects: readonly EffectRequest[]): Promise<void> {
    const prepared: PreparedEffect[] = [];
    for (const effect of effects) {
      const committed =
        effect.type === "model.generate"
          ? await this.#commit(
              "model.requested",
              { effect },
              effect.requestedByEventId,
            )
          : await this.#commit(
              "tool.requested",
              { effect },
              effect.requestedByEventId,
            );
      prepared.push({ effect, requestEventId: committed.event.id });
    }

    const dispatchable: PreparedEffect[] = [];
    const proposals: Array<{
      readonly proposal: OutcomeProposal;
      readonly requestEventId: string;
    }> = [];
    for (const item of prepared) {
      if (item.effect.type === "model.generate") {
        dispatchable.push(item);
        continue;
      }
      const approved = this.#state.toolApprovals[item.effect.id];
      if (approved?.decision === "allow_once") {
        dispatchable.push(item);
        continue;
      }
      const permission = this.#dispatcher.inspectToolPermission(item.effect);
      if (permission === null || permission.effect === "allow") {
        dispatchable.push(item);
        continue;
      }
      if (permission.effect === "deny") {
        proposals.push({
          proposal: this.#dispatcher.rejectToolPermission(item.effect),
          requestEventId: item.requestEventId,
        });
        continue;
      }
      await this.#commit(
        "approval.requested",
        {
          action: permission.request.action,
          effectId: item.effect.id,
          name: item.effect.input.name,
          resources: permission.request.resources,
          toolCallId: item.effect.input.toolCallId,
        },
        item.requestEventId,
      );
    }

    proposals.push(
      ...(await Promise.all(
        dispatchable.map(async ({ effect, requestEventId }) => ({
          proposal: await this.#dispatcher.dispatch(effect),
          requestEventId,
        })),
      )),
    );
    for (const { proposal, requestEventId } of proposals) {
      await this.#commitProposal(proposal, requestEventId);
    }
  }

  async #commitProposal(
    proposal: OutcomeProposal,
    causationId: string,
  ): Promise<void> {
    switch (proposal.type) {
      case "model.completed": {
        await this.#commit(proposal.type, proposal.payload, causationId);
        return;
      }
      case "model.failed":
        await this.#commit(proposal.type, proposal.payload, causationId);
        return;
      case "tool.completed":
        await this.#commit(proposal.type, proposal.payload, causationId);
        return;
      case "tool.failed":
        await this.#commit(proposal.type, proposal.payload, causationId);
        return;
    }
  }

  async #writeCheckpoint(): Promise<void> {
    if (!this.#checkpoints || this.#state.revision < 1) return;
    try {
      const events = await this.#store.read(this.id, this.#state.revision);
      const event = events[0];
      if (event === undefined || event.sequence !== this.#state.revision) return;
      await this.#store.writeCheckpoint({
        eventId: event.id,
        eventSchemaVersion: event.schemaVersion,
        reducerVersion: REDUCER_VERSION,
        threadId: this.id,
        sequence: this.#state.revision,
        state: cloneJson(this.#state),
        stateDigest: jsonDigest(this.#state),
      });
    } catch {
      // Checkpoints are disposable caches and never determine Thread correctness.
    }
  }
}

export async function restoreThreadState(
  store: EventStore,
  threadId: string,
  events: readonly AnyThreadEvent[],
): Promise<ThreadState> {
  let checkpoint: Checkpoint | null = null;
  try {
    const stored = await store.readCheckpoint(threadId);
    checkpoint = stored === null ? null : decodeCheckpoint(stored);
  } catch {
    checkpoint = null;
  }

  if (checkpoint !== null && validCheckpoint(checkpoint, events)) {
    let state = cloneJson(checkpoint.state);
    for (const event of events.slice(checkpoint.sequence)) {
      state = reduce(state, event).state;
    }
    return state;
  }
  return replayEvents(threadId, events);
}

function validCheckpoint(
  checkpoint: Checkpoint,
  events: readonly AnyThreadEvent[],
): boolean {
  if (
    checkpoint.reducerVersion !== REDUCER_VERSION ||
    checkpoint.eventSchemaVersion !== CURRENT_EVENT_SCHEMA_VERSION ||
    checkpoint.sequence < 1 ||
    checkpoint.sequence > events.length ||
    checkpoint.state.threadId !== checkpoint.threadId ||
    checkpoint.state.revision !== checkpoint.sequence ||
    checkpoint.stateDigest !== jsonDigest(checkpoint.state)
  ) {
    return false;
  }
  const event = events[checkpoint.sequence - 1];
  return (
    event !== undefined &&
    event.threadId === checkpoint.threadId &&
    event.id === checkpoint.eventId
  );
}
