import type { AnyThreadEvent } from "@jixu/core";

import type { ToolOperation, WorkStatus } from "./tui-model.ts";

function truncate(value: string, maximum = 72): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum
    ? compact
    : `${compact.slice(0, maximum - 1)}…`;
}

function stringArgument(
  event: Extract<AnyThreadEvent, { readonly type: "tool.requested" }>,
  key: string,
): string | null {
  const value = event.payload.effect.input.arguments[key];
  return typeof value === "string" && value.trim().length > 0
    ? truncate(value)
    : null;
}

function toolStatus(
  event: Extract<AnyThreadEvent, { readonly type: "tool.requested" }>,
): WorkStatus {
  const name = event.payload.effect.input.name;
  const path = stringArgument(event, "path");
  if (name === "read") {
    return {
      detail: path ?? name,
      label: "Reading",
      phase: "tool",
      tone: "info",
    };
  }
  if (name === "write") {
    return {
      detail: path ?? name,
      label: "Writing",
      phase: "tool",
      tone: "brand",
    };
  }
  if (name === "edit") {
    return {
      detail: path ?? name,
      label: "Editing",
      phase: "tool",
      tone: "brand",
    };
  }
  if (name === "bash") {
    return {
      detail: stringArgument(event, "command") ?? name,
      label: "Running",
      phase: "tool",
      tone: "warning",
    };
  }
  return { detail: name, label: "Using tool", phase: "tool", tone: "info" };
}

export function toolOperationForRequest(
  event: Extract<AnyThreadEvent, { readonly type: "tool.requested" }>,
): ToolOperation {
  const status = toolStatus(event);
  return {
    ...(status.detail === undefined ? {} : { detail: status.detail }),
    effectId: event.payload.effect.id,
    name: event.payload.effect.input.name,
    status: "running",
  };
}

function withProgress(
  status: WorkStatus,
  progressMessage: string | null,
): WorkStatus {
  if (progressMessage === null) return status;
  return {
    detail: `${status.label} ${status.detail ?? ""}`.trim(),
    label: progressMessage,
    phase: status.phase,
    tone: status.tone,
  };
}

export function workStatusForEvent(
  event: AnyThreadEvent,
  progressMessage: string | null = null,
): WorkStatus | null {
  switch (event.type) {
    case "model.requested":
      return {
        label: "Thinking",
        phase: "thinking",
        tone: "warning",
      };
    case "plan.updated":
      return {
        detail: `r${event.payload.plan.revision}`,
        label:
          event.payload.plan.status === "active"
            ? "Plan aligned"
            : `Plan ${event.payload.plan.status}`,
        phase: "planning",
        tone: event.payload.plan.status === "completed" ? "success" : "brand",
      };
    case "plan.rejected":
      return {
        detail: "continuing with the last valid Plan",
        label: "Plan kept steady",
        phase: "planning",
        tone: "warning",
      };
    case "tool.requested":
      return withProgress(toolStatus(event), progressMessage);
    case "tool.completed":
      return {
        detail: event.payload.name,
        label: "Checking the result",
        phase: "thinking",
        tone: "success",
      };
    case "tool.failed":
      return {
        detail: event.payload.name,
        label: "Reconsidering",
        phase: "thinking",
        tone: "warning",
      };
    case "model.completed":
      return null;
    default:
      return null;
  }
}
