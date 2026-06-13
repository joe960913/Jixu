import type {
  AgentSnapshot,
  DriverError,
  RunState,
  ToolCall,
} from "./domain.ts";
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

function requireRunning(state: RunState, eventType: string): void {
  if (state.status !== "running") {
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

function addPending(
  state: RunState,
  effect: EffectRequest,
): Readonly<Record<string, EffectRequest>> {
  if (state.pendingEffects[effect.id] !== undefined) {
    throw new InvalidTransitionError(`Effect ${effect.id} is already pending`);
  }
  if (effect.runId !== state.runId) {
    throw new InvalidTransitionError(
      `Effect ${effect.id} belongs to Run ${effect.runId}`,
    );
  }
  return { ...state.pendingEffects, [effect.id]: effect };
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
      pendingEffects: remaining,
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

    case "input.received": {
      if (state.status !== "created") {
        throw new InvalidTransitionError(
          `Initial input cannot apply while Run ${state.runId} is ${state.status}`,
        );
      }
      const nextState = advance(state, event.sequence, {
        messages: [
          ...state.messages,
          { content: event.payload.content, role: "user" },
        ],
        status: "running",
      });
      return {
        effects: [createModelEffect(nextState, event.id, 0)],
        state: nextState,
      };
    }

    case "model.requested": {
      requireRunning(state, event.type);
      return {
        effects: [],
        state: advance(state, event.sequence, {
          pendingEffects: addPending(state, event.payload.effect),
        }),
      };
    }

    case "model.completed": {
      requireRunning(state, event.type);
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
        pendingEffects: remaining,
        result: response.toolCalls.length === 0 ? response.content : null,
        status: response.toolCalls.length === 0 ? "completed" : "running",
      });
      return {
        effects: response.toolCalls.map((call, index) =>
          createToolEffect(nextState, call, event.id, index),
        ),
        state: nextState,
      };
    }

    case "model.failed": {
      requireRunning(state, event.type);
      const remaining = removePending(
        state,
        event.payload.effectId,
        "model.generate",
      );
      return {
        effects: [],
        state: advance(state, event.sequence, {
          error: event.payload.error,
          pendingEffects: remaining,
          status: "failed",
        }),
      };
    }

    case "tool.requested": {
      requireRunning(state, event.type);
      return {
        effects: [],
        state: advance(state, event.sequence, {
          pendingEffects: addPending(state, event.payload.effect),
        }),
      };
    }

    case "tool.completed": {
      requireRunning(state, event.type);
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
          state: { ...nextState, status: "failed" },
        };
      }
      return {
        effects: [createModelEffect(nextState, event.id, 0)],
        state: nextState,
      };
    }

    case "tool.failed": {
      requireRunning(state, event.type);
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
  let state: RunState = {
    agent: null,
    error: null,
    messages: [],
    pendingEffects: {},
    result: null,
    revision: 0,
    runId,
    status: "created",
  };
  for (const event of events) {
    state = reduce(state, event).state;
  }
  return state;
}
