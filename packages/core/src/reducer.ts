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
  compileModelContext,
  MAX_PLAN_REPAIR_ATTEMPTS,
} from "./context.ts";
import type { ModelContinuation } from "./context.ts";
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
  expandPlanUpdateProposals,
  materializePlanUpdates,
  samePlan,
} from "./plan.ts";

export const REDUCER_VERSION = 13;

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

function requireOneStatus(
  state: ThreadState,
  eventType: string,
  expected: readonly ThreadState["status"][],
): void {
  if (!expected.includes(state.status)) {
    throw new InvalidTransitionError(
      `${eventType} cannot apply while Thread ${state.threadId} is ${state.status}`,
    );
  }
}

function withoutApproval(
  state: ThreadState,
  effectId: string,
): Pick<ThreadState, "status" | "toolApprovals" | "waitingReason"> {
  const toolApprovals = { ...state.toolApprovals };
  delete toolApprovals[effectId];
  const unresolved = Object.values(toolApprovals).find(
    (approval) => approval.decision === null,
  );
  if (unresolved !== undefined) {
    return {
      status: "waiting",
      toolApprovals,
      waitingReason: {
        effectId: unresolved.effectId,
        reasonCode: "tool_approval_required",
      },
    };
  }
  return {
    status: state.status === "waiting" ? "running" : state.status,
    toolApprovals,
    waitingReason:
      state.waitingReason?.reasonCode === "tool_approval_required"
        ? null
        : state.waitingReason,
  };
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
  const ready = state.readyEffects[readyIndex];
  if (readyIndex < 0 || ready === undefined || !sameReadyEffect(ready, effect)) {
    throw new InvalidTransitionError(`Effect ${effect.id} is not ready`);
  }
  return {
    pendingEffects: { ...state.pendingEffects, [effect.id]: effect },
    readyEffects: state.readyEffects.filter((_, index) => index !== readyIndex),
  };
}

function sameReadyEffect(
  expected: EffectRequest,
  persisted: EffectRequest,
): boolean {
  if (
    expected.attempt !== persisted.attempt ||
    expected.id !== persisted.id ||
    expected.idempotencyKey !== persisted.idempotencyKey ||
    expected.requestedByEventId !== persisted.requestedByEventId ||
    expected.threadId !== persisted.threadId ||
    expected.type !== persisted.type
  ) {
    return false;
  }

  if (expected.type === "tool.execute") {
    return (
      persisted.type === "tool.execute" &&
      jsonEquals(expected.input, persisted.input)
    );
  }
  if (persisted.type !== "model.generate") {
    return false;
  }

  const expectedBase = {
    activePlan: expected.input.activePlan,
    instructions: expected.input.instructions,
    messages: expected.input.messages,
    model: expected.input.model,
    planControlName: expected.input.planControl.name,
    planRejectionFeedback: expected.input.planRejectionFeedback ?? null,
    progressControlName: expected.input.progressControl.name,
    tools: expected.input.tools,
  };
  const persistedBase = {
    activePlan: persisted.input.activePlan,
    instructions: persisted.input.instructions,
    messages: persisted.input.messages,
    model: persisted.input.model,
    planControlName: persisted.input.planControl.name,
    planRejectionFeedback: persisted.input.planRejectionFeedback ?? null,
    progressControlName: persisted.input.progressControl.name,
    tools: persisted.input.tools,
  };
  if (
    persisted.input.contextManifest === undefined &&
    persisted.input.runtimeContext === undefined
  ) {
    return jsonEquals(expectedBase, persistedBase);
  }
  return jsonEquals(
    {
      ...expectedBase,
      contextManifest: expected.input.contextManifest ?? null,
      runtimeContext: expected.input.runtimeContext ?? null,
    },
    {
      ...persistedBase,
      contextManifest: persisted.input.contextManifest ?? null,
      runtimeContext: persisted.input.runtimeContext ?? null,
    },
  );
}

