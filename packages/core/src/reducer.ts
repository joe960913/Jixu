import type {
  AgentSnapshot,
  DriverError,
  RunState,
  ToolCall,
} from "./domain.ts";
import { createInitialRunState } from "./domain.ts";
import type {
  EffectRequest,
  ModelGenerateEffect,
  ToolExecuteEffect,
} from "./effects.ts";
import {
  InvalidTransitionError,
  UnsupportedEventError,
} from "./errors.ts";
import type { AnyRunEvent } from "./events.ts";
import { jsonEquals } from "./json.ts";

export const REDUCER_VERSION = 1;

export interface TransitionResult {
  readonly effects: readonly EffectRequest[];
  readonly state: RunState;
}

function requireAgent(state: RunState): AgentSnapshot {
  if (state.agent === null) {
    throw new InvalidTransitionError(`Run ${state.runId} has no Agent definition`);
  }
  return state.agent;
}

function requireStatus(
  state: RunState,
  eventType: string,
  expected: RunState["status"],
): void {
  if (state.status !== expected) {
    throw new InvalidTransitionError(
      `${eventType} cannot apply while Run ${state.runId} is ${state.status}`,
    );
  }
}

function removePending(
  state: RunState,
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
  state: RunState,
  effect: EffectRequest,
): {
  readonly pendingEffects: Readonly<Record<string, EffectRequest>>;
  readonly readyEffects: readonly EffectRequest[];
} {
  if (effect.runId !== state.runId) {
    throw new InvalidTransitionError(
      `Effect ${effect.id} belongs to Run ${effect.runId}`,
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
  state: RunState,
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
      instructions: agent.instructions,
      messages: state.messages,
      model: agent.model,
      tools: agent.tools,
    },
    requestedByEventId,
    runId: state.runId,
    type: "model.generate",
  };
}

function createToolEffect(
  state: RunState,
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
    runId: state.runId,
    type: "tool.execute",
  };
}

function advance(
  state: RunState,
  sequence: number,
  updates: Partial<RunState>,
): RunState {
  return { ...state, ...updates, revision: sequence };
}

function withReadyEffects(
  state: RunState,
  sequence: number,
  effects: readonly EffectRequest[],
  updates: Partial<RunState> = {},
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
  state: RunState,
  sequence: number,
  remaining: Readonly<Record<string, EffectRequest>>,
  error: DriverError,
): TransitionResult {
  const hasPendingTools = Object.values(remaining).some(
    (effect) => effect.type === "tool.execute",
  );
  return {
    effects: [],
    state: advance(state, sequence, {
      error: state.error ?? error,
      pauseRequested: hasPendingTools ? state.pauseRequested : false,
      pendingEffects: remaining,
      readyEffects: [],
      status: hasPendingTools ? "running" : "failed",
    }),
  };
}

export function reduce(state: RunState, event: AnyRunEvent): TransitionResult {
  if (event.schemaVersion !== 1) {
    throw new UnsupportedEventError(
      `Event ${event.id} uses unsupported schema version ${event.schemaVersion}`,
    );
  }
  if (event.runId !== state.runId) {
    throw new InvalidTransitionError(
      `Event ${event.id} belongs to Run ${event.runId}, not ${state.runId}`,
    );
  }
  if (event.sequence !== state.revision + 1) {
    throw new InvalidTransitionError(
      `Event ${event.id} has sequence ${event.sequence}; expected ${state.revision + 1}`,
    );
  }

  switch (event.type) {
    case "run.created": {
      if (state.revision !== 0 || state.agent !== null) {
        throw new InvalidTransitionError(`Run ${state.runId} is already initialized`);
      }
      return {
        effects: [],
        state: advance(state, event.sequence, { agent: event.payload.agent }),
      };
    }

    case "run.forked": {
      if (state.revision === 0 || state.agent === null) {
        throw new InvalidTransitionError(
          `Run ${state.runId} cannot record lineage before its copied prefix`,
        );
      }
      return {
        effects: [],
        state: advance(state, event.sequence, {
          error: null,
          lineage: event.payload,
          pauseRequested: false,
          pendingEffects: {},
          readyEffects: [],
          result: null,
          status: "created",
          waitingReason: null,
        }),
      };
    }

    case "input.received": {
      requireStatus(state, event.type, "created");
      const nextState = advance(state, event.sequence, {
        messages: [
          ...state.messages,
          { content: event.payload.content, role: "user" },
        ],
        status: "running",
      });
      const effects = [createModelEffect(nextState, event.id, 0)];
      return withReadyEffects(nextState, event.sequence, effects);
    }

    case "run.pause_requested": {
      requireStatus(state, event.type, "running");
      if (state.pauseRequested) {
        throw new InvalidTransitionError(`Run ${state.runId} already has a pause request`);
      }
      return {
        effects: [],
        state: advance(state, event.sequence, { pauseRequested: true }),
      };
    }

    case "run.paused": {
      requireStatus(state, event.type, "running");
      if (!state.pauseRequested) {
        throw new InvalidTransitionError(`Run ${state.runId} has no pause request`);
      }
      return {
        effects: [],
        state: advance(state, event.sequence, {
          pauseRequested: false,
          status: "paused",
        }),
      };
    }

    case "run.resumed": {
      requireStatus(state, event.type, "paused");
      return {
        effects: state.readyEffects,
        state: advance(state, event.sequence, {
          status: "running",
          waitingReason: null,
        }),
      };
    }

    case "run.waiting": {
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
      const accepted = acceptRequest(state, event.payload.effect);
      return {
        effects: [],
        state: advance(state, event.sequence, accepted),
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
      const nextState = advance(state, event.sequence, {
        messages: [
          ...state.messages,
          {
            content: response.content,
            role: "assistant",
            toolCalls: response.toolCalls,
          },
        ],
        pauseRequested:
          response.toolCalls.length === 0 ? false : state.pauseRequested,
        pendingEffects: remaining,
        result: response.toolCalls.length === 0 ? response.content : null,
        status: response.toolCalls.length === 0 ? "completed" : "running",
      });
      const effects = response.toolCalls.map((call, index) =>
        createToolEffect(nextState, call, event.id, index),
      );
      return withReadyEffects(nextState, event.sequence, effects);
    }

    case "model.failed": {
      requireStatus(state, event.type, "running");
      const remaining = removePending(
        state,
        event.payload.effectId,
        "model.generate",
      );
      return {
        effects: [],
        state: advance(state, event.sequence, {
          error: event.payload.error,
          pauseRequested: false,
          pendingEffects: remaining,
          readyEffects: [],
          status: "failed",
        }),
      };
    }

    case "tool.requested": {
      requireStatus(state, event.type, "running");
      const accepted = acceptRequest(state, event.payload.effect);
      return {
        effects: [],
        state: advance(state, event.sequence, accepted),
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
        pendingEffects: remaining,
      });
      const hasPendingTools = Object.values(remaining).some(
        (effect) => effect.type === "tool.execute",
      );
      if (hasPendingTools) {
        return { effects: [], state: nextState };
      }
      if (nextState.error !== null) {
        return {
          effects: [],
          state: {
            ...nextState,
            pauseRequested: false,
            readyEffects: [],
            status: "failed",
          },
        };
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
        state,
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
  runId: string,
  events: readonly AnyRunEvent[],
): RunState {
  let state = createInitialRunState(runId);
  for (const event of events) {
    state = reduce(state, event).state;
  }
  return state;
}
