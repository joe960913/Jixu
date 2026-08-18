import type { AgentDefinition, ExecutableTool } from "./agent.ts";
import {
  createInitialRunState,
  parseModelResponse,
} from "./domain.ts";
import type { DriverError, RunState } from "./domain.ts";
import type {
  EffectRequest,
  ModelGenerateEffect,
  ModelOutcome,
  ToolExecuteEffect,
} from "./effects.ts";
import { InvalidTransitionError, RunNotFoundError } from "./errors.ts";
import { createRunEvent } from "./events.ts";
import type {
  AnyRunEvent,
  RunEventPayloads,
  RunEventType,
} from "./events.ts";
import { assertJsonValue, cloneJson } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type {
  Clock,
  EventStore,
  IdGenerator,
  ModelDriver,
  SignalSink,
} from "./ports.ts";
import { reduce } from "./reducer.ts";
import { InMemoryEventStore } from "./store.ts";

class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

class RandomIdGenerator implements IdGenerator {
  next(prefix: "event" | "run"): string {
    return `${prefix}_${crypto.randomUUID()}`;
  }
}

class NoopSignalSink implements SignalSink {
  emit(): void {}
}

export interface RuntimeConfig {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly modelDrivers: Readonly<Record<string, ModelDriver>>;
  readonly signals?: SignalSink;
  readonly store?: EventStore;
}

export interface RunHandle {
  readonly id: string;
  events(): Promise<readonly AnyRunEvent[]>;
  state(): Promise<RunState>;
}

interface PreparedEffect {
  readonly effect: EffectRequest;
  readonly requestEventId: string;
}

type OutcomeProposal = {
  [TType in
    | "model.completed"
    | "model.failed"
    | "tool.completed"
    | "tool.failed"]: {
    readonly payload: RunEventPayloads[TType];
    readonly type: TType;
  };
}[
  | "model.completed"
  | "model.failed"
  | "tool.completed"
  | "tool.failed"];

function driverError(code: string, message: string, retryable: boolean): DriverError {
  return { code, message, retryable };
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Driver error";
}

export class Runtime {
  readonly #agents = new Map<string, AgentDefinition>();
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #modelDrivers: Readonly<Record<string, ModelDriver>>;
  readonly #signals: SignalSink;
  readonly #states = new Map<string, RunState>();
  readonly #store: EventStore;

  constructor(config: RuntimeConfig) {
    this.#clock = config.clock ?? new SystemClock();
    this.#ids = config.ids ?? new RandomIdGenerator();
    this.#modelDrivers = config.modelDrivers;
    this.#signals = config.signals ?? new NoopSignalSink();
    this.#store = config.store ?? new InMemoryEventStore();
  }

  async run(agent: AgentDefinition, input: string): Promise<RunHandle> {
    const runId = this.#ids.next("run");
    await this.#store.createRun(runId);
    this.#agents.set(runId, agent);
    this.#states.set(runId, createInitialRunState(runId));

    await this.#commit(runId, "run.created", { agent: agent.snapshot });
    const accepted = await this.#commit(runId, "input.received", { content: input });
    await this.#drive(runId, accepted.effects);

    return {
      id: runId,
      events: () => this.#store.read(runId),
      state: () => this.#getState(runId),
    };
  }

