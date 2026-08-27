import { SchemaValidationError } from "./errors.ts";
import { cloneFrozenJson, isJsonObject, jsonEquals } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";

export const PLAN_CONTROL_NAME = "jixu_plan_update";

export type PlanStatus =
  | "abandoned"
  | "active"
  | "completed"
  | "superseded";

export type PlanStepStatus =
  | "blocked"
  | "completed"
  | "in_progress"
  | "pending"
  | "skipped";

export type PlanUpdateOperation =
  | "abandon"
  | "create"
  | "revise"
  | "supersede";

export interface PlanStep {
  readonly description: string;
  readonly evidence: readonly string[];
  readonly id: string;
  readonly status: PlanStepStatus;
}

export interface PlanSnapshot {
  readonly acceptanceCriteria: readonly string[];
  readonly assumptions: readonly string[];
  readonly blockers: readonly string[];
  readonly id: string;
  readonly nextAction: string | null;
  readonly objective: string;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
}

export interface PlanUpdateProposal {
  readonly acceptanceCriteria: readonly string[];
  readonly assumptions: readonly string[];
  readonly blockers: readonly string[];
  readonly nextAction: string | null;
  readonly objective: string;
  readonly operation: PlanUpdateOperation;
  readonly steps: readonly PlanStep[];
}

export interface PendingPlanUpdate {
  readonly identitySeed: string;
  readonly proposal: PlanUpdateProposal;
}

export interface PlanControlDescriptor {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: typeof PLAN_CONTROL_NAME;
}

const MAX_CRITERIA = 8;
const MAX_STEPS = 12;
const MAX_REFERENCES = 8;
const MAX_NOTES = 8;

function stringListSchema(maxItems: number, minItems = 0) {
  return {
    items: { maxLength: 1_000, minLength: 1, type: "string" },
    maxItems,
    minItems,
    type: "array",
  } as const;
}

function planControlSchema(
  operations: readonly PlanUpdateOperation[],
  requirePlanBody: boolean,
): JsonObject {
  const planBodyRequired = [
    "operation",
    "objective",
    "acceptanceCriteria",
    "steps",
    "assumptions",
    "blockers",
    "nextAction",
  ] as const;
  return {
    additionalProperties: false,
    properties: {
      acceptanceCriteria: stringListSchema(MAX_CRITERIA, 1),
      assumptions: stringListSchema(MAX_NOTES),
      blockers: stringListSchema(MAX_NOTES),
      nextAction: { maxLength: 1_000, minLength: 1, type: ["string", "null"] },
      objective: { maxLength: 2_000, minLength: 1, type: "string" },
      operation: {
        enum: operations,
        type: "string",
      },
      steps: {
        items: {
          additionalProperties: false,
          properties: {
            description: { maxLength: 500, minLength: 1, type: "string" },
            evidence: stringListSchema(MAX_REFERENCES),
            id: { maxLength: 80, minLength: 1, type: "string" },
            status: {
              enum: [
                "pending",
                "in_progress",
                "completed",
                "blocked",
                "skipped",
              ],
              type: "string",
            },
          },
          required: ["id", "description", "status", "evidence"],
          type: "object",
        },
        maxItems: MAX_STEPS,
        minItems: 1,
        type: "array",
      },
    },
    required: requirePlanBody ? planBodyRequired : ["operation"],
    type: "object",
  };
}

export function createPlanControl(
  activePlan: PlanSnapshot | null,
): PlanControlDescriptor {
  const creating = activePlan === null;
  return cloneFrozenJson({
    description: creating
      ? "Create an optional execution Plan only when work has dependent stages, material uncertainty, a long recovery horizon, or explicit verification boundaries. Do not create a ceremonial Plan for a short answer or one known action. A Plan coordinates work but never authorizes or performs it. This control is not a user-facing response; also provide concise public text or continue through ordinary Tools."
      : "Update the accepted active Plan as the best current execution hypothesis. Use revise to reflect progress or new evidence; omitted revise fields preserve their accepted values. Preserve completed steps and the current in-progress step as observed work; completed evidence may only be appended, while pending steps may be added, removed, edited, split, merged, or reordered. When every step is completed or skipped, Jixu completes the Plan automatically. Use one supersede call only for a materially different objective and provide its complete replacement Plan body; Jixu preserves the old Plan as superseded before creating the replacement. To stop the objective, send only {\"operation\":\"abandon\"}; Jixu derives the terminal revision from the active Plan. Never create a second Plan while one is active. A Plan coordinates work but never authorizes or performs it. This control is not a user-facing response; also provide concise public text or continue through ordinary Tools.",
    inputSchema: planControlSchema(
      creating ? ["create"] : ["revise", "supersede", "abandon"],
      creating,
    ),
    name: PLAN_CONTROL_NAME,
  });
}

