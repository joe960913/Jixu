import type { AnyThreadEvent, PlanSnapshot } from "@jixu/core";

import type { ActivityEntry, TranscriptEntry } from "./tui-model.ts";

export function eventActivity(
  event: AnyThreadEvent,
): Omit<ActivityEntry, "id"> {
  const base = { eventId: event.id };
  switch (event.type) {
    case "thread.created":
      return { ...base, kind: "runtime", label: "Thread created", tone: "brand" };
    case "thread.forked":
      return {
        ...base,
        detail: `from ${event.payload.parentThreadId}`,
        kind: "control",
        label: "Thread forked",
        tone: "brand",
      };
    case "input.received":
      return { ...base, kind: "runtime", label: "Input committed", tone: "info" };
    case "context.cleared":
      return { ...base, kind: "control", label: "Context cleared", tone: "info" };
    case "model.requested":
      return {
        ...base,
        detail: event.payload.effect.input.model.model,
        kind: "model",
        label: "Thinking",
        tone: "warning",
      };
    case "model.completed":
      return {
        ...base,
        kind: "runtime",
        label: "Model response committed",
        tone: "success",
      };
    case "model.failed":
      return {
        ...base,
        detail: event.payload.error.code,
        kind: "model",
        label: "Model failed",
        tone: "danger",
      };
    case "plan.updated":
      return {
        ...base,
        detail: `r${event.payload.plan.revision}`,
        kind: "control",
        label:
          event.payload.plan.status === "active"
            ? event.payload.plan.revision === 1
              ? "Plan created"
              : "Plan updated"
            : `Plan ${event.payload.plan.status}`,
        tone:
          event.payload.plan.status === "abandoned"
            ? "warning"
            : event.payload.plan.status === "active"
              ? "brand"
              : event.payload.plan.status === "superseded"
                ? "info"
                : "success",
      };
    case "tool.requested":
      return {
        ...base,
        detail: event.payload.effect.input.name,
        kind: "tool",
        label: "Calling tool",
        tone: "warning",
      };
    case "tool.completed":
      return {
        ...base,
        detail: event.payload.name,
        kind: "tool",
        label: "Tool completed",
        tone: "success",
      };
    case "tool.failed":
      return {
        ...base,
        detail: `${event.payload.name} · ${event.payload.error.code}`,
        kind: "tool",
        label: "Tool failed",
        tone: "danger",
      };
    case "thread.pause_requested":
      return { ...base, kind: "control", label: "Pause requested", tone: "warning" };
    case "thread.paused":
      return { ...base, kind: "control", label: "Thread paused", tone: "warning" };
    case "thread.continued":
      return { ...base, kind: "control", label: "Thread continued", tone: "info" };
    case "thread.waiting":
      return {
        ...base,
        detail: event.payload.reasonCode,
        kind: "control",
        label: "Decision required",
        tone: "warning",
      };
  }
}

export interface ProjectedThread {
  readonly activePlan: PlanSnapshot | null;
  readonly activity: readonly ActivityEntry[];
  readonly nextId: number;
  readonly transcript: readonly TranscriptEntry[];
}

export function projectThread(
  events: readonly AnyThreadEvent[],
): ProjectedThread {
  const activity: ActivityEntry[] = [];
  const transcript: TranscriptEntry[] = [];
  let activePlan: PlanSnapshot | null = null;
  let nextId = 1;

  for (const event of events) {
    if (event.type === "context.cleared") {
      transcript.splice(0);
      activePlan = null;
    }
    if (event.type === "plan.updated") {
      activePlan = event.payload.plan.status === "active" ? event.payload.plan : null;
    }
    if (event.type === "input.received") {
      transcript.push({
        content: event.payload.content,
        id: nextId++,
        label: "YOU",
        role: "user",
        tone: "brand",
      });
    }

    activity.push({ ...eventActivity(event), id: nextId++ });

    if (
      event.type === "model.completed" &&
      event.payload.response.toolCalls.length === 0
    ) {
      transcript.push({
        content: event.payload.response.content || "(reply without text)",
        id: nextId++,
        label: "JIXU",
        role: "assistant",
        tone: "text",
      });
    }
  }

  return {
    activePlan,
    activity: Object.freeze(activity),
    nextId,
    transcript: Object.freeze(transcript),
  };
}
