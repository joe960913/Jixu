import type {
  PlanSnapshot,
  ThreadMetrics,
  ThreadStatus,
  ToolApproval,
} from "jixu-core";

export type JixuTone =
  | "brand"
  | "danger"
  | "info"
  | "secondary"
  | "success"
  | "text"
  | "warning";

export type TranscriptRole = "assistant" | "notice" | "user";
export type ActivityKind = "control" | "model" | "runtime" | "tool";

export interface TranscriptMessageEntry {
  readonly content: string;
  readonly id: number;
  readonly kind: "message";
  readonly label: string;
  readonly role: TranscriptRole;
  readonly tone: JixuTone;
}

export interface ActivityEntry {
  readonly detail?: string;
  readonly eventId?: string;
  readonly id: number;
  readonly kind: ActivityKind;
  readonly label: string;
  readonly tone: JixuTone;
}

export interface ThreadInspection {
  readonly content: string;
  readonly title: string;
}

export type WorkPhase = "planning" | "responding" | "thinking" | "tool";

export interface WorkStatus {
  readonly detail?: string;
  readonly label: string;
  readonly phase: WorkPhase;
  readonly tone: JixuTone;
}

export type ToolOperationStatus =
  | "failed"
  | "indeterminate"
  | "running"
  | "succeeded";

export type ToolRequestDetail =
  | {
      readonly content: string;
      readonly kind: "text";
      readonly label: "ARGUMENTS" | "COMMAND" | "CONTENT" | "PATH" | "QUERY";
    }
  | {
      readonly after: string;
      readonly before: string;
      readonly kind: "replacement-diff";
      readonly replaceAll: boolean;
    };

export interface ToolOperation {
  readonly detail?: string;
  readonly effectId: string;
  readonly name: string;
  readonly outcome?: string;
  readonly outcomeTone?: "success" | "warning";
  readonly preview?: string;
  readonly requestDetail: ToolRequestDetail;
  readonly status: ToolOperationStatus;
}

export interface ToolLiveOutput {
  readonly text: string;
  readonly truncated: boolean;
}

export interface TranscriptToolReceiptEntry {
  readonly id: number;
  readonly kind: "tool-receipts";
  readonly operations: readonly ToolOperation[];
  readonly requestEventId: string;
}

export type TranscriptEntry =
  | TranscriptMessageEntry
  | TranscriptToolReceiptEntry;

export interface ThreadSummary {
  readonly current: boolean;
  readonly id: string;
  readonly status: ThreadStatus;
  readonly title: string;
  readonly updatedAt: string;
}

export interface ThreadControllerSnapshot {
  readonly activePlan: PlanSnapshot | null;
  readonly activity: readonly ActivityEntry[];
  readonly busy: boolean;
  readonly currentThreadId: string | null;
  readonly inspection: ThreadInspection | null;
  readonly metrics: ThreadMetrics | null;
  readonly streamingText: string;
  readonly threadPickerOpen: boolean;
  readonly threads: readonly ThreadSummary[];
  readonly threadStatus: ThreadStatus | "none";
  readonly toolApproval: ToolApproval | null;
  readonly toolLiveOutput: Readonly<Record<string, ToolLiveOutput>>;
  readonly toolOperations: readonly ToolOperation[];
  readonly transcript: readonly TranscriptEntry[];
  readonly workStatus: WorkStatus | null;
}