export const PLAN_CONTROL: PlanControlDescriptor = createPlanControl(null);

function fail(label: string, message: string): never {
  throw new SchemaValidationError(`${label} ${message}`);
}

function record(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) fail(label, "must be a JSON object");
  return value;
}

function boundedString(
  value: JsonValue | undefined,
  label: string,
  maximum = 2_000,
): string {
  if (typeof value !== "string") fail(label, "must be a string");
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    fail(label, `must contain 1-${maximum} characters`);
  }
  return normalized;
}

function boundedList(
  value: JsonValue | undefined,
  label: string,
  maximum: number,
  minimum = 0,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(label, `must contain ${minimum}-${maximum} items`);
  }
  return value.map((item, index) =>
    boundedString(item, `${label}[${index}]`, 1_000),
  );
}

function operation(value: JsonValue | undefined, label: string): PlanUpdateOperation {
  if (
    value !== "create" &&
    value !== "revise" &&
    value !== "supersede" &&
    value !== "abandon"
  ) {
    fail(label, "is unsupported");
  }
  return value;
}

function planStatus(value: JsonValue | undefined, label: string): PlanStatus {
  if (
    value !== "active" &&
    value !== "completed" &&
    value !== "superseded" &&
    value !== "abandoned"
  ) {
    fail(label, "is unsupported");
  }
  return value;
}

function stepStatus(value: JsonValue | undefined, label: string): PlanStepStatus {
  if (
    value !== "pending" &&
    value !== "in_progress" &&
    value !== "completed" &&
    value !== "blocked" &&
    value !== "skipped"
  ) {
    fail(label, "is unsupported");
  }
  return value;
}

function parseSteps(value: JsonValue | undefined, label: string): readonly PlanStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STEPS) {
    fail(label, `must contain 1-${MAX_STEPS} items`);
  }
  const ids = new Set<string>();
  const steps = value.map((rawStep, index): PlanStep => {
    const step = record(rawStep, `${label}[${index}]`);
    const id = boundedString(step.id, `${label}[${index}].id`, 80);
    if (ids.has(id)) fail(`${label}[${index}].id`, "must be unique");
    ids.add(id);
    return {
      description: boundedString(
        step.description,
        `${label}[${index}].description`,
        500,
      ),
      evidence: boundedList(
        step.evidence,
        `${label}[${index}].evidence`,
        MAX_REFERENCES,
      ),
      id,
      status: stepStatus(step.status, `${label}[${index}].status`),
    };
  });
  if (steps.filter((step) => step.status === "in_progress").length > 1) {
    fail(label, "must not contain more than one in_progress step");
  }
  return steps;
}

function parseBody(value: JsonObject, label: string) {
  return {
    acceptanceCriteria: boundedList(
      value.acceptanceCriteria,
      `${label}.acceptanceCriteria`,
      MAX_CRITERIA,
      1,
    ),
    assumptions: boundedList(
      value.assumptions,
      `${label}.assumptions`,
      MAX_NOTES,
    ),
    blockers: boundedList(value.blockers, `${label}.blockers`, MAX_NOTES),
    nextAction:
      value.nextAction === null
        ? null
        : boundedString(value.nextAction, `${label}.nextAction`, 1_000),
    objective: boundedString(value.objective, `${label}.objective`),
    steps: parseSteps(value.steps, `${label}.steps`),
  };
}

function assertStatusInvariants(plan: PlanSnapshot, label: string): void {
  const activeSteps = plan.steps.filter((step) => step.status === "in_progress");
  if (plan.status === "active") {
    if (plan.nextAction === null) fail(`${label}.nextAction`, "is required while active");
    if (
      plan.steps.every(
        (step) => step.status === "completed" || step.status === "skipped",
      )
    ) {
      fail(`${label}.steps`, "cannot all be terminal while the Plan is active");
    }
    return;
  }
  if (plan.nextAction !== null) fail(`${label}.nextAction`, "must be null when inactive");
  if (activeSteps.length > 0) fail(`${label}.steps`, "cannot remain in_progress when inactive");
  if (
    plan.status === "completed" &&
    plan.steps.some(
      (step) => step.status !== "completed" && step.status !== "skipped",
    )
  ) {
    fail(`${label}.steps`, "must all be completed or skipped for a completed Plan");
  }
}

