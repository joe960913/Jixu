import { contextPolicyFor } from "./context-policy.ts";
import type { ContextPolicy } from "./context-policy.ts";
import { modelCapabilityProfileFor } from "./model-capabilities.ts";
import type { ModelCapabilityProfile } from "./model-capabilities.ts";
import type {
  DriverError,
  ModelMessage,
  ModelRef,
  ThreadState,
  ToolDescriptor,
} from "./domain.ts";
import type { ModelGenerateInput } from "./effects.ts";
import { InvalidTransitionError } from "./errors.ts";
import type { ArtifactReference } from "./input.ts";
import {
  assertJsonValue,
  canonicalJson,
  isJsonObject,
  jsonDigest,
} from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { PlanControlDescriptor, PlanSnapshot } from "./plan.ts";
import { createPlanControl } from "./plan.ts";
import type { ProgressControlDescriptor } from "./progress.ts";
import { PROGRESS_CONTROL } from "./progress.ts";

export const CONTEXT_COMPILER_VERSION = 2;
export const CONTEXT_ESTIMATOR_VERSION = 1;
export const CONTEXT_MANIFEST_SCHEMA_VERSION = 2;
export const CONTINUITY_HANDOFF_SCHEMA_VERSION = 1;
export const MODEL_CONTEXT_SCHEMA_VERSION = 1;
export const MAX_PLAN_REPAIR_ATTEMPTS = 1;

const MAX_HANDOFF_FACTS = 64;
const MAX_HANDOFF_FACT_TEXT = 1_000;
const MAX_HANDOFF_SOURCE_IDS = 16;
const MAX_HANDOFF_BYTES = 64 * 1024;

export interface ContextBoundary {
  readonly eventId: string;
  readonly sequence: number;
}

export interface ModelMessageSource extends ContextBoundary {}

export type ModelContinuationReason =
  | "input_received"
  | "plan_rejected"
  | "plan_updated"
  | "tool_completed";

export type ModelContextObligation =
  | "repair_plan_control"
  | "respond_or_act";

export type ModelContextProhibition =
  | "repeat_accepted_plan_change"
  | "repeat_rejected_plan_change";

export interface ModelContextReceipt {
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly eventId: string;
  readonly planId?: string;
  readonly planRevision?: number;
  readonly planStatus?: PlanSnapshot["status"];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly type:
    | "input.received"
    | "plan.rejected"
    | "plan.updated"
    | "tool.completed";
}

export interface ModelRuntimeContext {
  readonly continuation: {
    readonly causedByEventId: string;
    readonly reason: ModelContinuationReason;
    readonly receipt: ModelContextReceipt;
  };
  readonly obligations: readonly ModelContextObligation[];
  readonly planRepair: {
    readonly attempt: number;
    readonly limit: number;
  } | null;
  readonly prohibitions: readonly ModelContextProhibition[];
  readonly schemaVersion: 1;
}

export type ModelContextSourceKind =
  | "active_plan"
  | "agent"
  | "artifact"
  | "handoff"
  | "message"
  | "messages"
  | "runtime"
  | "tools";

export interface ModelContextSourceManifest {
  readonly causedByEventId: string | null;
  readonly digest: string | null;
  readonly disposition: "excluded" | "included" | "transformed";
  readonly estimatedTokens: number;
  readonly id: string;
  readonly kind: ModelContextSourceKind;
  readonly priority: number;
  readonly reason: string;
  readonly sensitivity: "internal" | "private";
  readonly trust: "accepted";
  readonly version: string;
}

export interface ModelContextManifest {
  readonly acceptedHandoffDigest: string | null;
  readonly activeClearBoundary: ContextBoundary | null;
  readonly activePlanRevision: number | null;
  readonly compilerVersion: 2;
  readonly contextPolicySchemaVersion: 1;
  readonly estimatedInputTokens: number;
  readonly estimatorVersion: 1;
  readonly inputBudgetTokens: number;
  readonly logicalRequestDigest: string;
  readonly modelCapabilities: ModelCapabilityProfile;
  readonly outputBudgetTokens: number;
  readonly rawTailBudgetTokens: number;
  readonly rawTailBoundary: ContextBoundary | null;
  readonly safetyMarginTokens: number;
  readonly schemaVersion: 2;
  readonly sources: readonly ModelContextSourceManifest[];
}

export interface ContinuityHandoffFact {
  readonly sourceEventIds: readonly string[];
  readonly text: string;
}

export interface ContinuityHandoffBody {
  readonly acceptanceCriteria: readonly ContinuityHandoffFact[];
  readonly artifacts: readonly ContinuityHandoffFact[];
  readonly attemptedApproaches: readonly ContinuityHandoffFact[];
  readonly blockers: readonly ContinuityHandoffFact[];
  readonly completedEvidence: readonly ContinuityHandoffFact[];
  readonly constraints: readonly ContinuityHandoffFact[];
  readonly currentState: readonly ContinuityHandoffFact[];
  readonly decisions: readonly ContinuityHandoffFact[];
  readonly doNotRetry: readonly ContinuityHandoffFact[];
  readonly failures: readonly ContinuityHandoffFact[];
  readonly nextAction: ContinuityHandoffFact | null;
  readonly objective: ContinuityHandoffFact | null;
  readonly pendingEffects: readonly ContinuityHandoffFact[];
  readonly permissions: readonly ContinuityHandoffFact[];
  readonly rejectedAlternatives: readonly ContinuityHandoffFact[];
  readonly relevantFiles: readonly ContinuityHandoffFact[];
  readonly scope: readonly ContinuityHandoffFact[];
  readonly summary: readonly ContinuityHandoffFact[];
  readonly unresolvedQuestions: readonly ContinuityHandoffFact[];
  readonly validation: readonly ContinuityHandoffFact[];
  readonly waitsAndApprovals: readonly ContinuityHandoffFact[];
}

