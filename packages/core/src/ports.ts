import type { ModelOutcome, ModelGenerateEffect } from "./effects.ts";
import type { Checkpoint } from "./domain.ts";
import type { AnyRunEvent } from "./events.ts";
import type { JsonValue } from "./json.ts";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: "event" | "run"): string;
}

export interface Signal {
  readonly data: JsonValue;
  readonly kind: "signal";
  readonly runId: string;
  readonly type: string;
}

export interface SignalSink {
  emit(signal: Signal): void;
}

export interface EventStreamItem {
  readonly event: AnyRunEvent;
  readonly kind: "event";
}

export type RunStreamItem = EventStreamItem | Signal;

export interface ModelDriverContext {
  readonly cancellation: AbortSignal;
  readonly signals: SignalSink;
}

export interface ModelDriver {
  generate(
    effect: ModelGenerateEffect,
    context: ModelDriverContext,
  ): Promise<ModelOutcome>;
}

export interface EventStore {
  append(
    runId: string,
    expectedRevision: number,
    event: AnyRunEvent,
  ): Promise<void>;
  createFork(runId: string, events: readonly AnyRunEvent[]): Promise<void>;
  createRun(runId: string): Promise<void>;
  listNonTerminalRuns(): Promise<readonly string[]>;
  read(runId: string, fromSequence?: number): Promise<readonly AnyRunEvent[]>;
  readCheckpoint(runId: string): Promise<Checkpoint | null>;
  writeCheckpoint(checkpoint: Checkpoint): Promise<void>;
}
