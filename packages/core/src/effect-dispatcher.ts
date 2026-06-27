import type { AgentDefinition, ExecutableTool } from "./agent.ts";
import { parseModelResponse } from "./domain.ts";
import type { DriverError } from "./domain.ts";
import type {
  EffectRequest,
  ModelGenerateEffect,
  ModelOutcome,
  ToolExecuteEffect,
} from "./effects.ts";
import { InvalidTransitionError, ToolExecutionError } from "./errors.ts";
import { assertJsonValue, cloneJson } from "./json.ts";
import type { JsonValue } from "./json.ts";
import {
  EMPTY_MODEL_ACCOUNTING,
  parseModelAccounting,
} from "./metrics.ts";
import type { ModelAccounting } from "./metrics.ts";
import type { ModelDriver, Signal, SignalSink } from "./ports.ts";
import type { ThreadEventPayloads } from "./events.ts";
import type { ObservationBroker } from "./observation.ts";

export type OutcomeProposal = {
  [TType in
    | "model.completed"
    | "model.failed"
    | "tool.completed"
    | "tool.failed"]: {
    readonly payload: ThreadEventPayloads[TType];
    readonly type: TType;
  };
}[
  | "model.completed"
  | "model.failed"
  | "tool.completed"
  | "tool.failed"];

export interface EffectDispatcherConfig {
  readonly agent: AgentDefinition;
  readonly modelDrivers: Readonly<Record<string, ModelDriver>>;
  readonly observations: ObservationBroker;
  readonly signals: SignalSink;
}

function driverError(code: string, message: string, retryable: boolean): DriverError {
  return { code, message, retryable };
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Driver error";
}

export class EffectDispatcher {
  readonly #agent: AgentDefinition;
  readonly #modelDrivers: Readonly<Record<string, ModelDriver>>;
  readonly #observations: ObservationBroker;
  readonly #signals: SignalSink;

  constructor(config: EffectDispatcherConfig) {
    this.#agent = config.agent;
    this.#modelDrivers = config.modelDrivers;
    this.#observations = config.observations;
    this.#signals = config.signals;
  }

  dispatch(effect: EffectRequest): Promise<OutcomeProposal> {
    return effect.type === "model.generate"
      ? this.#dispatchModel(effect)
      : this.#dispatchTool(effect);
  }

  async #dispatchModel(effect: ModelGenerateEffect): Promise<OutcomeProposal> {
    const driver = this.#modelDrivers[effect.input.model.provider];
    if (driver === undefined) {
      return {
        payload: {
          accounting: EMPTY_MODEL_ACCOUNTING,
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
      outcome = await driver.generate(cloneJson(effect), {
        cancellation: new AbortController().signal,
        signals: this.#signalsFor(effect.threadId),
      });
    } catch (error) {
      outcome = {
        error: driverError("model_driver_exception", messageFrom(error), true),
        status: "indeterminate",
      };
    }

    let accounting: ModelAccounting;
    try {
      accounting = parseModelAccounting(
        outcome.accounting ?? EMPTY_MODEL_ACCOUNTING,
      );
    } catch (error) {
      return {
        payload: {
          accounting: EMPTY_MODEL_ACCOUNTING,
          disposition: "failed",
          effectId: effect.id,
          error: driverError(
            "model_accounting_invalid",
            messageFrom(error),
            false,
          ),
        },
        type: "model.failed",
      };
    }

    if (outcome.status !== "succeeded") {
      return {
        payload: {
          accounting,
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
          accounting,
          effectId: effect.id,
          response: parseModelResponse(outcome.value),
        },
        type: "model.completed",
      };
    } catch (error) {
      return {
        payload: {
          accounting,
          disposition: "failed",
          effectId: effect.id,
          error: driverError("model_response_invalid", messageFrom(error), false),
        },
        type: "model.failed",
      };
    }
  }

  async #dispatchTool(effect: ToolExecuteEffect): Promise<OutcomeProposal> {
    const tool = this.#agent.tools.find(
      (candidate) => candidate.descriptor.name === effect.input.name,
    );
    if (tool === undefined) {
      return this.#toolFailure(
        effect,
        "failed",
        driverError("tool_missing", `Tool ${effect.input.name} is not registered`, false),
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
      if (error instanceof ToolExecutionError) {
        return this.#toolFailure(
          effect,
          "failed",
          driverError(error.code, error.message, error.retryable),
        );
      }
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

  #executeTool(
    tool: ExecutableTool,
    input: JsonValue,
    effect: ToolExecuteEffect,
  ): Promise<JsonValue> {
    return tool.execute(cloneJson(input), {
      cancellation: new AbortController().signal,
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      threadId: effect.threadId,
      signals: this.#signalsFor(effect.threadId),
    });
  }

  #signalsFor(threadId: string): SignalSink {
    return {
      emit: (signal: Signal) => {
        if (signal.threadId !== threadId) {
          throw new InvalidTransitionError(
            `Signal Thread ${signal.threadId} does not match active Thread ${threadId}`,
          );
        }
        const copied = cloneJson(signal);
        this.#observations.publish(threadId, copied);
        try {
          this.#signals.emit(copied);
        } catch {
          // Observation sinks cannot change authoritative execution.
        }
      },
    };
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