function createModelEffect(
  state: ThreadState,
  continuation: ModelContinuation,
  index: number,
): ModelGenerateEffect {
  const id = `${continuation.eventId}:effect:${index}`;
  return {
    attempt: 1,
    id,
    idempotencyKey: id,
    input: compileModelContext(state, continuation),
    requestedByEventId: continuation.eventId,
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
    messages: [
      ...state.messages,
      {
        content: next.content,
        ...(next.parts === undefined ? {} : { parts: next.parts }),
        role: "user",
      },
    ],
    planRepairAttempts: 0,
    result: null,
    status: "running",
    waitingReason: null,
  });
  const effects = [
    createModelEffect(
      nextState,
      { eventId: next.eventId, reason: "input_received" },
      0,
    ),
  ];
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
          planRepairAttempts: 0,
          pendingPlanRejections: [],
          pendingPlanUpdates: [],
          readyEffects: [],
          result: null,
          status: "idle",
          toolApprovals: {},
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
              {
                content: event.payload.content,
                eventId: event.id,
                ...(event.payload.parts === undefined
                  ? {}
                  : { parts: event.payload.parts }),
              },
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
          {
            content: event.payload.content,
            ...(event.payload.parts === undefined
              ? {}
              : { parts: event.payload.parts }),
            role: "user",
          },
        ],
        result: null,
        planRepairAttempts: 0,
        status: "running",
      });
      const effects = [
        createModelEffect(
          nextState,
          { eventId: event.id, reason: "input_received" },
          0,
        ),
      ];
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
          planRepairAttempts: 0,
          pendingPlanRejections: [],
          pendingPlanUpdates: [],
          result: null,
          toolApprovals: {},
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

    case "approval.requested": {
      requireOneStatus(state, event.type, ["running", "waiting"]);
      const effect = state.pendingEffects[event.payload.effectId];
      if (
        effect === undefined ||
        effect.type !== "tool.execute" ||
        effect.input.name !== event.payload.name ||
        effect.input.toolCallId !== event.payload.toolCallId
      ) {
        throw new InvalidTransitionError(
          `Approval Effect ${event.payload.effectId} is not a matching pending Tool`,
        );
      }
      if (state.toolApprovals[event.payload.effectId] !== undefined) {
        throw new InvalidTransitionError(
          `Approval Effect ${event.payload.effectId} is already recorded`,
        );
      }
      const approval = Object.freeze({
        ...event.payload,
        decision: null,
        decisionEventId: null,
      });
      const toolApprovals = {
        ...state.toolApprovals,
        [event.payload.effectId]: approval,
      };
      const first = Object.values(toolApprovals).find(
        (candidate) => candidate.decision === null,
      );
      if (first === undefined) {
        throw new InvalidTransitionError("Approval request did not remain pending");
      }
      return {
        effects: [],
        state: advance(state, event.sequence, {
          pauseRequested: false,
          status: "waiting",
          toolApprovals,
          waitingReason: {
            effectId: first.effectId,
            reasonCode: "tool_approval_required",
          },
        }),
      };
    }

    case "approval.decided": {
      requireOneStatus(state, event.type, ["running", "waiting"]);
      const approval = state.toolApprovals[event.payload.effectId];
      if (approval === undefined || approval.decision !== null) {
        throw new InvalidTransitionError(
          `Approval Effect ${event.payload.effectId} is not awaiting a decision`,
        );
      }
      const toolApprovals = {
        ...state.toolApprovals,
        [event.payload.effectId]: {
          ...approval,
          decision: event.payload.decision,
          decisionEventId: event.id,
        },
      };
      const unresolved = Object.values(toolApprovals).find(
        (candidate) => candidate.decision === null,
      );
      return {
        effects: [],
        state: advance(state, event.sequence, {
          status: unresolved === undefined ? "running" : "waiting",
          toolApprovals,
          waitingReason:
            unresolved === undefined
              ? null
              : {
                  effectId: unresolved.effectId,
                  reasonCode: "tool_approval_required",
                },
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
      const completedEffect = state.pendingEffects[event.payload.effectId];
      if (completedEffect === undefined || completedEffect.type !== "model.generate") {
        throw new InvalidTransitionError(
          `Effect ${event.payload.effectId} is not pending as model.generate`,
        );
      }
      const remaining = removePending(
        state,
        event.payload.effectId,
        "model.generate",
      );
      const response = event.payload.response;
      const identitySeed = `sequence-${event.sequence}`;
      const repairAttempt =
        Math.max(
          state.planRepairAttempts,
          completedEffect.input.runtimeContext?.planRepair?.attempt ?? 0,
        ) + 1;
      const expandedPlanUpdates =
        completedEffect.input.runtimeContext === undefined
          ? response.planUpdates ?? []
          : expandPlanUpdateProposals(
              state.activePlan,
              response.planUpdates ?? [],
            );
      let pendingPlanUpdates = expandedPlanUpdates.map(
        (proposal, index) => ({
          identitySeed: `${identitySeed}-${index}`,
          proposal,
        }),
      );
      const pendingPlanRejections = (event.payload.planRejections ?? []).map(
        (rejection) => ({ ...rejection, repairAttempt }),
      );
      for (const rejection of pendingPlanRejections) {
        if (rejection.effectId !== event.payload.effectId) {
          throw new InvalidTransitionError(
            `Plan rejection ${rejection.effectId} does not match Model Effect ${event.payload.effectId}`,
          );
        }
      }
      try {
        materializePlanUpdates(
          state.activePlan,
          expandedPlanUpdates,
          identitySeed,
          {
            expandAtomicSupersede:
              completedEffect.input.runtimeContext !== undefined,
          },
        );
      } catch (error) {
        pendingPlanRejections.push({
          effectId: event.payload.effectId,
          error: {
            code: "plan_update_invalid",
            message:
              error instanceof Error ? error.message : "Invalid Plan update",
            retryable: false,
          },
          proposals: response.planUpdates ?? [],
          repairAttempt,
        });
        pendingPlanUpdates = [];
      }
      const planOnlyControl =
        response.content.trim().length === 0 &&
        response.toolCalls.length === 0 &&
        (pendingPlanUpdates.length > 0 || pendingPlanRejections.length > 0);
      const metrics = recordModelAccounting(
        recordEffectOutcome(state.metrics, "model", "succeeded"),
        event.payload.accounting,
      );
      const nextState = advance(state, event.sequence, {
        messages: planOnlyControl
          ? state.messages
          : [
              ...state.messages,
              {
                content: response.content,
                role: "assistant",
                toolCalls: response.toolCalls,
              },
            ],
        metrics,
        pendingEffects: remaining,
        pendingPlanRejections,
        pendingPlanUpdates,
      });
      if (planOnlyControl) {
        return { effects: [], state: nextState };
      }
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
      const pendingPlanUpdates = state.pendingPlanUpdates.slice(1);
      const nextState = advance(state, event.sequence, {
        activePlan:
          event.payload.plan.status === "active" ? event.payload.plan : null,
        pendingPlanUpdates,
      });
      if (
        state.status === "running" &&
        state.pendingPlanRejections.length === 0 &&
        pendingPlanUpdates.length === 0 &&
        Object.keys(state.pendingEffects).length === 0 &&
        state.readyEffects.length === 0
      ) {
        const effects = [
          createModelEffect(
            nextState,
            {
              eventId: event.id,
              plan: event.payload.plan,
              reason: "plan_updated",
            },
            0,
          ),
        ];
        return withReadyEffects(nextState, event.sequence, effects);
      }
      return { effects: [], state: nextState };
    }

    case "plan.rejected": {
      requireAgent(state);
      const expected = state.pendingPlanRejections[0];
      if (expected === undefined) {
        // Event schema 5 originally persisted plan.rejected immediately after a
        // stripped model.completed response, before pending rejection recovery
        // became State-derived. Preserve replay compatibility for those Events.
        return {
          effects: [],
          state: advance(state, event.sequence, {}),
        };
      }
      const comparableExpected =
        event.payload.repairAttempt === undefined
          ? {
              effectId: expected.effectId,
              error: expected.error,
              proposals: expected.proposals,
            }
          : expected;
      if (!jsonEquals(comparableExpected, event.payload)) {
        throw new InvalidTransitionError(
          `Plan rejection for ${event.payload.effectId} is not pending`,
        );
      }
      const pendingPlanRejections = state.pendingPlanRejections.slice(1);
      const repairAttempt =
        event.payload.repairAttempt ?? state.planRepairAttempts + 1;
      const nextState = advance(state, event.sequence, {
        pendingPlanRejections,
        planRepairAttempts: Math.max(state.planRepairAttempts, repairAttempt),
      });
      if (
        state.status !== "running" ||
        pendingPlanRejections.length > 0 ||
        state.pendingPlanUpdates.length > 0 ||
        Object.keys(state.pendingEffects).length > 0 ||
        state.readyEffects.length > 0
      ) {
        return {
          effects: [],
          state: nextState,
        };
      }
      if (
        event.payload.repairAttempt !== undefined &&
        repairAttempt > MAX_PLAN_REPAIR_ATTEMPTS
      ) {
        return settleTurn(nextState, event.sequence, {
          error: {
            code: "plan_repair_exhausted",
            message:
              "Plan control correction limit reached; the last accepted Plan was preserved",
            retryable: false,
          },
          result: null,
        });
      }
      const effects = [
        createModelEffect(
          nextState,
          {
            error: event.payload.error,
            eventId: event.id,
            reason: "plan_rejected",
          },
          0,
        ),
      ];
      return withReadyEffects(nextState, event.sequence, effects);
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
      requireOneStatus(state, event.type, ["running", "waiting"]);
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
        ...withoutApproval(state, event.payload.effectId),
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
      const effects = [
        createModelEffect(
          nextState,
          {
            eventId: event.id,
            reason: "tool_completed",
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.name,
          },
          0,
        ),
      ];
      return withReadyEffects(nextState, event.sequence, effects);
    }

    case "tool.failed": {
      requireOneStatus(state, event.type, ["running", "waiting"]);
      const remaining = removePending(
        state,
        event.payload.effectId,
        "tool.execute",
      );
      return failAfterToolOutcome(
        advance(state, event.sequence, {
          ...withoutApproval(state, event.payload.effectId),
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
