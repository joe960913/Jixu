import {
  InvalidTransitionError,
  RevisionConflictError,
  RunAlreadyExistsError,
  RunNotFoundError,
} from "./errors.ts";
import type { AnyRunEvent } from "./events.ts";
import { assertJsonValue, cloneJson } from "./json.ts";
import type { EventStore } from "./ports.ts";
import { replayEvents } from "./reducer.ts";

interface InMemoryRunRecord {
  readonly events: AnyRunEvent[];
}

export class InMemoryEventStore implements EventStore {
  readonly #eventIds = new Set<string>();
  readonly #runs = new Map<string, InMemoryRunRecord>();

  async createRun(runId: string): Promise<void> {
    if (this.#runs.has(runId)) {
      throw new RunAlreadyExistsError(runId);
    }
    this.#runs.set(runId, { events: [] });
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
    const stored = cloneJson(event);
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
}
