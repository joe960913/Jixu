import type {
  ThreadMode,
  ThreadState,
  ToolApprovalDecision,
} from "./domain.ts";
import type { AnyThreadEvent } from "./events.ts";
import type { ThreadStreamItem } from "./ports.ts";
import type { ThreadInput } from "./input.ts";

export interface ForkOptions {
  readonly at: string;
  readonly input: ThreadInput;
}

export interface ThreadStreamOptions {
  readonly fromSequence?: number;
  readonly signal?: AbortSignal;
}

export interface Thread {
  readonly id: string;
  clear(): Promise<ThreadState>;
  continue(): Promise<ThreadState>;
  decideApproval(
    effectId: string,
    decision: ToolApprovalDecision,
  ): Promise<ThreadState>;
  events(): Promise<readonly AnyThreadEvent[]>;
  fork(options: ForkOptions): Promise<Thread>;
  interrupt(): Promise<ThreadState>;
  pause(): Promise<ThreadState>;
  replay(): Promise<ThreadState>;
  setMode(mode: ThreadMode): Promise<ThreadState>;
  send(input: ThreadInput): Promise<ThreadState>;
  state(): Promise<ThreadState>;
  stream(options?: ThreadStreamOptions): AsyncIterable<ThreadStreamItem>;
  wait(): Promise<ThreadState>;
}