export interface ContinuityHandoff {
  readonly activePlan: PlanSnapshot | null;
  readonly body: ContinuityHandoffBody;
  readonly model: ModelRef;
  readonly previousHandoffDigest: string | null;
  readonly schemaVersion: 1;
  readonly source: {
    readonly clearBoundary: ContextBoundary | null;
    readonly compilerVersion: 2;
    readonly eventIds: readonly string[];
    readonly fromSequence: number;
    readonly messageThroughSequence: number;
    readonly threadId: string;
    readonly throughSequence: number;
  };
}

export interface AcceptedContinuityHandoff {
  readonly artifact: ArtifactReference;
  readonly handoff: ContinuityHandoff;
}

export type ModelContinuation =
  | { readonly eventId: string; readonly reason: "input_received" }
  | {
      readonly eventId: string;
      readonly plan: PlanSnapshot;
      readonly reason: "plan_updated";
    }
  | {
      readonly error: DriverError;
      readonly eventId: string;
      readonly reason: "plan_rejected";
    }
  | {
      readonly eventId: string;
      readonly reason: "tool_completed";
      readonly toolCallId: string;
      readonly toolName: string;
    };

export interface ContextCompactionInput {
  readonly activePlan: PlanSnapshot | null;
  readonly clearBoundary: ContextBoundary | null;
  readonly continuation: ModelContinuation;
  readonly model: ModelRef;
  readonly modelCapabilities: ModelCapabilityProfile;
  readonly minimumInputTokens: number;
  readonly nextEffectIndex: number;
  readonly policy: ContextPolicy;
  readonly previousHandoff: AcceptedContinuityHandoff | null;
  readonly sourceEventIds: readonly string[];
  readonly sourceFromSequence: number;
  readonly sourceManifest: readonly ModelContextSourceManifest[];
  readonly sourceMessageThroughSequence: number;
  readonly sourceMessages: readonly ModelMessage[];
  readonly sourceThreadId: string;
  readonly sourceThroughSequence: number;
  readonly targetTokens: number;
}

export type ContextCompilation =
  | { readonly input: ContextCompactionInput; readonly kind: "compaction" }
  | { readonly input: ModelGenerateInput; readonly kind: "model" };

interface MessageCandidate {
  readonly index: number;
  readonly message: ModelMessage;
  readonly source: ModelMessageSource;
  readonly tokens: number;
}

function receiptFor(continuation: ModelContinuation): ModelContextReceipt {
  switch (continuation.reason) {
    case "input_received":
      return { eventId: continuation.eventId, type: "input.received" };
    case "plan_updated":
      return {
        eventId: continuation.eventId,
        planId: continuation.plan.id,
        planRevision: continuation.plan.revision,
        planStatus: continuation.plan.status,
        type: "plan.updated",
      };
    case "plan_rejected":
      return {
        errorCode: continuation.error.code,
        errorMessage: normalizePlanRejectionFeedback(continuation.error.message),
        eventId: continuation.eventId,
        type: "plan.rejected",
      };
    case "tool_completed":
      return {
        eventId: continuation.eventId,
        toolCallId: continuation.toolCallId,
        toolName: continuation.toolName,
        type: "tool.completed",
      };
  }
}

function normalizePlanRejectionFeedback(message: string): string {
  return message.trim().replace(/\s+/gu, " ").slice(0, 500);
}

function runtimeContext(
  state: ThreadState,
  continuation: ModelContinuation,
): ModelRuntimeContext {
  const repairing = continuation.reason === "plan_rejected";
  return {
    continuation: {
      causedByEventId: continuation.eventId,
      reason: continuation.reason,
      receipt: receiptFor(continuation),
    },
    obligations: repairing
      ? ["repair_plan_control", "respond_or_act"]
      : ["respond_or_act"],
    planRepair:
      state.planRepairAttempts === 0 && !repairing
        ? null
        : {
            attempt: state.planRepairAttempts,
            limit: MAX_PLAN_REPAIR_ATTEMPTS,
          },
    prohibitions:
      continuation.reason === "plan_updated"
        ? ["repeat_accepted_plan_change"]
        : continuation.reason === "plan_rejected"
          ? ["repeat_rejected_plan_change"]
          : [],
    schemaVersion: MODEL_CONTEXT_SCHEMA_VERSION,
  };
}

function utf8Length(value: JsonValue): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export function estimateContextTokens(value: unknown): number {
  assertJsonValue(value, "Context estimate source");
  return Math.max(1, Math.ceil(utf8Length(value) / 3));
}

function imageCharge(message: ModelMessage): number {
  if (message.role !== "user" || message.parts === undefined) return 0;
  return message.parts.reduce(
    (total, part) =>
      part.type === "image" ? total + part.artifact.byteLength : total,
    0,
  );
}

