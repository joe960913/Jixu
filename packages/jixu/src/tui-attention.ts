import type { PlanStepStatus } from "@jixu/core";

import { iconForTool, type JixuIconName } from "./tui-icons.tsx";
import type {
  ActivityEntry,
  JixuTone,
  ThreadControllerSnapshot,
  TranscriptMessageEntry,
} from "./tui-model.ts";

export interface AttentionLine {
  readonly detail?: string;
  readonly icon: JixuIconName;
  readonly label: string;
  readonly tone: JixuTone;
}

export interface AttentionPlanStep {
  readonly description: string;
  readonly id: string;
  readonly status: PlanStepStatus;
}

export interface AttentionPlan {
  readonly detail: string;
  readonly icon: JixuIconName;
  readonly label: string;
  readonly steps: readonly AttentionPlanStep[];
}

export interface AttentionModel {
  readonly needsYou: AttentionLine;
  readonly now: AttentionLine;
  readonly plan: AttentionPlan;
  readonly verified: readonly AttentionLine[];
}

function latestActivity(
  snapshot: ThreadControllerSnapshot,
  predicate: (entry: ActivityEntry) => boolean,
): ActivityEntry | undefined {
  return snapshot.activity.findLast(predicate);
}

function nowLine(
  snapshot: ThreadControllerSnapshot,
  configured: boolean,
): AttentionLine {
  if (!configured) {
    return {
      detail: "Use /config to connect a model.",
      icon: "attention",
      label: "Model not configured",
      tone: "warning",
    };
  }

  if (snapshot.workStatus !== null) {
    const icons = {
      planning: "plan",
      responding: "responding",
      thinking: "thinking",
      tool: "tool",
    } as const;
    return {
      ...(snapshot.workStatus.detail === undefined
        ? {}
        : { detail: snapshot.workStatus.detail }),
      icon: icons[snapshot.workStatus.phase],
      label: snapshot.workStatus.label,
      tone: snapshot.workStatus.tone,
    };
  }

  if (snapshot.busy) {
    return {
      detail: "Preparing the next observable action.",
      icon: "thinking",
      label: "Working",
      tone: "warning",
    };
  }

  if (snapshot.threadStatus === "waiting") {
    if (snapshot.toolApproval !== null) {
      return {
        detail: `${snapshot.toolApproval.name} requests ${snapshot.toolApproval.action}`,
        icon: "attention",
        label: "Tool approval required",
        tone: "warning",
      };
    }
    const decision = latestActivity(
      snapshot,
      (entry) => entry.label === "Decision required",
    );
    return {
      ...(decision?.detail === undefined ? {} : { detail: decision.detail }),
      icon: "attention",
      label: "Decision required",
      tone: "warning",
    };
  }

  if (snapshot.threadStatus === "paused") {
    return {
      detail: "Continue when you are ready.",
      icon: "paused",
      label: "Thread paused",
      tone: "warning",
    };
  }

  if (snapshot.activePlan !== null) {
    const current =
      snapshot.activePlan.steps.find((step) => step.status === "in_progress") ??
      snapshot.activePlan.steps.find((step) => step.status === "pending");
    return {
      ...(current === undefined ? {} : { detail: current.description }),
      icon: "plan",
      label: snapshot.activePlan.objective,
      tone: "brand",
    };
  }

  if (snapshot.currentThreadId === null) {
    return {
      detail: "Ask Jixu to work in this directory.",
      icon: "responding",
      label: "Ready for a durable Thread",
      tone: "info",
    };
  }

  const lastUser = snapshot.transcript.findLast(
    (entry): entry is TranscriptMessageEntry =>
      entry.kind === "message" && entry.role === "user",
  );
  return {
    ...(lastUser === undefined ? {} : { detail: lastUser.content }),
    icon: "responding",
    label: "Ready to continue",
    tone: "success",
  };
}

function planModel(snapshot: ThreadControllerSnapshot): AttentionPlan {
  if (snapshot.activePlan === null) {
    return {
      detail: "No active Plan for this work.",
      icon: "direct",
      label: "Direct execution",
      steps: Object.freeze([]),
    };
  }

  return {
    detail:
      snapshot.activePlan.nextAction ??
      snapshot.activePlan.steps.find((step) => step.status === "in_progress")
        ?.description ??
      "Plan is active.",
    icon: "plan",
    label: snapshot.activePlan.objective,
    steps: snapshot.activePlan.steps.map((step) => ({
      description: step.description,
      id: step.id,
      status: step.status,
    })),
  };
}

function verifiedLine(entry: ActivityEntry): AttentionLine | null {
  if (entry.label === "Tool completed") {
    return {
      detail: "Completed successfully.",
      icon: iconForTool(entry.detail ?? ""),
      label: entry.detail ?? "Tool operation",
      tone: "success",
    };
  }
  if (entry.label === "Model response committed") {
    return {
      detail: "Durable response available.",
      icon: "responding",
      label: "Response committed",
      tone: "success",
    };
  }
  if (entry.label === "Plan completed") {
    return {
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      icon: "verified",
      label: "Plan completed",
      tone: "success",
    };
  }
  return null;
}

function verifiedLines(snapshot: ThreadControllerSnapshot): readonly AttentionLine[] {
  const verified = snapshot.activity
    .map(verifiedLine)
    .filter((entry): entry is AttentionLine => entry !== null)
    .reverse()
    .filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) =>
            candidate.label === entry.label && candidate.detail === entry.detail,
        ) === index,
    )
    .slice(0, 2);

  return verified.length > 0
    ? Object.freeze(verified)
    : Object.freeze([
        {
          detail: "Completed outcomes will collect here.",
          icon: "verified",
          label: "Nothing verified yet",
          tone: "secondary",
        },
      ]);
}

function needsYouLine(
  snapshot: ThreadControllerSnapshot,
  configured: boolean,
): AttentionLine {
  if (!configured) {
    return {
      detail: "Use /config when you are ready.",
      icon: "attention",
      label: "Connect a model",
      tone: "warning",
    };
  }

  if (snapshot.threadStatus === "waiting") {
    if (snapshot.toolApproval !== null) {
      return {
        detail: "Choose Allow once or Deny in the approval bar.",
        icon: "attention",
        label: `${snapshot.toolApproval.name} needs approval`,
        tone: "warning",
      };
    }
    const decision = latestActivity(
      snapshot,
      (entry) => entry.label === "Decision required",
    );
    return {
      ...(decision?.detail === undefined ? {} : { detail: decision.detail }),
      icon: "attention",
      label: "Your decision is required",
      tone: "warning",
    };
  }

  if (snapshot.threadStatus === "paused") {
    return {
      detail: "Use /continue when you are ready.",
      icon: "paused",
      label: "Continuation is paused",
      tone: "warning",
    };
  }

  const failure = latestActivity(snapshot, (entry) => entry.tone === "danger");
  const latest = snapshot.activity.at(-1);
  if (failure !== undefined && failure.id === latest?.id) {
    return {
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
      icon: "attention",
      label: failure.label,
      tone: "danger",
    };
  }

  return {
    detail: snapshot.busy
      ? "Jixu is continuing automatically."
      : "No intervention is required.",
    icon: "autonomy",
    label: "No intervention required",
    tone: "success",
  };
}

export function createAttentionModel(
  snapshot: ThreadControllerSnapshot,
  configured: boolean,
): AttentionModel {
  return Object.freeze({
    needsYou: needsYouLine(snapshot, configured),
    now: nowLine(snapshot, configured),
    plan: planModel(snapshot),
    verified: verifiedLines(snapshot),
  });
}
