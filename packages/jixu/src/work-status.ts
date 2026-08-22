import { isJsonObject } from "jixu-core";
import type { AnyThreadEvent } from "jixu-core";

import type {
  ToolOperation,
  ToolRequestDetail,
  WorkStatus,
} from "./tui-model.ts";
import { thinkingLabel } from "./tui-model.ts";

const DETAIL_MAX_CHARACTERS = 12_000;
const DETAIL_MAX_LINES = 120;

function truncate(value: string, maximum = 72): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum
    ? compact
    : `${compact.slice(0, maximum - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  const newlines = content.match(/\n/gu)?.length ?? 0;
  return newlines + (content.endsWith("\n") ? 0 : 1);
}

function outputPreview(
  content: string,
  position: "end" | "start",
): string | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n").trimEnd();
  if (normalized.length === 0) return undefined;
  return boundDetail(normalized, position);
}

function boundDetail(
  content: string,
  position: "end" | "start" = "start",
): string {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  let truncated = lines.length > DETAIL_MAX_LINES;
  const selectedLines = position === "start"
    ? lines.slice(0, DETAIL_MAX_LINES)
    : lines.slice(-DETAIL_MAX_LINES);
  let selected = selectedLines.join("\n");
  if (selected.length > DETAIL_MAX_CHARACTERS) {
    truncated = true;
    selected = position === "start"
      ? selected.slice(0, DETAIL_MAX_CHARACTERS)
      : selected.slice(-DETAIL_MAX_CHARACTERS);
  }
  if (!truncated) return selected;
  return position === "start" ? `${selected}\n…` : `…\n${selected}`;
}

function rawStringArgument(
  event: Extract<AnyThreadEvent, { readonly type: "tool.requested" }>,
  key: string,
): string | null {
  const value = event.payload.effect.input.arguments[key];
  return typeof value === "string" ? value : null;
}

function requestDetail(
  event: Extract<AnyThreadEvent, { readonly type: "tool.requested" }>,
): ToolRequestDetail {
  const arguments_ = event.payload.effect.input.arguments;
  const name = event.payload.effect.input.name;
  if (name === "read") {
    return {
      content: boundDetail(rawStringArgument(event, "path") ?? "(path unavailable)"),
      kind: "text",
      label: "PATH",
    };
  }
  if (name === "write") {
    return {
      content: boundDetail(rawStringArgument(event, "content") ?? "(content unavailable)"),
      kind: "text",
      label: "CONTENT",
    };
  }
  if (name === "edit") {
    return {
      after: boundDetail(rawStringArgument(event, "newText") ?? ""),
      before: boundDetail(rawStringArgument(event, "oldText") ?? ""),
      kind: "replacement-diff",
      replaceAll: arguments_.replaceAll === true,
    };
  }
  if (name === "bash") {
    return {
      content: boundDetail(rawStringArgument(event, "command") ?? "(command unavailable)"),
      kind: "text",
      label: "COMMAND",
    };
  }
  if (name === "web_search") {
    return {
      content: boundDetail(rawStringArgument(event, "query") ?? "(query unavailable)"),
      kind: "text",
      label: "QUERY",
    };
  }
  return {
    content: boundDetail(JSON.stringify(arguments_, null, 2)),
    kind: "text",
    label: "ARGUMENTS",
  };
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
  if (name === "web_search") {
    return {
      detail: stringArgument(event, "query") ?? name,
      label: "Searching",
      phase: "tool",
      tone: "info",
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
    requestDetail: requestDetail(event),
    status: "running",
  };
}

export function toolOperationForOutcome(
  event: Extract<
    AnyThreadEvent,
    { readonly type: "tool.cancelled" | "tool.completed" | "tool.failed" }
  >,
  operation: ToolOperation,
): ToolOperation {
  if (event.type === "tool.cancelled") {
    return {
      ...operation,
      outcome: "Cancelled before start",
      status: "cancelled",
    };
  }
  if (event.type === "tool.failed") {
    return {
      ...operation,
      outcome: event.payload.error.code,
      preview: truncate(event.payload.error.message, 240),
      status:
        event.payload.disposition === "indeterminate"
          ? "indeterminate"
          : "failed",
    };
  }

  const output = event.payload.output;
  if (!isJsonObject(output)) {
    return { ...operation, outcome: "Completed", status: "succeeded" };
  }

  if (event.payload.name === "read") {
    const content = typeof output.content === "string" ? output.content : null;
    const path = typeof output.path === "string" ? truncate(output.path) : undefined;
    if (content !== null) {
      const lines = lineCount(content);
      const preview = outputPreview(content, "start");
      const truncated = output.truncated === true ? " · truncated" : "";
      return {
        ...operation,
        ...(path === undefined ? {} : { detail: path }),
        outcome: `${lines} ${lines === 1 ? "line" : "lines"} · ${formatBytes(new TextEncoder().encode(content).byteLength)}${truncated}`,
        ...(preview === undefined ? {} : { preview }),
        status: "succeeded",
      };
    }
  }

  if (event.payload.name === "write") {
    const bytes = typeof output.bytes === "number" ? output.bytes : null;
    const path = typeof output.path === "string" ? truncate(output.path) : undefined;
    if (bytes !== null) {
      return {
        ...operation,
        ...(path === undefined ? {} : { detail: path }),
        outcome: `${formatBytes(bytes)} written`,
        status: "succeeded",
      };
    }
  }

  if (event.payload.name === "edit") {
    const replacements =
      typeof output.replacements === "number" ? output.replacements : null;
    const path = typeof output.path === "string" ? truncate(output.path) : undefined;
    if (replacements !== null) {
      return {
        ...operation,
        ...(path === undefined ? {} : { detail: path }),
        outcome: `${replacements} ${replacements === 1 ? "replacement" : "replacements"}`,
        status: "succeeded",
      };
    }
  }

  if (event.payload.name === "bash") {
    const stdout = typeof output.stdout === "string" ? output.stdout : "";
    const stderr = typeof output.stderr === "string" ? output.stderr : "";
    const exitCode = typeof output.exitCode === "number" ? output.exitCode : null;
    const signal = typeof output.signal === "string" ? output.signal : null;
    const outcome = output.cancelled === true
      ? "cancelled"
      : output.timedOut === true
        ? "timed out"
        : signal !== null
          ? `signal ${signal}`
          : exitCode === null
            ? "completed"
            : `exit ${exitCode}`;
    const combinedOutput = stdout.length > 0 && stderr.length > 0
      ? `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`
      : `${stdout}${stderr}`;
    const preview = outputPreview(combinedOutput, "end");
    const warning =
      output.cancelled === true ||
      output.timedOut === true ||
      signal !== null ||
      (exitCode !== null && exitCode !== 0);
    return {
      ...operation,
      outcome: `${outcome}${output.truncated === true ? " · output truncated" : ""}`,
      outcomeTone: warning ? "warning" : "success",
      ...(preview === undefined ? {} : { preview }),
      status: "succeeded",
    };
  }

  if (event.payload.name === "web_search") {
    const results = Array.isArray(output.results) ? output.results : null;
    if (results !== null) {
      const sources = results.flatMap((candidate, index) => {
        if (!isJsonObject(candidate)) return [];
        const title = typeof candidate.title === "string"
          ? candidate.title
          : `Result ${index + 1}`;
        const url = typeof candidate.url === "string" ? candidate.url : "";
        const description = typeof candidate.description === "string"
          ? candidate.description
          : "";
        const content = typeof candidate.content === "string" ? candidate.content : "";
        return [
          `${index + 1}. ${title}\n${url}${description.length === 0 ? "" : `\n${description}`}${content.length === 0 ? "" : `\n\n${content}`}`,
        ];
      });
      const preview = outputPreview(sources.join("\n\n"), "start");
      const bytes = new TextEncoder().encode(
        sources.join("\n\n"),
      ).byteLength;
      return {
        ...operation,
        outcome: `${results.length} ${results.length === 1 ? "source" : "sources"} · ${formatBytes(bytes)}${output.truncated === true ? " · truncated" : ""}`,
        ...(preview === undefined ? {} : { preview }),
        status: "succeeded",
      };
    }
  }

  return { ...operation, outcome: "Completed", status: "succeeded" };
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
        label: thinkingLabel(event.payload.effect.input.mode ?? "standard"),
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
    case "tool.cancelled":
      return null;
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
    case "thread.interrupt_requested":
      return {
        label: "Stopping response",
        phase: "responding",
        tone: "warning",
      };
    case "model.cancelled":
    case "thread.interrupted":
    case "model.completed":
      return null;
    default:
      return null;
  }
}