function messageTokens(message: ModelMessage): number {
  return estimateContextTokens(message) + imageCharge(message);
}

function source(
  input: Omit<ModelContextSourceManifest, "trust">,
): ModelContextSourceManifest {
  return { ...input, trust: "accepted" };
}

function messageSource(
  candidate: MessageCandidate,
  disposition: ModelContextSourceManifest["disposition"],
  reason: string,
): ModelContextSourceManifest {
  return source({
    causedByEventId: candidate.source.eventId,
    digest: jsonDigest(candidate.message),
    disposition,
    estimatedTokens: candidate.tokens,
    id: `message:${candidate.source.eventId}`,
    kind: "message",
    priority: candidate.message.role === "user" ? 90 : 80,
    reason,
    sensitivity: "private",
    version: `event:${candidate.source.sequence}`,
  });
}

function artifactSources(
  candidate: MessageCandidate,
  disposition: ModelContextSourceManifest["disposition"],
  reason: string,
): readonly ModelContextSourceManifest[] {
  if (candidate.message.role !== "user" || candidate.message.parts === undefined) {
    return [];
  }
  return candidate.message.parts.flatMap((part) =>
    part.type === "image"
      ? [
          source({
            causedByEventId: candidate.source.eventId,
            digest: part.artifact.digest,
            disposition,
            estimatedTokens: part.artifact.byteLength,
            id: `artifact:${part.artifact.digest}:${candidate.source.eventId}`,
            kind: "artifact",
            priority: 85,
            reason,
            sensitivity: "private",
            version: `${part.artifact.mediaType}:${part.artifact.byteLength}`,
          }),
        ]
      : [],
  );
}

function candidates(state: ThreadState): readonly MessageCandidate[] {
  if (state.messages.length !== state.messageSources.length) {
    throw new InvalidTransitionError(
      `Thread ${state.threadId} message provenance does not match its message projection`,
    );
  }
  return state.messages.map((message, index) => {
    const sourceValue = state.messageSources[index];
    if (sourceValue === undefined) {
      throw new InvalidTransitionError(
        `Thread ${state.threadId} message ${index} has no provenance`,
      );
    }
    return { index, message, source: sourceValue, tokens: messageTokens(message) };
  });
}

function messageGroups(
  values: readonly MessageCandidate[],
): readonly (readonly MessageCandidate[])[] {
  const groups: MessageCandidate[][] = [];
  for (let index = 0; index < values.length; index += 1) {
    const candidate = values[index];
    if (candidate === undefined) continue;
    if (
      candidate.message.role === "assistant" &&
      candidate.message.toolCalls.length > 0
    ) {
      const callIds = new Set(candidate.message.toolCalls.map((call) => call.id));
      const group = [candidate];
      while (index + 1 < values.length) {
        const following = values[index + 1];
        if (
          following === undefined ||
          following.message.role !== "tool" ||
          !callIds.has(following.message.toolCallId)
        ) {
          break;
        }
        group.push(following);
        index += 1;
      }
      groups.push(group);
      continue;
    }
    groups.push([candidate]);
  }
  return groups;
}

function selectRawTail(
  values: readonly MessageCandidate[],
  tokenBudget: number,
): ReadonlySet<number> {
  const selected = new Set<number>();
  let remaining = Math.max(0, tokenBudget);
  const groups = messageGroups(values);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === undefined) continue;
    const cost = group.reduce((total, candidate) => total + candidate.tokens, 0);
    if (cost > remaining) break;
    for (const candidate of group) selected.add(candidate.index);
    remaining -= cost;
  }
  return selected;
}

function modelInputEstimate(input: {
  readonly activePlan: PlanSnapshot | null;
  readonly handoff: ContinuityHandoff | null;
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly planControl: PlanControlDescriptor;
  readonly progressControl: ProgressControlDescriptor;
  readonly runtime: ModelRuntimeContext;
  readonly tools: readonly ToolDescriptor[];
}): number {
  return (
    estimateContextTokens(input) +
    input.messages.reduce((total, message) => total + imageCharge(message), 0)
  );
}

function logicalRequestDigest(input: {
  readonly activePlan: PlanSnapshot | null;
  readonly continuityHandoff: ContinuityHandoff | null;
  readonly contextPolicy: ContextPolicy;
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly mode: ThreadState["mode"];
  readonly model: ModelRef;
  readonly modelCapabilities: ModelCapabilityProfile;
  readonly planControl: PlanControlDescriptor;
  readonly planRejectionFeedback: string | null;
  readonly progressControl: ProgressControlDescriptor;
  readonly runtime: ModelRuntimeContext;
  readonly tools: readonly ToolDescriptor[];
}): string {
  return jsonDigest(input);
}