export function parsePlanUpdateProposal(
  value: unknown,
  label = "Plan update",
): PlanUpdateProposal {
  const proposal = record(value, label);
  return {
    ...parseBody(proposal, label),
    operation: operation(proposal.operation, `${label}.operation`),
  };
}

export function parsePlanControlUpdate(
  value: unknown,
  activePlan: PlanSnapshot | null,
  label = "Plan control",
): PlanUpdateProposal {
  const proposal = record(value, label);
  const proposalOperation = operation(
    proposal.operation,
    `${label}.operation`,
  );
  if (proposalOperation === "revise") {
    if (activePlan === null) fail(label, "cannot revise without an active Plan");
    return parsePlanUpdateProposal(
      {
        acceptanceCriteria:
          proposal.acceptanceCriteria === undefined
            ? activePlan.acceptanceCriteria
            : proposal.acceptanceCriteria,
        assumptions:
          proposal.assumptions === undefined
            ? activePlan.assumptions
            : proposal.assumptions,
        blockers:
          proposal.blockers === undefined
            ? activePlan.blockers
            : proposal.blockers,
        nextAction:
          proposal.nextAction === undefined
            ? activePlan.nextAction
            : proposal.nextAction,
        objective:
          proposal.objective === undefined
            ? activePlan.objective
            : proposal.objective,
        operation: proposalOperation,
        steps: proposal.steps === undefined ? activePlan.steps : proposal.steps,
      },
      label,
    );
  }
  if (proposalOperation !== "abandon") {
    return parsePlanUpdateProposal(proposal, label);
  }
  if (activePlan === null) fail(label, "cannot abandon without an active Plan");
  return {
    acceptanceCriteria: activePlan.acceptanceCriteria,
    assumptions: activePlan.assumptions,
    blockers: activePlan.blockers,
    nextAction: null,
    objective: activePlan.objective,
    operation: "abandon",
    steps: activePlan.steps.map((step) => ({
      ...step,
      status: step.status === "in_progress" ? "skipped" : step.status,
    })),
  };
}

export function parsePlanSnapshot(
  value: unknown,
  label = "Plan",
): PlanSnapshot {
  const plan = record(value, label);
  const schemaVersion = plan.schemaVersion;
  if (schemaVersion !== 1) fail(`${label}.schemaVersion`, "is unsupported");
  const revision = plan.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    fail(`${label}.revision`, "must be a positive integer");
  }
  const parsed: PlanSnapshot = {
    ...parseBody(plan, label),
    id: boundedString(plan.id, `${label}.id`, 240),
    revision,
    schemaVersion,
    status: planStatus(plan.status, `${label}.status`),
  };
  assertStatusInvariants(parsed, label);
  return parsed;
}

function resultStatus(
  operationValue: PlanUpdateOperation,
  steps: readonly PlanStep[],
): PlanStatus {
  switch (operationValue) {
    case "create":
      return "active";
    case "revise":
      return steps.every(
        (step) => step.status === "completed" || step.status === "skipped",
      )
        ? "completed"
        : "active";
    case "supersede":
      return "superseded";
    case "abandon":
      return "abandoned";
  }
}

function assertEvidenceAppendOnly(
  current: PlanStep,
  next: PlanStep,
  label: string,
): void {
  if (
    current.evidence.some(
      (evidence, index) => next.evidence[index] !== evidence,
    )
  ) {
    fail(label, "must preserve existing evidence in order");
  }
}

function assertFlexibleStepRevision(
  current: PlanSnapshot,
  next: PlanUpdateProposal,
): void {
  const protectedCompleted = current.steps.filter(
    (step) => step.status === "completed",
  );
  let previousCompletedIndex = -1;
  for (const completed of protectedCompleted) {
    const nextIndex = next.steps.findIndex((step) => step.id === completed.id);
    if (nextIndex < 0) {
      fail(
        `Plan update step ${completed.id}`,
        "cannot remove a completed step",
      );
    }
    const revised = next.steps[nextIndex];
    if (revised === undefined) continue;
    if (revised.description !== completed.description) {
      fail(
        `Plan update step ${completed.id}.description`,
        "cannot change a completed step",
      );
    }
    if (revised.status !== "completed") {
      fail(
        `Plan update step ${completed.id}.status`,
        "must remain completed",
      );
    }
    if (nextIndex <= previousCompletedIndex) {
      fail(
        `Plan update step ${completed.id}`,
        "must preserve completed step order",
      );
    }
    assertEvidenceAppendOnly(
      completed,
      revised,
      `Plan update step ${completed.id}.evidence`,
    );
    previousCompletedIndex = nextIndex;
  }

  const inProgress = current.steps.find(
    (step) => step.status === "in_progress",
  );
  if (inProgress === undefined) return;
  const revised = next.steps.find((step) => step.id === inProgress.id);
  if (revised === undefined) {
    fail(
      `Plan update step ${inProgress.id}`,
      "cannot remove the in-progress step",
    );
  }
  if (revised.description !== inProgress.description) {
    fail(
      `Plan update step ${inProgress.id}.description`,
      "cannot rename the in-progress step",
    );
  }
  if (revised.status === "pending") {
    fail(
      `Plan update step ${inProgress.id}.status`,
      "cannot return an in-progress step to pending",
    );
  }
  assertEvidenceAppendOnly(
    inProgress,
    revised,
    `Plan update step ${inProgress.id}.evidence`,
  );
}

