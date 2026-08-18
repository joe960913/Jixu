import type {
  AgentSnapshot,
  DriverError,
  ThreadState,
  ToolCall,
} from "./domain.ts";
import { createInitialThreadState } from "./domain.ts";
import type {
  EffectRequest,
  ModelGenerateEffect,
  ToolExecuteEffect,
} from "./effects.ts";
import {
  InvalidTransitionError,
  UnsupportedEventError,
} from "./errors.ts";
import { isSupportedEventSchemaVersion } from "./events.ts";
import type { AnyThreadEvent } from "./events.ts";
import { jsonEquals } from "./json.ts";
import {
  recordEffectOutcome,
  recordEffectRequest,
  recordModelAccounting,
} from "./metrics.ts";
import {
  assertPlanUpdateTransition,
  compilePlanInstructions,
  materializePlanUpdates,
  PLAN_CONTROL,
  samePlan,
} from "./plan.ts";

export const REDUCER_VERSION = 5;

export interface TransitionResult {
  readonly effects: readonly EffectRequest[];
  readonly state: ThreadState;
}

function requireAgent(state: ThreadState): AgentSnapshot {
  if (state.agent === null) {
    throw new InvalidTransitionError(
      `Thread ${state.threadId} has no Agent definition`,
    );
  }
  return state.agent;
}

function requireStatus(
  state: ThreadState,
  eventType: string,
  expected: ThreadState["status"],
): void {
  if (state.status !== expected) {
    throw new InvalidTransitionError(
      `${eventType} cannot apply while Thread ${state.threadId} is ${state.status}`,
    );
  }
}

function removePending(
  state: ThreadState,
  effectId: string,
  expectedType: EffectRequest["type"],
): Readonly<Record<string, EffectRequest>> {
  const pending = state.pendingEffects[effectId];
  if (pending === undefined || pending.type !== expectedType) {
    throw new InvalidTransitionError(
      `Effect ${effectId} is not pending as ${expectedType}`,
    );
  }

  const remaining = { ...state.pendingEffects };
  delete remaining[effectId];
  return remaining;
}

function acceptRequest(
  state: ThreadState,
  effect: EffectRequest,
): {
  readonly pendingEffects: Readonly<Record<string, EffectRequest>>;
  readonly readyEffects: readonly EffectRequest[];
} {
  if (effect.threadId !== state.threadId) {
    throw new InvalidTransitionError(
      `Effect ${effect.id} belongs to Thread ${effect.threadId}`,
    );
  }

  const pending = state.pendingEffects[effect.id];
  if (pending !== undefined) {
    if (
      effect.attempt !== pending.attempt + 1 ||
      effect.type !== pending.type ||
      effect.idempotencyKey !== pending.idempotencyKey ||
      effect.requestedByEventId !== pending.requestedByEventId ||
      !jsonEquals(effect.input, pending.input)
    ) {
      throw new InvalidTransitionError(
        `Effect ${effect.id} retry does not preserve logical identity`,
      );
    }
    return {
      pendingEffects: { ...state.pendingEffects, [effect.id]: effect },
      readyEffects: state.readyEffects,
    };
  }

  const readyIndex = state.readyEffects.findIndex(
    (candidate) => candidate.id === effect.id,
  );
  if (readyIndex < 0 || !jsonEquals(state.readyEffects[readyIndex], effect)) {
    throw new InvalidTransitionError(`Effect ${effect.id} is not ready`);
  }
  return {
    pendingEffects: { ...state.pendingEffects, [effect.id]: effect },
    readyEffects: state.readyEffects.filter((_, index) => index !== readyIndex),
  };
}

function createModelEffect(
  state: ThreadState,
  requestedByEventId: string,
  index: number,
): ModelGenerateEffect {
  const agent = requireAgent(state);
  const id = `${requestedByEventId}:effect:${index}`;
  return {
    attempt: 1,
    id,
    idempotencyKey: id,
    input: {
      activePlan: state.activePlan,
      instructions: compilePlanInstructions(agent.instructions, state.activePlan),
      messages: state.messages,
      model: agent.model,
      planControl: PLAN_CONTROL,
      tools: agent.tools,
    },
    requestedByEventId,
    threadId: state.threadId,
    type: "model.generate",
  };
}