function modelCompilation(
  state: ThreadState,
  runtime: ModelRuntimeContext,
  planRejectionFeedback: string | undefined,
  selected: ReadonlySet<number>,
  all: readonly MessageCandidate[],
  policy: ContextPolicy,
): ModelGenerateInput {
  const agent = state.agent;
  if (agent === null) {
    throw new InvalidTransitionError(`Thread ${state.threadId} has no Agent definition`);
  }
  const planControl = createPlanControl(state.activePlan);
  const modelCapabilities = modelCapabilityProfileFor(agent.modelCapabilities);
  const handoff = state.acceptedHandoff?.handoff ?? null;
  const boundary = handoff?.source.messageThroughSequence ?? 0;
  const selectedCandidates = all.filter(
    (candidate) =>
      candidate.source.sequence > boundary && selected.has(candidate.index),
  );
  const messages = selectedCandidates.map((candidate) => candidate.message);
  const estimatedInputTokens = modelInputEstimate({
    activePlan: state.activePlan,
    handoff,
    instructions: agent.instructions,
    messages,
    planControl,
    progressControl: PROGRESS_CONTROL,
    runtime,
    tools: agent.tools,
  });
  const inputBudgetTokens =
    policy.contextWindowTokens -
    policy.reservedOutputTokens -
    policy.safetyMarginTokens;
  const sources: ModelContextSourceManifest[] = [
    source({
      causedByEventId: null,
      digest: jsonDigest({
        contextPolicy: policy,
        instructions: agent.instructions,
        model: agent.model,
        modelCapabilities,
        tools: agent.tools,
      }),
      disposition: "included",
      estimatedTokens: estimateContextTokens(agent.instructions),
      id: `agent:${jsonDigest({
        contextPolicy: policy,
        instructions: agent.instructions,
        model: agent.model,
        modelCapabilities,
        tools: agent.tools,
      })}`,
      kind: "agent",
      priority: 100,
      reason: "immutable Agent configuration",
      sensitivity: "internal",
      version: `context-policy:${policy.schemaVersion}:${jsonDigest(policy)}`,
    }),
    source({
      causedByEventId: null,
      digest: jsonDigest(agent.tools),
      disposition: "included",
      estimatedTokens: estimateContextTokens(agent.tools),
      id: `tools:${jsonDigest(agent.tools)}`,
      kind: "tools",
      priority: 95,
      reason: "Agent Tool descriptors",
      sensitivity: "internal",
      version: "agent-snapshot",
    }),
    state.activePlan === null
      ? source({
          causedByEventId: null,
          digest: null,
          disposition: "excluded",
          estimatedTokens: 0,
          id: "active-plan:none",
          kind: "active_plan",
          priority: 95,
          reason: "Thread has no active Plan",
          sensitivity: "private",
          version: "none",
        })
      : source({
          causedByEventId: state.activePlanSource?.eventId ?? null,
          digest: jsonDigest(state.activePlan),
          disposition: "included",
          estimatedTokens: estimateContextTokens(state.activePlan),
          id: `plan:${state.activePlan.id}:r${state.activePlan.revision}`,
          kind: "active_plan",
          priority: 95,
          reason: "current accepted Plan projection",
          sensitivity: "private",
          version:
            state.activePlanSource === null
              ? `revision:${state.activePlan.revision}`
              : `event:${state.activePlanSource.sequence}:revision:${state.activePlan.revision}`,
        }),
    handoff === null
      ? source({
          causedByEventId: null,
          digest: null,
          disposition: "excluded",
          estimatedTokens: 0,
          id: "handoff:none",
          kind: "handoff",
          priority: 90,
          reason: "Thread has no accepted Continuity Handoff",
          sensitivity: "private",
          version: "none",
        })
      : source({
          causedByEventId: null,
          digest: state.acceptedHandoff?.artifact.digest ?? jsonDigest(handoff),
          disposition: "included",
          estimatedTokens: estimateContextTokens(handoff),
          id: `handoff:${state.acceptedHandoff?.artifact.digest ?? jsonDigest(handoff)}`,
          kind: "handoff",
          priority: 90,
          reason: "latest accepted Continuity Handoff",
          sensitivity: "private",
          version: `handoff:${handoff.schemaVersion}`,
        }),
  ];
  for (const candidate of all) {
    const representedByHandoff = candidate.source.sequence <= boundary;
    const included = selected.has(candidate.index) && !representedByHandoff;
    const disposition = representedByHandoff
      ? "transformed"
      : included
        ? "included"
        : "excluded";
    const reason = representedByHandoff
      ? "represented by the accepted Continuity Handoff"
      : included
        ? "selected in the complete recent raw tail"
        : "outside the selected raw-tail budget";
    sources.push(messageSource(candidate, disposition, reason));
    sources.push(...artifactSources(candidate, disposition, reason));
  }
  sources.push(
    source({
      causedByEventId: runtime.continuation.causedByEventId,
      digest: jsonDigest(runtime),
      disposition: "included",
      estimatedTokens: estimateContextTokens(runtime),
      id: `runtime:${jsonDigest(runtime)}`,
      kind: "runtime",
      priority: 100,
      reason: "Event-derived continuation semantics",
      sensitivity: "internal",
      version: `runtime:${runtime.schemaVersion}`,
    }),
  );
  const digest = logicalRequestDigest({
    activePlan: state.activePlan,
    continuityHandoff: handoff,
    contextPolicy: policy,
    instructions: agent.instructions,
    messages,
    mode: state.mode,
    model: agent.model,
    modelCapabilities,
    planControl,
    planRejectionFeedback: planRejectionFeedback ?? null,
    progressControl: PROGRESS_CONTROL,
    runtime,
    tools: agent.tools,
  });
  const manifest: ModelContextManifest = {
    acceptedHandoffDigest: state.acceptedHandoff?.artifact.digest ?? null,
    activeClearBoundary: state.contextClearBoundary,
    activePlanRevision: state.activePlan?.revision ?? null,
    compilerVersion: CONTEXT_COMPILER_VERSION,
    contextPolicySchemaVersion: policy.schemaVersion,
    estimatedInputTokens,
    estimatorVersion: CONTEXT_ESTIMATOR_VERSION,
    inputBudgetTokens,
    logicalRequestDigest: digest,
    modelCapabilities,
    outputBudgetTokens: policy.reservedOutputTokens,
    rawTailBudgetTokens: policy.rawTailTokens,
    rawTailBoundary: selectedCandidates[0]?.source ?? null,
    safetyMarginTokens: policy.safetyMarginTokens,
    schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
    sources,
  };
  return {
    activePlan: state.activePlan,
    contextManifest: manifest,
    continuityHandoff: handoff,
    instructions: agent.instructions,
    messages,
    mode: state.mode,
    model: agent.model,
    planControl,
    ...(planRejectionFeedback === undefined ? {} : { planRejectionFeedback }),
    progressControl: PROGRESS_CONTROL,
    runtimeContext: runtime,
    tools: agent.tools,
  };
}