export function materializePlanUpdates(
  current: PlanSnapshot | null,
  values: readonly PlanUpdateProposal[],
  identitySeed: string,
  options: { readonly expandAtomicSupersede?: boolean } = {},
): readonly PlanSnapshot[] {
  const expanded =
    options.expandAtomicSupersede === false
      ? values
      : expandPlanUpdateProposals(current, values);
  if (expanded.length > 2) fail("Plan updates", "must contain at most two changes");
  if (
    expanded.length === 2 &&
    (expanded[0]?.operation !== "supersede" ||
      expanded[1]?.operation !== "create")
  ) {
    fail("Plan updates", "may only pair supersede followed by create");
  }

  let active = current;
  const snapshots: PlanSnapshot[] = [];
  expanded.forEach((rawProposal, index) => {
    const proposal = parsePlanUpdateProposal(rawProposal, `Plan updates[${index}]`);
    if (proposal.operation === "create") {
      if (active !== null) fail("Plan update", "cannot create while another Plan is active");
      if (
        proposal.steps.every(
          (step) => step.status === "completed" || step.status === "skipped",
        )
      ) {
        fail("Plan update", "cannot create an already completed Plan");
      }
    } else {
      if (active === null) fail("Plan update", `${proposal.operation} requires an active Plan`);
      if (proposal.objective !== active.objective) {
        fail(
          "Plan update objective",
          "cannot change without superseding the active Plan",
        );
      }
      if (proposal.operation === "revise") {
        assertFlexibleStepRevision(active, proposal);
      }
    }

    const status = resultStatus(proposal.operation, proposal.steps);
    const snapshot = parsePlanSnapshot(
      {
        acceptanceCriteria: proposal.acceptanceCriteria,
        assumptions: proposal.assumptions,
        blockers: proposal.blockers,
        id:
          proposal.operation === "create"
            ? `plan:${identitySeed}:${index}`
            : active?.id,
        nextAction: status === "active" ? proposal.nextAction : null,
        objective: proposal.objective,
        revision: proposal.operation === "create" ? 1 : (active?.revision ?? 0) + 1,
        schemaVersion: 1,
        status,
        steps: proposal.steps,
      },
      `Plan updates[${index}]`,
    );
    snapshots.push(snapshot);
    active = snapshot.status === "active" ? snapshot : null;
  });
  return snapshots;
}

export function expandPlanUpdateProposals(
  current: PlanSnapshot | null,
  values: readonly PlanUpdateProposal[],
): readonly PlanUpdateProposal[] {
  const proposals = values.map((value, index) =>
    parsePlanUpdateProposal(value, `Plan updates[${index}]`),
  );
  const replacement = proposals.length === 1 ? proposals[0] : undefined;
  if (
    current === null ||
    replacement?.operation !== "supersede" ||
    replacement.objective === current.objective
  ) {
    return proposals;
  }
  return [
    {
      acceptanceCriteria: current.acceptanceCriteria,
      assumptions: current.assumptions,
      blockers: current.blockers,
      nextAction: null,
      objective: current.objective,
      operation: "supersede",
      steps: current.steps.map((step) => ({
        ...step,
        status: step.status === "in_progress" ? "skipped" : step.status,
      })),
    },
    { ...replacement, operation: "create" },
  ];
}

export function assertPlanUpdateTransition(
  current: PlanSnapshot | null,
  next: PlanSnapshot,
): void {
  if (current === null) {
    if (next.status !== "active" || next.revision !== 1) {
      fail("Plan transition", "must create an active revision 1 Plan");
    }
    return;
  }
  if (
    next.id !== current.id ||
    next.objective !== current.objective ||
    next.revision !== current.revision + 1
  ) {
    fail("Plan transition", "must advance the active Plan without changing identity");
  }
}

export function samePlan(left: PlanSnapshot, right: PlanSnapshot): boolean {
  return jsonEquals(left, right);
}
