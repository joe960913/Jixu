import type {
  ContextCompactEffect,
  ContextCompactionOutcome,
  ModelOutcome,
  ModelGenerateEffect,
} from "./effects.ts";
import type { Checkpoint } from "./domain.ts";
import type { AnyThreadEvent } from "./events.ts";
import type { ArtifactReference } from "./input.ts";
import type { JsonValue } from "./json.ts";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: "event" | "thread"): string;
}

export interface Signal {
  readonly data: JsonValue;
  readonly kind: "signal";
  readonly threadId: string;
  readonly type: string;
}

export interface SignalSink {
  emit(signal: Signal): void;
}

export interface EventStreamItem {
  readonly event: AnyThreadEvent;
  readonly kind: "event";
}

export type ThreadStreamItem = EventStreamItem | Signal;

export interface ModelDriverContext {
  readonly artifacts: ArtifactReader;
  readonly cancellation: AbortSignal;
  readonly signals: SignalSink;
}

export interface ModelDriver {
  compact?(
    effect: ContextCompactEffect,
    context: ModelDriverContext,
  ): Promise<ContextCompactionOutcome>;
  generate(
    effect: ModelGenerateEffect,
    context: ModelDriverContext,
  ): Promise<ModelOutcome>;
}

export interface ArtifactReader {
  readArtifact(reference: ArtifactReference): Promise<Uint8Array>;
}

export interface ArtifactStore extends ArtifactReader {
  putArtifact(reference: ArtifactReference, bytes: Uint8Array): Promise<void>;
}

export interface EventStore extends ArtifactStore {
  append(
    threadId: string,
    expectedRevision: number,
    event: AnyThreadEvent,
  ): Promise<void>;
  createFork(threadId: string, events: readonly AnyThreadEvent[]): Promise<void>;
  createThread(threadId: string): Promise<void>;
  listThreads(): Promise<readonly string[]>;
  read(threadId: string, fromSequence?: number): Promise<readonly AnyThreadEvent[]>;
  readCheckpoint(threadId: string): Promise<Checkpoint | null>;
  writeCheckpoint(checkpoint: Checkpoint): Promise<void>;
}
