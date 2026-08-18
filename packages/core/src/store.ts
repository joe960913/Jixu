import {
  InvalidTransitionError,
  RevisionConflictError,
  RunAlreadyExistsError,
  RunNotFoundError,
} from "./errors.ts";
import { decodeCheckpoint, decodeRunEvent } from "./codec.ts";
import type { Checkpoint } from "./domain.ts";
import type { AnyRunEvent } from "./events.ts";
import { assertJsonValue, cloneJson } from "./json.ts";
import type { EventStore } from "./ports.ts";
import { replayEvents } from "./reducer.ts";

interface InMemoryRunRecord {
  readonly events: AnyRunEvent[];
}

export class InMemoryEventStore implements EventStore {
  readonly #checkpoints = new Map<string, Checkpoint>();
  readonly #eventIds = new Set<string>();
  readonly #runs = new Map<string, InMemoryRunRecord>();

  async createRun(runId: string): Promise<void> {
    if (this.#runs.has(runId)) {
      throw new RunAlreadyExistsError(runId);
    }
    this.#runs.set(runId, { events: [] });
  }

  async createFork(
    runId: string,
    events: readonly AnyRunEvent[],
  ): Promise<void> {
    if (this.#runs.has(runId)) {
      throw new RunAlreadyExistsError(runId);
    }
    if (events.length === 0) {
      throw new InvalidTransitionError(`Fork ${runId} must contain Events`);
    }

    const localIds = new Set<string>();
    const validated = events.map((event, index) => {
      const decoded = decodeRunEvent(event);
      if (decoded.runId !== runId || decoded.sequence !== index + 1) {
        throw new InvalidTransitionError(
          `Fork Event ${decoded.id} is not contiguous for Run ${runId}`,
        );
      }
      if (this.#eventIds.has(decoded.id) || localIds.has(decoded.id)) {
        throw new InvalidTransitionError(`Event ID ${decoded.id} is already stored`);
      }
      localIds.add(decoded.id);
      return decoded;
    });
    replayEvents(runId, validated);

    this.#runs.set(runId, {
      events: validated.map((event) => cloneJson(event)),
    });
    for (const id of localIds) {
      this.#eventIds.add(id);
    }
  }

  async append(
    runId: string,
    expectedRevision: number,
    event: AnyRunEvent,
  ): Promise<void> {
    const record = this.#runs.get(runId);
    if (record === undefined) {
      throw new RunNotFoundError(runId);
    }
    const actualRevision = record.events.length;
    if (actualRevision !== expectedRevision) {
      throw new RevisionConflictError(
        runId,
        expectedRevision,
        actualRevision,
      );
    }
    if (event.runId !== runId || event.sequence !== expectedRevision + 1) {
      throw new InvalidTransitionError(
        `Event ${event.id} does not continue Run ${runId} at revision ${expectedRevision}`,
      );
    }
    if (this.#eventIds.has(event.id)) {
      throw new InvalidTransitionError(`Event ID ${event.id} is already stored`);
    }

    assertJsonValue(event, `Event ${event.id}`);
    const stored = decodeRunEvent(event);
    record.events.push(stored);
    this.#eventIds.add(stored.id);
  }

  async read(
    runId: string,
    fromSequence = 1,
  ): Promise<readonly AnyRunEvent[]> {
    const record = this.#runs.get(runId);
    if (record === undefined) {
      throw new RunNotFoundError(runId);
    }
    return record.events
      .filter((event) => event.sequence >= fromSequence)
      .map((event) => cloneJson(event));
  }

  async listNonTerminalRuns(): Promise<readonly string[]> {
    const nonTerminal: string[] = [];
    for (const [runId, record] of this.#runs) {
      if (record.events.length === 0) {
        continue;
      }
      const status = replayEvents(runId, record.events).status;
      if (status !== "cancelled" && status !== "completed" && status !== "failed") {
        nonTerminal.push(runId);
      }
    }
    return nonTerminal;
  }

  async readCheckpoint(runId: string): Promise<Checkpoint | null> {
    if (!this.#runs.has(runId)) {
      throw new RunNotFoundError(runId);
    }
    const checkpoint = this.#checkpoints.get(runId);
    return checkpoint === undefined ? null : cloneJson(checkpoint);
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    if (!this.#runs.has(checkpoint.runId)) {
      throw new RunNotFoundError(checkpoint.runId);
    }
    const decoded = decodeCheckpoint(checkpoint);
    this.#checkpoints.set(decoded.runId, decoded);
  }
}
