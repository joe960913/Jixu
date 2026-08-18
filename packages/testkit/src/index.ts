import type {
  Clock,
  DriverError,
  DriverOutcome,
  IdGenerator,
  ModelDriver,
  ModelGenerateEffect,
  ModelOutcome,
  Signal,
  SignalSink,
} from "../../core/src/index.ts";

export class FixedClock implements Clock {
  readonly #value: string;

  constructor(value = "2026-01-01T00:00:00.000Z") {
    this.#value = value;
  }

  now(): string {
    return this.#value;
  }
}

export class SequenceClock implements Clock {
  readonly #values: string[];

  constructor(values: readonly string[]) {
    this.#values = [...values];
  }

  now(): string {
    const value = this.#values.shift();
    if (value === undefined) {
      throw new Error("SequenceClock has no remaining timestamp");
    }
    return value;
  }
}

export class SequenceIdGenerator implements IdGenerator {
  #sequence = 0;

  next(prefix: "event" | "run"): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence.toString().padStart(4, "0")}`;
  }
}

export class SequenceModelDriver implements ModelDriver {
  readonly #effects: ModelGenerateEffect[] = [];
  readonly #outcomes: ModelOutcome[];

  constructor(outcomes: readonly ModelOutcome[]) {
    this.#outcomes = [...outcomes];
  }

  get effects(): readonly ModelGenerateEffect[] {
    return [...this.#effects];
  }

  async generate(effect: ModelGenerateEffect): Promise<ModelOutcome> {
    this.#effects.push(structuredClone(effect));
    const outcome = this.#outcomes.shift();
    if (outcome === undefined) {
      throw new Error("SequenceModelDriver has no remaining outcome");
    }
    return structuredClone(outcome);
  }
}

export class RecordingSignalSink implements SignalSink {
  readonly #signals: Signal[] = [];

  get signals(): readonly Signal[] {
    return structuredClone(this.#signals);
  }

  emit(signal: Signal): void {
    this.#signals.push(structuredClone(signal));
  }
}

export function succeed<TValue>(value: TValue): DriverOutcome<TValue> {
  return { status: "succeeded", value };
}

export function fail(
  code: string,
  message: string,
  retryable = false,
): DriverOutcome<never> {
  const error: DriverError = { code, message, retryable };
  return { error, status: "failed" };
}

export function indeterminate(
  code: string,
  message: string,
): DriverOutcome<never> {
  const error: DriverError = { code, message, retryable: false };
  return { error, status: "indeterminate" };
}
