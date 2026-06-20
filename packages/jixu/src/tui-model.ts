import type { ThreadStatus } from "@jixu/core";

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

export interface TranscriptEntry {
  readonly content: string;
  readonly id: number;
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

export interface ThreadSummary {
  readonly current: boolean;
  readonly id: string;
  readonly status: ThreadStatus;
  readonly title: string;
  readonly updatedAt: string;
}

export interface ThreadControllerSnapshot {
  readonly activity: readonly ActivityEntry[];
  readonly busy: boolean;
  readonly currentThreadId: string | null;
  readonly inspection: ThreadInspection | null;
  readonly streamingText: string;
  readonly threadPickerOpen: boolean;
  readonly threads: readonly ThreadSummary[];
  readonly threadStatus: ThreadStatus | "none";
  readonly transcript: readonly TranscriptEntry[];
}
