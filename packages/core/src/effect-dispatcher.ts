import type { AgentDefinition, ExecutableTool } from "./agent.ts";
import { parseModelResponse } from "./domain.ts";
import type { DriverError } from "./domain.ts";
import type {
  ContextCompactEffect,
  ContextCompactionOutcome,
  EffectRequest,
  ModelGenerateEffect,
  ModelOutcome,
  ToolExecuteEffect,
} from "./effects.ts";
import {
  createContinuityHandoff,
  estimateContextTokens,
  parseContinuityHandoffBody,
} from "./context.ts";
import { InvalidTransitionError, ToolExecutionError } from "./errors.ts";
import { assertJsonValue, canonicalJson, cloneJson } from "./json.ts";
import type { JsonValue } from "./json.ts";
import {
  EMPTY_MODEL_ACCOUNTING,
  parseModelAccounting,
} from "./metrics.ts";
import type { ModelAccounting } from "./metrics.ts";
import type {
  ArtifactStore,
  ModelDriver,
  Signal,
  SignalSink,
} from "./ports.ts";
import {
  artifactDigest,
  CONTINUITY_HANDOFF_MEDIA_TYPE,
} from "./input.ts";
import type { PreparedArtifact } from "./input.ts";
import type { ThreadEventPayloads } from "./events.ts";
import type { ObservationBroker } from "./observation.ts";
import {
  ALLOW_ALL_TOOL_POLICY,
  defineToolPermissionPolicy,
  resolveToolPermission,
} from "./tool-permissions.ts";
import type {
  ToolAuthorizationRequest,
  ToolPermissionEffect,
  ToolPermissionPolicy,
} from "./tool-permissions.ts";

export type OutcomeProposal = {
  [TType in
    | "context.compacted"
    | "context.compaction_failed"
    | "model.completed"
    | "model.failed"
    | "tool.completed"
    | "tool.failed"]: {
    readonly artifacts?: readonly PreparedArtifact[];
    readonly payload: ThreadEventPayloads[TType];
    readonly type: TType;
  };
}[
  | "context.compacted"
  | "context.compaction_failed"
  | "model.completed"
  | "model.failed"
  | "tool.completed"
  | "tool.failed"];

export interface EffectDispatcherConfig {
  readonly agent: AgentDefinition;
  readonly artifacts: ArtifactStore;
  readonly modelDrivers: Readonly<Record<string, ModelDriver>>;
  readonly observations: ObservationBroker;
  readonly signals: SignalSink;
  readonly toolPermissionPolicy?: ToolPermissionPolicy;
}

export interface ToolPermissionInspection {
  readonly effect: ToolPermissionEffect;
  readonly request: ToolAuthorizationRequest;
}

function driverError(code: string, message: string, retryable: boolean): DriverError {
  return { code, message, retryable };
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Driver error";
}

function parseDriverError(value: unknown, label: string): DriverError {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }
  const candidate = value as Partial<DriverError>;
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.retryable !== "boolean"
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return {
    code: candidate.code,
    message: candidate.message,
    retryable: candidate.retryable,
  };
}

export class EffectDispatcher {
  readonly #agent: AgentDefinition;
  readonly #artifacts: ArtifactStore;
  readonly #modelDrivers: Readonly<Record<string, ModelDriver>>;
  readonly #observations: ObservationBroker;
  readonly #signals: SignalSink;
  readonly #toolPermissionPolicy: ToolPermissionPolicy;