export function compileContext(
  state: ThreadState,
  continuation: ModelContinuation,
  nextEffectIndex = 1,
): ContextCompilation {
  const agent = state.agent;
  if (agent === null) {
    throw new InvalidTransitionError(`Thread ${state.threadId} has no Agent definition`);
  }
  const modelCapabilities = modelCapabilityProfileFor(agent.modelCapabilities);
  const policy = contextPolicyFor(agent.contextPolicy, modelCapabilities);
  const runtime = runtimeContext(state, continuation);
  const planRejectionFeedback =
    continuation.reason === "plan_rejected"
      ? normalizePlanRejectionFeedback(continuation.error.message)
      : undefined;
  const all = candidates(state);
  const boundary =
    state.acceptedHandoff?.handoff.source.messageThroughSequence ?? 0;
  const active = all.filter((candidate) => candidate.source.sequence > boundary);
  const selectAll = new Set(active.map((candidate) => candidate.index));
  const full = modelCompilation(
    state,
    runtime,
    planRejectionFeedback,
    selectAll,
    all,
    policy,
  );
  const manifest = full.contextManifest;
  if (
    manifest !== undefined &&
    manifest.estimatedInputTokens <= manifest.inputBudgetTokens
  ) {
    return { input: full, kind: "model" };
  }

  const base = modelCompilation(
    state,
    runtime,
    planRejectionFeedback,
    new Set<number>(),
    all,
    policy,
  );
  const baseTokens = base.contextManifest?.estimatedInputTokens ?? 0;
  const irreducible = modelCompilation(
    { ...state, acceptedHandoff: null },
    runtime,
    planRejectionFeedback,
    new Set<number>(),
    all,
    policy,
  );
  const minimumInputTokens =
    irreducible.contextManifest?.estimatedInputTokens ?? 0;
  const availableTail = Math.max(
    0,
    Math.min(
      policy.rawTailTokens,
      (manifest?.inputBudgetTokens ?? 0) - baseTokens,
    ),
  );
  let selected = selectRawTail(active, availableTail);
  let compacted = active.filter((candidate) => !selected.has(candidate.index));
  if (compacted.length === 0 && state.acceptedHandoff === null) {
    selected = new Set<number>();
    compacted = active;
  }
  const sourceEventIds = [
    ...(state.acceptedHandoff?.handoff.source.eventIds ?? []),
    ...(state.activePlanSource === null
      ? []
      : [state.activePlanSource.eventId]),
    ...compacted.map((candidate) => candidate.source.eventId),
  ].filter((eventId, index, values) => values.indexOf(eventId) === index);
  const sourceSequences = [
    ...(state.acceptedHandoff === null
      ? []
      : [
          state.acceptedHandoff.handoff.source.fromSequence,
          state.acceptedHandoff.handoff.source.throughSequence,
        ]),
    ...(state.activePlanSource === null
      ? []
      : [state.activePlanSource.sequence]),
    ...compacted.map((candidate) => candidate.source.sequence),
  ];
  const sourceFromSequence =
    sourceSequences.length === 0 ? state.revision : Math.min(...sourceSequences);
  const sourceThroughSequence =
    sourceSequences.length === 0 ? state.revision : Math.max(...sourceSequences);
  const sourceMessageThroughSequence =
    compacted.at(-1)?.source.sequence ??
    state.acceptedHandoff?.handoff.source.messageThroughSequence ??
    0;
  const sourceManifest: ModelContextSourceManifest[] = [
    ...(state.acceptedHandoff === null
      ? []
      : [
          source({
            causedByEventId: null,
            digest: state.acceptedHandoff.artifact.digest,
            disposition: "transformed",
            estimatedTokens: estimateContextTokens(state.acceptedHandoff.handoff),
            id: `handoff:${state.acceptedHandoff.artifact.digest}`,
            kind: "handoff",
            priority: 90,
            reason: "merged into the replacement Continuity Handoff",
            sensitivity: "private",
            version: `handoff:${state.acceptedHandoff.handoff.schemaVersion}`,
          }),
        ]),
    ...(state.activePlan === null || state.activePlanSource === null
      ? []
      : [
          source({
            causedByEventId: state.activePlanSource.eventId,
            digest: jsonDigest(state.activePlan),
            disposition: "transformed",
            estimatedTokens: estimateContextTokens(state.activePlan),
            id: `plan:${state.activePlan.id}:r${state.activePlan.revision}`,
            kind: "active_plan",
            priority: 95,
            reason: "preserved as typed active Plan in the replacement Handoff",
            sensitivity: "private",
            version: `event:${state.activePlanSource.sequence}:revision:${state.activePlan.revision}`,
          }),
        ]),
    ...compacted.flatMap((candidate) => [
      messageSource(candidate, "transformed", "selected for semantic compaction"),
      ...artifactSources(
        candidate,
        "transformed",
        "represented by a source-linked Continuity Handoff",
      ),
    ]),
  ];
  const inputBudget =
    policy.contextWindowTokens -
    policy.reservedOutputTokens -
    policy.safetyMarginTokens;
  return {
    input: {
      activePlan: state.activePlan,
      clearBoundary: state.contextClearBoundary,
      continuation,
      model: agent.model,
      modelCapabilities,
      minimumInputTokens,
      nextEffectIndex,
      policy,
      previousHandoff: state.acceptedHandoff,
      sourceEventIds:
        sourceEventIds.length === 0 ? [continuation.eventId] : sourceEventIds,
      sourceFromSequence,
      sourceManifest,
      sourceMessageThroughSequence,
      sourceMessages: compacted.map((candidate) => candidate.message),
      sourceThreadId: state.threadId,
      sourceThroughSequence,
      targetTokens: Math.max(
        1,
        Math.min(
          Math.floor(inputBudget / 3),
          inputBudget - minimumInputTokens,
        ),
      ),
    },
    kind: "compaction",
  };
}

