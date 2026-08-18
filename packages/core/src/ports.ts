import type { ModelOutcome, ModelGenerateEffect } from "./effects.ts";
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

export interface ModelDriver {
  generate(effect: ModelGenerateEffect): Promise<ModelOutcome>;
}

export interface EventStore {
  append(
    runId: string,
    expectedRevision: number,
    event: AnyRunEvent,
  ): Promise<void>;
  createRun(runId: string): Promise<void>;
  listNonTerminalRuns(): Promise<readonly string[]>;
  read(runId: string, fromSequence?: number): Promise<readonly AnyRunEvent[]>;
}
