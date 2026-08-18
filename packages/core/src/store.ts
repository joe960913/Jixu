import {
  InvalidTransitionError,
  RevisionConflictError,
  ThreadAlreadyExistsError,
  ThreadNotFoundError,
} from "./errors.ts";
import { decodeCheckpoint, decodeThreadEvent } from "./codec.ts";
import type { Checkpoint } from "./domain.ts";
import type { AnyThreadEvent } from "./events.ts";
import { assertJsonValue, cloneJson } from "./json.ts";
import type { EventStore } from "./ports.ts";
import { replayEvents } from "./reducer.ts";

interface InMemoryThreadRecord {
  readonly events: AnyThreadEvent[];
}

export class InMemoryEventStore implements EventStore {
  readonly #checkpoints = new Map<string, Checkpoint>();
  readonly #eventIds = new Set<string>();
  readonly #threads = new Map<string, InMemoryThreadRecord>();

  async createThread(threadId: string): Promise<void> {
    if (this.#threads.has(threadId)) {
      throw new ThreadAlreadyExistsError(threadId);
    }
    this.#threads.set(threadId, { events: [] });
  }

  async createFork(
    threadId: string,
    events: readonly AnyThreadEvent[],
  ): Promise<void> {
    if (this.#threads.has(threadId)) {
      throw new ThreadAlreadyExistsError(threadId);
    }
    if (events.length === 0) {
      throw new InvalidTransitionError(`Fork ${threadId} must contain Events`);
    }

    const localIds = new Set<string>();
    const validated = events.map((event, index) => {
      const decoded = decodeThreadEvent(event);
      if (decoded.threadId !== threadId || decoded.sequence !== index + 1) {
        throw new InvalidTransitionError(
          `Fork Event ${decoded.id} is not contiguous for Thread ${threadId}`,
        );
      }
      if (this.#eventIds.has(decoded.id) || localIds.has(decoded.id)) {
        throw new InvalidTransitionError(`Event ID ${decoded.id} is already stored`);
      }
      localIds.add(decoded.id);
      return decoded;
    });
    replayEvents(threadId, validated);

    this.#threads.set(threadId, {
      events: validated.map((event) => cloneJson(event)),
    });
    for (const id of localIds) {
      this.#eventIds.add(id);
    }
  }

  async append(
    threadId: string,
    expectedRevision: number,
    event: AnyThreadEvent,
  ): Promise<void> {
    const record = this.#threads.get(threadId);
    if (record === undefined) {
      throw new ThreadNotFoundError(threadId);
    }
    const actualRevision = record.events.length;
    if (actualRevision !== expectedRevision) {
      throw new RevisionConflictError(
        threadId,
        expectedRevision,
        actualRevision,
      );
    }
    if (event.threadId !== threadId || event.sequence !== expectedRevision + 1) {
      throw new InvalidTransitionError(
        `Event ${event.id} does not continue Thread ${threadId} at revision ${expectedRevision}`,
      );
    }
    if (this.#eventIds.has(event.id)) {
      throw new InvalidTransitionError(`Event ID ${event.id} is already stored`);
    }

    assertJsonValue(event, `Event ${event.id}`);
    const stored = decodeThreadEvent(event);
    record.events.push(stored);
    this.#eventIds.add(stored.id);
  }

  async read(
    threadId: string,
    fromSequence = 1,
  ): Promise<readonly AnyThreadEvent[]> {
    const record = this.#threads.get(threadId);
    if (record === undefined) {
      throw new ThreadNotFoundError(threadId);
    }
    return record.events
      .filter((event) => event.sequence >= fromSequence)
      .map((event) => cloneJson(event));
  }

  async listThreads(): Promise<readonly string[]> {
    return [...this.#threads]
      .filter(([, record]) => record.events.length > 0)
      .map(([threadId]) => threadId);
  }

  async readCheckpoint(threadId: string): Promise<Checkpoint | null> {
    if (!this.#threads.has(threadId)) {
      throw new ThreadNotFoundError(threadId);
    }
    const checkpoint = this.#checkpoints.get(threadId);
    return checkpoint === undefined ? null : cloneJson(checkpoint);
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    if (!this.#threads.has(checkpoint.threadId)) {
      throw new ThreadNotFoundError(checkpoint.threadId);
    }
    const decoded = decodeCheckpoint(checkpoint);
    this.#checkpoints.set(decoded.threadId, decoded);
  }
}