function createToolEffect(
  state: ThreadState,
  call: ToolCall,
  requestedByEventId: string,
  index: number,
): ToolExecuteEffect {
  const descriptor = requireAgent(state).tools.find(
    (tool) => tool.name === call.name,
  );
  const id = `${requestedByEventId}:effect:${index}`;
  return {
    attempt: 1,
    id,
    idempotencyKey: id,
    input: {
      arguments: call.arguments,
      idempotency: descriptor?.idempotency ?? "none",
      name: call.name,
      toolCallId: call.id,
    },
    requestedByEventId,
    threadId: state.threadId,
    type: "tool.execute",
  };
}

function advance(
  state: ThreadState,
  sequence: number,
  updates: Partial<ThreadState>,
): ThreadState {
  return { ...state, ...updates, revision: sequence };
}

function withReadyEffects(
  state: ThreadState,
  sequence: number,
  effects: readonly EffectRequest[],
  updates: Partial<ThreadState> = {},
): TransitionResult {
  return {
    effects,
    state: advance(state, sequence, {
      ...updates,
      readyEffects: effects,
    }),
  };
}

function failAfterToolOutcome(
  state: ThreadState,
  sequence: number,
  remaining: Readonly<Record<string, EffectRequest>>,
  error: DriverError,
): TransitionResult {
  const hasPendingTools = Object.values(remaining).some(
    (effect) => effect.type === "tool.execute",
  );
  if (hasPendingTools) {
    return {
      effects: [],
      state: advance(state, sequence, {
        error: state.error ?? error,
        pendingEffects: remaining,
        readyEffects: [],
      }),
    };
  }
  return settleTurn(
    advance(state, sequence, { pendingEffects: remaining }),
    sequence,
    { error: state.error ?? error, result: null },
  );
}

function settleTurn(
  state: ThreadState,
  sequence: number,
  outcome: Pick<ThreadState, "error" | "result">,
): TransitionResult {
  const [next, ...remaining] = state.inputQueue;
  if (next === undefined) {
    return {
      effects: [],
      state: advance(state, sequence, {
        ...outcome,
        pauseRequested: false,
        readyEffects: [],
        status: "idle",
      }),
    };
  }

  const nextState = advance(state, sequence, {
    error: null,
    inputQueue: remaining,
    messages: [...state.messages, { content: next.content, role: "user" }],
    result: null,
    status: "running",
    waitingReason: null,
  });
  const effects = [createModelEffect(nextState, next.eventId, 0)];
  return withReadyEffects(nextState, sequence, effects);
}

