import { cloneJson } from "./json.ts";
import type { ThreadStreamItem } from "./ports.ts";

class ObservationQueue {
  readonly #items: ThreadStreamItem[] = [];
  readonly #waiters: Array<(item: ThreadStreamItem | null) => void> = [];
  #closed = false;

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }

  drain(): readonly ThreadStreamItem[] {
    return this.#items.splice(0);
  }

  next(): Promise<ThreadStreamItem | null> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  push(item: ThreadStreamItem): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter(item);
  }
}

export class ObservationBroker {
  readonly #queues = new Map<string, Set<ObservationQueue>>();

  publish(threadId: string, item: ThreadStreamItem): void {
    for (const queue of this.#queues.get(threadId) ?? []) {
      queue.push(cloneJson(item));
    }
  }

  subscribe(threadId: string): {
    readonly dispose: () => void;
    readonly queue: ObservationQueue;
  } {
    const queue = new ObservationQueue();
    const queues = this.#queues.get(threadId) ?? new Set<ObservationQueue>();
    queues.add(queue);
    this.#queues.set(threadId, queues);
    return {
      dispose: () => {
        queue.close();
        queues.delete(queue);
        if (queues.size === 0) this.#queues.delete(threadId);
      },
      queue,
    };
  }
}