  constructor(config: EffectDispatcherConfig) {
    this.#agent = config.agent;
    this.#artifacts = config.artifacts;
    this.#modelDrivers = config.modelDrivers;
    this.#observations = config.observations;
    this.#signals = config.signals;
    this.#toolPermissionPolicy = defineToolPermissionPolicy(
      config.toolPermissionPolicy ?? ALLOW_ALL_TOOL_POLICY,
    );
  }

  dispatch(effect: EffectRequest): Promise<OutcomeProposal> {
    switch (effect.type) {
      case "context.compact":
        return this.#dispatchCompaction(effect);
      case "model.generate":
        return this.#dispatchModel(effect);
      case "tool.execute":
        return this.#dispatchTool(effect);
    }
  }

  inspectToolPermission(
    effect: ToolExecuteEffect,
  ): ToolPermissionInspection | null {
    const tool = this.#agent.tools.find(
      (candidate) => candidate.descriptor.name === effect.input.name,
    );
    if (tool === undefined) return null;
    try {
      const input = tool.parseInput(cloneJson(effect.input.arguments));
      const request = tool.authorize(input);
      return Object.freeze({
        effect: resolveToolPermission(this.#toolPermissionPolicy, request).effect,
        request,
      });
    } catch {
      // Missing Tools and invalid inputs still use the ordinary typed Tool
      // failure path after their durable request is accepted.
      return null;
    }
  }

  rejectToolPermission(
    effect: ToolExecuteEffect,
    message = `Tool ${effect.input.name} is denied by the configured permission policy`,
  ): OutcomeProposal {
    return this.#toolFailure(
      effect,
      "failed",
      driverError("tool_permission_denied", message, false),
    );
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
        artifacts: this.#artifacts,
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
      const planRejections = (outcome.planRejections ?? []).map(
        (rejection, index) =>
          parseDriverError(rejection, `Model Plan rejection ${index}`),
      );
      return {
        payload: {
          accounting,
          effectId: effect.id,
          ...(planRejections.length === 0
            ? {}
            : {
                planRejections: planRejections.map((error) => ({
                  effectId: effect.id,
                  error,
                  proposals: [],
                })),
              }),
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

  async #dispatchCompaction(
    effect: ContextCompactEffect,
  ): Promise<OutcomeProposal> {
    const driver = this.#modelDrivers[effect.input.model.provider];
    if (driver?.compact === undefined) {
      return this.#compactionFailure(
        effect,
        "failed",
        driverError(
          "context_compaction_driver_missing",
          `No compatible Context compaction Driver is registered for ${effect.input.model.provider}`,
          false,
        ),
      );
    }
    if (
      effect.input.minimumInputTokens >=
        effect.input.policy.contextWindowTokens -
          effect.input.policy.reservedOutputTokens -
          effect.input.policy.safetyMarginTokens ||
      effect.input.sourceMessages.length === 0 &&
      effect.input.previousHandoff === null
    ) {
      return this.#compactionFailure(
        effect,
        "failed",
        driverError(
          "context_budget_uncompactable",
          "Immutable Agent and capability context exceeds the declared model input budget",
          false,
        ),
      );
    }

    let outcome: ContextCompactionOutcome;
    try {
      outcome = await driver.compact(cloneJson(effect), {
        artifacts: this.#artifacts,
        cancellation: new AbortController().signal,
        signals: this.#signalsFor(effect.threadId),
      });
    } catch (error) {
      outcome = {
        error: driverError(
          "context_compaction_driver_exception",
          messageFrom(error),
          true,
        ),
        status: "indeterminate",
      };
    }

    let accounting: ModelAccounting;
    try {
      accounting = parseModelAccounting(
        outcome.accounting ?? EMPTY_MODEL_ACCOUNTING,
      );
    } catch (error) {
      return this.#compactionFailure(
        effect,
        "failed",
        driverError("model_accounting_invalid", messageFrom(error), false),
      );
    }
    if (outcome.status !== "succeeded") {
      return this.#compactionFailure(
        effect,
        outcome.status,
        outcome.error,
        accounting,
      );
    }

    try {
      const body = parseContinuityHandoffBody(
        outcome.value,
        effect.input.sourceEventIds,
      );
      if (
        effect.input.sourceMessages.length === 0 &&
        effect.input.sourceManifest.every(
          (source) => source.kind === "handoff",
        ) &&
        effect.input.previousHandoff !== null &&
        estimateContextTokens(body) >=
          estimateContextTokens(effect.input.previousHandoff.handoff.body)
      ) {
        throw new TypeError(
          "Continuity Handoff replacement does not reduce the previous Handoff",
        );
      }
      if (estimateContextTokens(body) > effect.input.targetTokens) {
        throw new TypeError(
          `Continuity Handoff exceeds its ${effect.input.targetTokens}-token target`,
        );
      }
      const handoff = createContinuityHandoff(effect.input, body);
      assertJsonValue(handoff, "Continuity Handoff");
      const bytes = new TextEncoder().encode(
        canonicalJson(handoff as unknown as JsonValue),
      );
      const artifact = {
        byteLength: bytes.byteLength,
        digest: await artifactDigest(bytes),
        mediaType: CONTINUITY_HANDOFF_MEDIA_TYPE,
      } as const;
      return {
        artifacts: [{ bytes, reference: artifact }],
        payload: {
          accounting,
          artifact,
          effectId: effect.id,
          handoff,
        },
        type: "context.compacted",
      };
    } catch (error) {
      return this.#compactionFailure(
        effect,
        "failed",
        driverError("context_handoff_invalid", messageFrom(error), false),
        accounting,
      );
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

  #compactionFailure(
    effect: ContextCompactEffect,
    disposition: "failed" | "indeterminate",
    error: DriverError,
    accounting: ModelAccounting = EMPTY_MODEL_ACCOUNTING,
  ): OutcomeProposal {
    return {
      payload: {
        accounting,
        disposition,
        effectId: effect.id,
        error,
      },
      type: "context.compaction_failed",
    };
  }
}