export function reduce(state: ThreadState, event: AnyThreadEvent): TransitionResult {
  if (!isSupportedEventSchemaVersion(event.schemaVersion)) {
    throw new UnsupportedEventError(
      `Event ${event.id} uses unsupported schema version ${event.schemaVersion}`,
    );
  }
  if (event.threadId !== state.threadId) {
    throw new InvalidTransitionError(
      `Event ${event.id} belongs to Thread ${event.threadId}, not ${state.threadId}`,
    );
  }
  if (event.sequence !== state.revision + 1) {
    throw new InvalidTransitionError(
      `Event ${event.id} has sequence ${event.sequence}; expected ${state.revision + 1}`,
    );
  }

  switch (event.type) {
    case "thread.created": {
      if (state.revision !== 0 || state.agent !== null) {
        throw new InvalidTransitionError(
          `Thread ${state.threadId} is already initialized`,
        );
      }
      return {
        effects: [],
        state: advance(state, event.sequence, { agent: event.payload.agent }),
      };
    }

    case "thread.forked": {
      if (state.revision === 0 || state.agent === null) {
        throw new InvalidTransitionError(
          `Thread ${state.threadId} cannot record lineage before its copied prefix`,
        );
      }
      return {
        effects: [],
        state: advance(state, event.sequence, {
          error: null,
          inputQueue: [],
          lineage: event.payload,
          pauseRequested: false,
          pendingEffects: {},
          pendingPlanUpdates: [],
          readyEffects: [],
          result: null,
          status: "idle",
          waitingReason: null,
        }),
      };
    }

    case "input.received": {
      if (state.status === "running") {
        return {
          effects: [],
          state: advance(state, event.sequence, {
            inputQueue: [
              ...state.inputQueue,
              { content: event.payload.content, eventId: event.id },
            ],
          }),
        };
      }
      requireStatus(state, event.type, "idle");
      const nextState = advance(state, event.sequence, {
        error: null,
        inputQueue: [],
        messages: [
          ...state.messages,
          { content: event.payload.content, role: "user" },
        ],
        result: null,
        status: "running",
      });
      const effects = [createModelEffect(nextState, event.id, 0)];
      return withReadyEffects(nextState, event.sequence, effects);
    }

    case "context.cleared": {
      requireStatus(state, event.type, "idle");
      return {
        effects: [],
        state: advance(state, event.sequence, {
          error: null,
          inputQueue: [],
          messages: [],
          activePlan: null,
          pendingPlanUpdates: [],
          result: null,
          waitingReason: null,
        }),
      };
    }

    case "thread.pause_requested": {
      requireStatus(state, event.type, "running");
      if (state.pauseRequested) {
        throw new InvalidTransitionError(
          `Thread ${state.threadId} already has a pause request`,
        );
      }
      return {
        effects: [],
        state: advance(state, event.sequence, { pauseRequested: true }),
      };
    }

    case "thread.paused": {
      requireStatus(state, event.type, "running");
      if (!state.pauseRequested) {
        throw new InvalidTransitionError(
          `Thread ${state.threadId} has no pause request`,
        );
      }
      return {
        effects: [],
        state: advance(state, event.sequence, {
          pauseRequested: false,
          status: "paused",
        }),
      };
    }

    case "thread.continued": {
      requireStatus(state, event.type, "paused");
      return {
        effects: state.readyEffects,
        state: advance(state, event.sequence, {
          status: "running",
          waitingReason: null,
        }),
      };
    }

    case "thread.waiting": {
      requireStatus(state, event.type, "running");
      if (state.pendingEffects[event.payload.effectId] === undefined) {
        throw new InvalidTransitionError(
          `Waiting Effect ${event.payload.effectId} is not pending`,
        );
      }
      return {
        effects: [],
        state: advance(state, event.sequence, {
          pauseRequested: false,
          status: "waiting",
          waitingReason: event.payload,
        }),
      };
    }

    case "model.requested": {
      requireStatus(state, event.type, "running");
      const retry = state.pendingEffects[event.payload.effect.id] !== undefined;
      const accepted = acceptRequest(state, event.payload.effect);
      return {
        effects: [],
        state: advance(state, event.sequence, {
          ...accepted,
          metrics: recordEffectRequest(state.metrics, "model", retry),
        }),
      };
    }

    case "model.completed": {
      requireStatus(state, event.type, "running");
      const remaining = removePending(
        state,
        event.payload.effectId,
        "model.generate",
      );
      const response = event.payload.response;
      const identitySeed = `sequence-${event.sequence}`;
      materializePlanUpdates(
        state.activePlan,
        response.planUpdates ?? [],
        identitySeed,
      );
      const pendingPlanUpdates = (response.planUpdates ?? []).map(
        (proposal, index) => ({
          identitySeed: `${identitySeed}-${index}`,
          proposal,
        }),
      );
      const metrics = recordModelAccounting(
        recordEffectOutcome(state.metrics, "model", "succeeded"),
        event.payload.accounting,
      );
      const nextState = advance(state, event.sequence, {
        messages: [
          ...state.messages,
          {
            content: response.content,
            role: "assistant",
            toolCalls: response.toolCalls,
          },
        ],
        metrics,
        pendingEffects: remaining,
        pendingPlanUpdates,
      });
      if (response.toolCalls.length === 0) {
        return settleTurn(nextState, event.sequence, {
          error: null,
          result: response.content,
        });
      }
      const effects = response.toolCalls.map((call, index) =>
        createToolEffect(nextState, call, event.id, index),
      );
      return withReadyEffects(nextState, event.sequence, effects);
    }

    case "plan.updated": {
      const expected = state.pendingPlanUpdates[0];
      const materialized =
        expected === undefined
          ? undefined
          : materializePlanUpdates(
              state.activePlan,
              [expected.proposal],
              expected.identitySeed,
            )[0];
      if (
        materialized === undefined ||
        !samePlan(materialized, event.payload.plan)
      ) {
        throw new InvalidTransitionError(
          `Plan ${event.payload.plan.id} is not the next committed model proposal`,
        );
      }
      assertPlanUpdateTransition(state.activePlan, event.payload.plan);
      return {
        effects: [],
        state: advance(state, event.sequence, {
          activePlan:
            event.payload.plan.status === "active" ? event.payload.plan : null,
          pendingPlanUpdates: state.pendingPlanUpdates.slice(1),
        }),
      };
    }

    case "model.failed": {
      requireStatus(state, event.type, "running");
      const remaining = removePending(
        state,
        event.payload.effectId,
        "model.generate",
      );
      return settleTurn(
        advance(state, event.sequence, {
          metrics: recordModelAccounting(
            recordEffectOutcome(
              state.metrics,
              "model",
              event.payload.disposition,
            ),
            event.payload.accounting,
          ),
          pendingEffects: remaining,
        }),
        event.sequence,
        { error: event.payload.error, result: null },
      );
    }

    case "tool.requested": {
      requireStatus(state, event.type, "running");
      const retry = state.pendingEffects[event.payload.effect.id] !== undefined;
      const accepted = acceptRequest(state, event.payload.effect);
      return {
        effects: [],
        state: advance(state, event.sequence, {
          ...accepted,
          metrics: recordEffectRequest(state.metrics, "tools", retry),
        }),
      };
    }

    case "tool.completed": {
      requireStatus(state, event.type, "running");
      const remaining = removePending(
        state,
        event.payload.effectId,
        "tool.execute",
      );
      const nextState = advance(state, event.sequence, {
        messages: [
          ...state.messages,
          {
            name: event.payload.name,
            output: event.payload.output,
            role: "tool",
            toolCallId: event.payload.toolCallId,
          },
        ],
        metrics: recordEffectOutcome(state.metrics, "tools", "succeeded"),
        pendingEffects: remaining,
      });
      const hasPendingTools = Object.values(remaining).some(
        (effect) => effect.type === "tool.execute",
      );
      if (hasPendingTools) {
        return { effects: [], state: nextState };
      }
      if (nextState.error !== null) {
        return settleTurn(nextState, event.sequence, {
          error: nextState.error,
          result: null,
        });
      }
      const effects = [createModelEffect(nextState, event.id, 0)];
      return withReadyEffects(nextState, event.sequence, effects);
    }

    case "tool.failed": {
      requireStatus(state, event.type, "running");
      const remaining = removePending(
        state,
        event.payload.effectId,
        "tool.execute",
      );
      return failAfterToolOutcome(
        advance(state, event.sequence, {
          metrics: recordEffectOutcome(
            state.metrics,
            "tools",
            event.payload.disposition,
          ),
        }),
        event.sequence,
        remaining,
        event.payload.error,
      );
    }

    default: {
      const unsupported = event as { readonly type: string };
      throw new UnsupportedEventError(`Unknown Event type ${unsupported.type}`);
    }
  }
}

export function replayEvents(
  threadId: string,
  events: readonly AnyThreadEvent[],
): ThreadState {
  let state = createInitialThreadState(threadId);
  for (const event of events) {
    state = reduce(state, event).state;
  }
  return state;
}
