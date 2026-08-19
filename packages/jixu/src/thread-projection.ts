import type { AnyThreadEvent, PlanSnapshot } from "@jixu/core";

import { toolOperationForRequest } from "./work-status.ts";
import type {
  ActivityEntry,
  ToolOperation,
  ToolOperationStatus,
  TranscriptEntry,
} from "./tui-model.ts";

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
    case "plan.rejected":
      return {
        ...base,
        detail: event.payload.error.message,
        kind: "control",
        label: "Plan kept steady",
        tone: "warning",
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
  readonly toolOperations: readonly ToolOperation[];
  readonly transcript: readonly TranscriptEntry[];
}

export function projectThread(
  events: readonly AnyThreadEvent[],
): ProjectedThread {
  const activity: ActivityEntry[] = [];
  const toolOperations: ToolOperation[] = [];
  const transcript: TranscriptEntry[] = [];
  let activePlan: PlanSnapshot | null = null;
  let nextId = 1;

  for (const event of events) {
    if (event.type === "context.cleared") {
      transcript.splice(0);
      toolOperations.splice(0);
      activePlan = null;
    }
    if (event.type === "plan.updated") {
      activePlan = event.payload.plan.status === "active" ? event.payload.plan : null;
    }
    if (event.type === "input.received") {
      toolOperations.splice(0);
      transcript.push({
        content: event.payload.content,
        id: nextId++,
        kind: "message",
        label: "YOU",
        role: "user",
        tone: "brand",
      });
    }

    activity.push({ ...eventActivity(event), id: nextId++ });

    if (event.type === "tool.requested") {
      const operation = toolOperationForRequest(event);
      toolOperations.push(operation);
      const previous = transcript.at(-1);
      if (previous?.kind === "tool-receipts") {
        transcript[transcript.length - 1] = {
          ...previous,
          operations: Object.freeze([...previous.operations, operation]),
        };
      } else {
        transcript.push({
          id: nextId++,
          kind: "tool-receipts",
          operations: Object.freeze([operation]),
        });
      }
    }
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      const terminalStatus: ToolOperationStatus =
        event.type === "tool.completed" ? "succeeded" : "failed";
      const operationIndex = toolOperations.findIndex(
        (operation) => operation.effectId === event.payload.effectId,
      );
      const operation = toolOperations[operationIndex];
      if (operation !== undefined) {
        const updated = {
          ...operation,
          status: terminalStatus,
        } as const;
        toolOperations[operationIndex] = updated;
      }
      const receiptIndex = transcript.findLastIndex(
        (entry) =>
          entry.kind === "tool-receipts" &&
          entry.operations.some(
            (receipt) => receipt.effectId === event.payload.effectId,
          ),
      );
      const receipt = transcript[receiptIndex];
      if (receipt?.kind === "tool-receipts") {
        transcript[receiptIndex] = {
          ...receipt,
          operations: Object.freeze(
            receipt.operations.map((candidate) =>
              candidate.effectId === event.payload.effectId
                ? { ...candidate, status: terminalStatus }
                : candidate,
            ),
          ),
        };
      }
    }

    if (event.type === "model.completed") {
      const content = event.payload.response.content;
      if (content.length === 0 && event.payload.response.toolCalls.length > 0) {
        continue;
      }
      transcript.push({
        content: content || "(reply without text)",
        id: nextId++,
        kind: "message",
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
    toolOperations: Object.freeze(toolOperations),
    transcript: Object.freeze(transcript),
  };
}