export function compileModelContext(
  state: ThreadState,
  continuation: ModelContinuation,
): ModelGenerateInput {
  const compiled = compileContext(state, continuation);
  if (compiled.kind !== "model") {
    throw new InvalidTransitionError(
      `Thread ${state.threadId} requires Context compaction before model dispatch`,
    );
  }
  return compiled.input;
}

function parseFact(
  value: unknown,
  label: string,
  allowedSources: ReadonlySet<string>,
): ContinuityHandoffFact {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`);
  const text = value.text;
  const sourceEventIds = value.sourceEventIds;
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    text.length > MAX_HANDOFF_FACT_TEXT
  ) {
    throw new TypeError(
      `${label}.text must contain 1-${MAX_HANDOFF_FACT_TEXT} characters`,
    );
  }
  if (
    !Array.isArray(sourceEventIds) ||
    sourceEventIds.length < 1 ||
    sourceEventIds.length > MAX_HANDOFF_SOURCE_IDS
  ) {
    throw new TypeError(
      `${label}.sourceEventIds must contain 1-${MAX_HANDOFF_SOURCE_IDS} IDs`,
    );
  }
  const parsed = sourceEventIds.map((sourceId, index) => {
    if (typeof sourceId !== "string" || !allowedSources.has(sourceId)) {
      throw new TypeError(`${label}.sourceEventIds[${index}] is outside the source range`);
    }
    return sourceId;
  });
  return { sourceEventIds: parsed, text: text.trim() };
}

function parseFacts(
  value: unknown,
  label: string,
  allowedSources: ReadonlySet<string>,
): readonly ContinuityHandoffFact[] {
  if (!Array.isArray(value) || value.length > MAX_HANDOFF_FACTS) {
    throw new TypeError(`${label} must contain at most ${MAX_HANDOFF_FACTS} facts`);
  }
  return value.map((fact, index) =>
    parseFact(fact, `${label}[${index}]`, allowedSources),
  );
}

export function parseContinuityHandoffBody(
  value: unknown,
  sourceEventIds: readonly string[],
): ContinuityHandoffBody {
  if (!isJsonObject(value)) {
    throw new TypeError("Continuity Handoff body must be an object");
  }
  const allowed = new Set(sourceEventIds);
  const nullableFact = (
    field: "nextAction" | "objective",
  ): ContinuityHandoffFact | null =>
    value[field] === null
      ? null
      : parseFact(value[field], `Continuity Handoff ${field}`, allowed);
  const body: ContinuityHandoffBody = {
    acceptanceCriteria: parseFacts(
      value.acceptanceCriteria,
      "Continuity Handoff acceptanceCriteria",
      allowed,
    ),
    artifacts: parseFacts(value.artifacts, "Continuity Handoff artifacts", allowed),
    attemptedApproaches: parseFacts(
      value.attemptedApproaches,
      "Continuity Handoff attemptedApproaches",
      allowed,
    ),
    blockers: parseFacts(value.blockers, "Continuity Handoff blockers", allowed),
    completedEvidence: parseFacts(
      value.completedEvidence,
      "Continuity Handoff completedEvidence",
      allowed,
    ),
    constraints: parseFacts(
      value.constraints,
      "Continuity Handoff constraints",
      allowed,
    ),
    currentState: parseFacts(
      value.currentState,
      "Continuity Handoff currentState",
      allowed,
    ),
    decisions: parseFacts(value.decisions, "Continuity Handoff decisions", allowed),
    doNotRetry: parseFacts(
      value.doNotRetry,
      "Continuity Handoff doNotRetry",
      allowed,
    ),
    failures: parseFacts(value.failures, "Continuity Handoff failures", allowed),
    nextAction: nullableFact("nextAction"),
    objective: nullableFact("objective"),
    pendingEffects: parseFacts(
      value.pendingEffects,
      "Continuity Handoff pendingEffects",
      allowed,
    ),
    permissions: parseFacts(
      value.permissions,
      "Continuity Handoff permissions",
      allowed,
    ),
    rejectedAlternatives: parseFacts(
      value.rejectedAlternatives,
      "Continuity Handoff rejectedAlternatives",
      allowed,
    ),
    relevantFiles: parseFacts(
      value.relevantFiles,
      "Continuity Handoff relevantFiles",
      allowed,
    ),
    scope: parseFacts(value.scope, "Continuity Handoff scope", allowed),
    summary: parseFacts(value.summary, "Continuity Handoff summary", allowed),
    unresolvedQuestions: parseFacts(
      value.unresolvedQuestions,
      "Continuity Handoff unresolvedQuestions",
      allowed,
    ),
    validation: parseFacts(
      value.validation,
      "Continuity Handoff validation",
      allowed,
    ),
    waitsAndApprovals: parseFacts(
      value.waitsAndApprovals,
      "Continuity Handoff waitsAndApprovals",
      allowed,
    ),
  };
  if (body.summary.length === 0) {
    throw new TypeError("Continuity Handoff summary must contain at least one fact");
  }
  assertJsonValue(body, "Continuity Handoff body");
  if (
    new TextEncoder().encode(canonicalJson(body as unknown as JsonValue))
      .byteLength > MAX_HANDOFF_BYTES
  ) {
    throw new TypeError(`Continuity Handoff body exceeds ${MAX_HANDOFF_BYTES} bytes`);
  }
  return body;
}

export function createContinuityHandoff(
  input: ContextCompactionInput,
  body: ContinuityHandoffBody,
): ContinuityHandoff {
  return {
    activePlan: input.activePlan,
    body,
    model: input.model,
    previousHandoffDigest: input.previousHandoff?.artifact.digest ?? null,
    schemaVersion: CONTINUITY_HANDOFF_SCHEMA_VERSION,
    source: {
      clearBoundary: input.clearBoundary,
      compilerVersion: CONTEXT_COMPILER_VERSION,
      eventIds: input.sourceEventIds,
      fromSequence: input.sourceFromSequence,
      messageThroughSequence: input.sourceMessageThroughSequence,
      threadId: input.sourceThreadId,
      throughSequence: input.sourceThroughSequence,
    },
  };
}

function copyFactForFork(
  fact: ContinuityHandoffFact,
  mapEventId: (eventId: string) => string,
): ContinuityHandoffFact {
  return {
    ...fact,
    sourceEventIds: fact.sourceEventIds.map(mapEventId),
  };
}

export function copyContinuityHandoffForFork(
  handoff: ContinuityHandoff,
  mapEventId: (eventId: string) => string,
  threadId: string,
  previousHandoffDigest: string | null,
): ContinuityHandoff {
  const facts = (values: readonly ContinuityHandoffFact[]) =>
    values.map((fact) => copyFactForFork(fact, mapEventId));
  return {
    ...handoff,
    body: {
      acceptanceCriteria: facts(handoff.body.acceptanceCriteria),
      artifacts: facts(handoff.body.artifacts),
      attemptedApproaches: facts(handoff.body.attemptedApproaches),
      blockers: facts(handoff.body.blockers),
      completedEvidence: facts(handoff.body.completedEvidence),
      constraints: facts(handoff.body.constraints),
      currentState: facts(handoff.body.currentState),
      decisions: facts(handoff.body.decisions),
      doNotRetry: facts(handoff.body.doNotRetry),
      failures: facts(handoff.body.failures),
      nextAction:
        handoff.body.nextAction === null
          ? null
          : copyFactForFork(handoff.body.nextAction, mapEventId),
      objective:
        handoff.body.objective === null
          ? null
          : copyFactForFork(handoff.body.objective, mapEventId),
      pendingEffects: facts(handoff.body.pendingEffects),
      permissions: facts(handoff.body.permissions),
      rejectedAlternatives: facts(handoff.body.rejectedAlternatives),
      relevantFiles: facts(handoff.body.relevantFiles),
      scope: facts(handoff.body.scope),
      summary: facts(handoff.body.summary),
      unresolvedQuestions: facts(handoff.body.unresolvedQuestions),
      validation: facts(handoff.body.validation),
      waitsAndApprovals: facts(handoff.body.waitsAndApprovals),
    },
    previousHandoffDigest,
    source: {
      ...handoff.source,
      clearBoundary:
        handoff.source.clearBoundary === null
          ? null
          : {
              ...handoff.source.clearBoundary,
              eventId: mapEventId(handoff.source.clearBoundary.eventId),
            },
      eventIds: handoff.source.eventIds.map(mapEventId),
      threadId,
    },
  };
}

function copyContinuationForFork(
  continuation: ModelContinuation,
  mapEventId: (eventId: string) => string,
): ModelContinuation {
  return { ...continuation, eventId: mapEventId(continuation.eventId) };
}

function copySourcesForFork(
  sources: readonly ModelContextSourceManifest[],
  mapEventId: (eventId: string) => string,
): readonly ModelContextSourceManifest[] {
  return sources.map((entry) => {
    const causedByEventId =
      entry.causedByEventId === null
        ? null
        : mapEventId(entry.causedByEventId);
    return {
      ...entry,
      causedByEventId,
      id:
        entry.kind === "message" && causedByEventId !== null
          ? `message:${causedByEventId}`
          : entry.kind === "artifact" &&
              causedByEventId !== null &&
              entry.digest !== null
            ? `artifact:${entry.digest}:${causedByEventId}`
          : entry.id,
    };
  });
}

export function copyContextCompactionForFork(
  input: ContextCompactionInput,
  mapEventId: (eventId: string) => string,
  threadId: string,
  previousHandoff: AcceptedContinuityHandoff | null,
): ContextCompactionInput {
  const sourceManifest = copySourcesForFork(input.sourceManifest, mapEventId).map(
    (entry) =>
      entry.kind === "handoff" && previousHandoff !== null
        ? {
            ...entry,
            digest: previousHandoff.artifact.digest,
            id: `handoff:${previousHandoff.artifact.digest}`,
          }
        : entry,
  );
  return {
    ...input,
    clearBoundary:
      input.clearBoundary === null
        ? null
        : {
            ...input.clearBoundary,
            eventId: mapEventId(input.clearBoundary.eventId),
          },
    continuation: copyContinuationForFork(input.continuation, mapEventId),
    previousHandoff,
    sourceEventIds: input.sourceEventIds.map(mapEventId),
    sourceManifest,
    sourceThreadId: threadId,
  };
}

export function copyModelContextForFork(
  input: ModelGenerateInput,
  mapEventId: (eventId: string) => string,
  acceptedHandoff?: AcceptedContinuityHandoff,
): ModelGenerateInput {
  if (input.runtimeContext === undefined || input.contextManifest === undefined) {
    return input;
  }
  const runtime: ModelRuntimeContext = {
    ...input.runtimeContext,
    continuation: {
      ...input.runtimeContext.continuation,
      causedByEventId: mapEventId(input.runtimeContext.continuation.causedByEventId),
      receipt: {
        ...input.runtimeContext.continuation.receipt,
        eventId: mapEventId(input.runtimeContext.continuation.receipt.eventId),
      },
    },
  };
  const sources = input.contextManifest.sources.map((entry) => ({
    ...entry,
    causedByEventId:
      entry.causedByEventId === null
        ? null
        : mapEventId(entry.causedByEventId),
    digest:
      entry.kind === "handoff" && acceptedHandoff !== undefined
        ? acceptedHandoff.artifact.digest
        : entry.kind === "runtime"
          ? jsonDigest(runtime)
          : entry.digest,
    id:
      entry.kind === "handoff" && acceptedHandoff !== undefined
        ? `handoff:${acceptedHandoff.artifact.digest}`
        : entry.kind === "message" && entry.causedByEventId !== null
          ? `message:${mapEventId(entry.causedByEventId)}`
          : entry.kind === "artifact" &&
              entry.causedByEventId !== null &&
              entry.digest !== null
            ? `artifact:${entry.digest}:${mapEventId(entry.causedByEventId)}`
            : entry.kind === "runtime"
              ? `runtime:${jsonDigest(runtime)}`
              : entry.id,
  }));
  const continuityHandoff =
    acceptedHandoff?.handoff ?? input.continuityHandoff ?? null;
  return {
    ...input,
    continuityHandoff,
    contextManifest: {
      ...input.contextManifest,
      acceptedHandoffDigest:
        acceptedHandoff?.artifact.digest ??
        input.contextManifest.acceptedHandoffDigest,
      activeClearBoundary:
        input.contextManifest.activeClearBoundary === null
          ? null
          : {
              ...input.contextManifest.activeClearBoundary,
              eventId: mapEventId(input.contextManifest.activeClearBoundary.eventId),
            },
      logicalRequestDigest: logicalRequestDigest({
        activePlan: input.activePlan,
        continuityHandoff,
        contextPolicy: {
          contextWindowTokens:
            input.contextManifest.inputBudgetTokens +
            input.contextManifest.outputBudgetTokens +
            input.contextManifest.safetyMarginTokens,
          rawTailTokens: input.contextManifest.rawTailBudgetTokens,
          reservedOutputTokens: input.contextManifest.outputBudgetTokens,
          safetyMarginTokens: input.contextManifest.safetyMarginTokens,
          schemaVersion: input.contextManifest.contextPolicySchemaVersion,
        },
        instructions: input.instructions,
        messages: input.messages,
        mode: input.mode,
        model: input.model,
        modelCapabilities: input.contextManifest.modelCapabilities,
        planControl: input.planControl,
        planRejectionFeedback: input.planRejectionFeedback ?? null,
        progressControl: input.progressControl,
        runtime,
        tools: input.tools,
      }),
      rawTailBoundary:
        input.contextManifest.rawTailBoundary === null
          ? null
          : {
              ...input.contextManifest.rawTailBoundary,
              eventId: mapEventId(input.contextManifest.rawTailBoundary.eventId),
            },
      sources,
    },
    runtimeContext: runtime,
  };
}
