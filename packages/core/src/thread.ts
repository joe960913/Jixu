import type { ThreadState } from "./domain.ts";
import type { AnyThreadEvent } from "./events.ts";
import type { ThreadStreamItem } from "./ports.ts";

export interface ForkOptions {
  readonly at: string;
  readonly input: string;
}

export interface ThreadStreamOptions {
  readonly fromSequence?: number;
  readonly signal?: AbortSignal;
}

export interface Thread {
  readonly id: string;
  clear(): Promise<ThreadState>;
  continue(): Promise<ThreadState>;
  events(): Promise<readonly AnyThreadEvent[]>;
  fork(options: ForkOptions): Promise<Thread>;
  pause(): Promise<ThreadState>;
  replay(): Promise<ThreadState>;
  send(input: string): Promise<ThreadState>;
  state(): Promise<ThreadState>;
  stream(options?: ThreadStreamOptions): AsyncIterable<ThreadStreamItem>;
  wait(): Promise<ThreadState>;
}