  async #getState(runId: string): Promise<RunState> {
    const state = this.#states.get(runId);
    if (state === undefined) {
      throw new RunNotFoundError(runId);
    }
    return cloneJson(state);
  }

  async #commit<TType extends RunEventType>(
    runId: string,
    type: TType,
    payload: RunEventPayloads[TType],
    causationId?: string,
  ): Promise<{
    readonly effects: readonly EffectRequest[];
    readonly event: AnyRunEvent;
  }> {
    const current = this.#states.get(runId);
    if (current === undefined) {
      throw new RunNotFoundError(runId);
    }

    const common = {
      id: this.#ids.next("event"),
      payload,
      runId,
      sequence: current.revision + 1,
      timestamp: this.#clock.now(),
      type,
    };
    const event = createRunEvent(
      causationId === undefined ? common : { ...common, causationId },
    ) as AnyRunEvent;

    assertJsonValue(event, `Event ${event.id}`);
    const preview = reduce(current, event);
    await this.#store.append(runId, current.revision, event);
    this.#states.set(runId, preview.state);
    return { effects: preview.effects, event };
  }

  async #drive(
    runId: string,
    initialEffects: readonly EffectRequest[],
  ): Promise<void> {
    let effects = [...initialEffects];
    while (effects.length > 0) {
      const prepared: PreparedEffect[] = [];

      for (const effect of effects) {
        const committed =
          effect.type === "model.generate"
            ? await this.#commit(
                runId,
                "model.requested",
                { effect },
                effect.requestedByEventId,
              )
            : await this.#commit(
                runId,
                "tool.requested",
                { effect },
                effect.requestedByEventId,
              );
        if (committed.effects.length !== 0) {
          throw new InvalidTransitionError(
            `${committed.event.type} unexpectedly requested another Effect`,
          );
        }
        prepared.push({ effect, requestEventId: committed.event.id });
      }

      const proposals = await Promise.all(
        prepared.map(async ({ effect, requestEventId }) => ({
          proposal: await this.#dispatch(runId, effect),
          requestEventId,
        })),
      );

      const nextEffects: EffectRequest[] = [];
      for (const { proposal, requestEventId } of proposals) {
        const committed = await this.#commitProposal(
          runId,
          proposal,
          requestEventId,
        );
        nextEffects.push(...committed);
      }
      effects = nextEffects;
    }
  }

  async #commitProposal(
    runId: string,
    proposal: OutcomeProposal,
    causationId: string,
  ): Promise<readonly EffectRequest[]> {
    switch (proposal.type) {
      case "model.completed":
        return (await this.#commit(runId, proposal.type, proposal.payload, causationId))
          .effects;
      case "model.failed":
        return (await this.#commit(runId, proposal.type, proposal.payload, causationId))
          .effects;
      case "tool.completed":
        return (await this.#commit(runId, proposal.type, proposal.payload, causationId))
          .effects;
      case "tool.failed":
        return (await this.#commit(runId, proposal.type, proposal.payload, causationId))
          .effects;
    }
  }

  async #dispatch(
    runId: string,
    effect: EffectRequest,
  ): Promise<OutcomeProposal> {
    if (effect.type === "model.generate") {
      return this.#dispatchModel(effect);
    }
    return this.#dispatchTool(runId, effect);
  }

  async #dispatchModel(effect: ModelGenerateEffect): Promise<OutcomeProposal> {
    const driver = this.#modelDrivers[effect.input.model.provider];
    if (driver === undefined) {
      return {
        payload: {
          disposition: "failed",
          effectId: effect.id,
          error: driverError(
            "model_driver_missing",
            `No Model Driver is registered for ${effect.input.model.provider}`,
            false,
          ),
        },
        type: "model.failed",
      };
    }

    let outcome: ModelOutcome;
    try {
      outcome = await driver.generate(cloneJson(effect));
    } catch (error) {
      outcome = {
        error: driverError("model_driver_exception", messageFrom(error), true),
        status: "indeterminate",
      };
    }

    if (outcome.status !== "succeeded") {
      return {
        payload: {
          disposition: outcome.status,
          effectId: effect.id,
          error: outcome.error,
        },
        type: "model.failed",
      };
    }

    try {
      return {
        payload: {
          effectId: effect.id,
          response: parseModelResponse(outcome.value),
        },
        type: "model.completed",
      };
    } catch (error) {
      return {
        payload: {
          disposition: "failed",
          effectId: effect.id,
          error: driverError("model_response_invalid", messageFrom(error), false),
        },
        type: "model.failed",
      };
    }
  }

  async #dispatchTool(
    runId: string,
    effect: ToolExecuteEffect,
  ): Promise<OutcomeProposal> {
    const agent = this.#agents.get(runId);
    const tool = agent?.tools.find(
      (candidate) => candidate.descriptor.name === effect.input.name,
    );
    if (tool === undefined) {
      return this.#toolFailure(
        effect,
        "failed",
        driverError(
          "tool_missing",
          `Tool ${effect.input.name} is not registered`,
          false,
        ),
      );
    }

    let input: JsonValue;
    try {
      input = tool.parseInput(cloneJson(effect.input.arguments));
    } catch (error) {
      return this.#toolFailure(
        effect,
        "failed",
        driverError("tool_input_invalid", messageFrom(error), false),
      );
    }

    let output: JsonValue;
    try {
      output = await this.#executeTool(tool, input, effect);
    } catch (error) {
      return this.#toolFailure(
        effect,
        "indeterminate",
        driverError("tool_driver_exception", messageFrom(error), false),
      );
    }

    try {
      const parsed = tool.parseOutput(output);
      assertJsonValue(parsed, `Output from Tool ${effect.input.name}`);
      return {
        payload: {
          effectId: effect.id,
          name: effect.input.name,
          output: parsed,
          toolCallId: effect.input.toolCallId,
        },
        type: "tool.completed",
      };
    } catch (error) {
      return this.#toolFailure(
        effect,
        "failed",
        driverError("tool_output_invalid", messageFrom(error), false),
      );
    }
  }

  async #executeTool(
    tool: ExecutableTool,
    input: JsonValue,
    effect: ToolExecuteEffect,
  ): Promise<JsonValue> {
    return tool.execute(cloneJson(input), {
      cancellation: new AbortController().signal,
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      runId: effect.runId,
      signals: this.#signals,
    });
  }

  #toolFailure(
    effect: ToolExecuteEffect,
    disposition: "failed" | "indeterminate",
    error: DriverError,
  ): OutcomeProposal {
    return {
      payload: {
        disposition,
        effectId: effect.id,
        error,
        name: effect.input.name,
        toolCallId: effect.input.toolCallId,
      },
      type: "tool.failed",
    };
  }
}

export function createRuntime(config: RuntimeConfig): Runtime {
  return new Runtime(config);
}
