import type {
  AgentSnapshot,
  ModelRef,
  ToolDescriptor,
  ToolIdempotency,
} from "./domain.ts";
import { defineContextPolicy } from "./context-policy.ts";
import type { ContextPolicyConfig } from "./context-policy.ts";
import { defineModelCapabilityProfile } from "./model-capabilities.ts";
import type { ModelCapabilityProfileConfig } from "./model-capabilities.ts";
import { SchemaValidationError } from "./errors.ts";
import { cloneFrozenJson } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { SignalSink } from "./ports.ts";
import { PLAN_CONTROL_NAME } from "./plan.ts";
import { PROGRESS_CONTROL_NAME } from "./progress.ts";
import type { ToolAuthorizationRequest } from "./tool-permissions.ts";

export type ToolOrigin = "application" | "builtin" | "extension" | "mcp";
export type ToolRisk = "execute" | "network" | "read" | "write";

export interface ToolMetadata {
  readonly origin: ToolOrigin;
  readonly risk: ToolRisk;
}

export interface ToolAuthorizationConfig<TInput extends JsonValue> {
  readonly action: string;
  readonly resources: (input: TInput) => readonly string[];
}

export interface Schema<TValue extends JsonValue> {
  readonly jsonSchema: JsonObject;
  parse(value: unknown): TValue;
}

export interface SchemaConfig<TValue extends JsonValue> {
  readonly jsonSchema: JsonObject;
  readonly parse: (value: unknown) => TValue;
}

export function defineSchema<TValue extends JsonValue>(
  config: SchemaConfig<TValue>,
): Schema<TValue> {
  return Object.freeze({
    jsonSchema: cloneFrozenJson(config.jsonSchema),
    parse: config.parse,
  });
}

export interface ToolExecutionContext {
  readonly cancellation: AbortSignal;
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly threadId: string;
  readonly signals: SignalSink;
}

export interface Tool<TInput extends JsonValue, TOutput extends JsonValue> {
  readonly descriptor: ToolDescriptor;
  readonly metadata: ToolMetadata;
  authorize(input: TInput): ToolAuthorizationRequest;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
  parseInput(value: unknown): TInput;
  parseOutput(value: unknown): TOutput;
}

export interface ToolConfig<TInput extends JsonValue, TOutput extends JsonValue> {
  readonly authorization?: ToolAuthorizationConfig<TInput>;
  readonly description: string;
  readonly execute: (
    input: TInput,
    context: ToolExecutionContext,
  ) => Promise<TOutput> | TOutput;
  readonly idempotency?: ToolIdempotency;
  readonly input: Schema<TInput>;
  readonly inputSchemaVersion?: number;
  readonly name: string;
  readonly origin?: ToolOrigin;
  readonly output: Schema<TOutput>;
  readonly outputSchemaVersion?: number;
  readonly risk?: ToolRisk;
}

export function defineTool<
  TInput extends JsonValue,
  TOutput extends JsonValue,
>(config: ToolConfig<TInput, TOutput>): Tool<TInput, TOutput> {
  const authorizationAction = config.authorization?.action ?? config.name;
  if (authorizationAction.trim().length === 0) {
    throw new SchemaValidationError("Tool authorization action must not be empty");
  }
  const descriptor: ToolDescriptor = Object.freeze({
    description: config.description,
    idempotency: config.idempotency ?? "none",
    inputSchema: config.input.jsonSchema,
    inputSchemaVersion: config.inputSchemaVersion ?? 1,
    name: config.name,
    outputSchema: config.output.jsonSchema,
    outputSchemaVersion: config.outputSchemaVersion ?? 1,
  });
  const metadata: ToolMetadata = Object.freeze({
    origin: config.origin ?? "application",
    risk: config.risk ?? "execute",
  });

  return Object.freeze({
    authorize: (input: TInput): ToolAuthorizationRequest => {
      const resources = config.authorization?.resources(input) ?? ["*"];
      if (!Array.isArray(resources) || resources.length === 0) {
        throw new SchemaValidationError(
          `Tool ${config.name} authorization must contain at least one resource`,
        );
      }
      return Object.freeze({
        action: authorizationAction,
        resources: Object.freeze(
          resources.map((resource, index) => {
            if (typeof resource !== "string" || resource.trim().length === 0) {
              throw new SchemaValidationError(
                `Tool ${config.name} authorization resource ${index} must not be empty`,
              );
            }
            return resource;
          }),
        ),
      });
    },
    descriptor,
    execute: async (input: TInput, context: ToolExecutionContext) =>
      config.execute(input, context),
    parseInput: (value: unknown) => config.input.parse(value),
    parseOutput: (value: unknown) => config.output.parse(value),
    metadata,
  });
}

export type ExecutableTool = Tool<JsonValue, JsonValue>;

export interface AgentDefinition {
  readonly snapshot: AgentSnapshot;
  readonly tools: readonly ExecutableTool[];
}

export interface AgentConfig {
  readonly context?: ContextPolicyConfig;
  readonly instructions: string;
  readonly model: ModelRef;
  readonly modelCapabilities: ModelCapabilityProfileConfig;
  readonly tools?: readonly ExecutableTool[];
}

export function defineAgent(config: AgentConfig): AgentDefinition {
  const tools = new Map<string, ExecutableTool>();
  for (const tool of config.tools ?? []) {
    if (
      tool.descriptor.name === PLAN_CONTROL_NAME ||
      tool.descriptor.name === PROGRESS_CONTROL_NAME
    ) {
      throw new SchemaValidationError(
        `Tool name ${tool.descriptor.name} is reserved for Jixu model control`,
      );
    }
    if (tools.has(tool.descriptor.name)) {
      throw new SchemaValidationError(
        `Tool name ${tool.descriptor.name} is duplicated`,
      );
    }
    tools.set(tool.descriptor.name, tool);
  }

  if (config.context?.contextWindowTokens !== undefined) {
    throw new SchemaValidationError(
      "Agent contextWindowTokens belongs in modelCapabilities, not Context Policy",
    );
  }
  const modelCapabilities = defineModelCapabilityProfile(
    config.modelCapabilities,
  );
  if (modelCapabilities.source.kind === "legacy") {
    throw new SchemaValidationError(
      "Legacy Model Capability Profiles are reserved for historical Event recovery",
    );
  }
  const snapshot: AgentSnapshot = Object.freeze({
    contextPolicy: defineContextPolicy(config.context, modelCapabilities),
    instructions: config.instructions,
    model: Object.freeze({ ...config.model }),
    modelCapabilities,
    tools: Object.freeze([...tools.values()].map((tool) => tool.descriptor)),
  });

  return Object.freeze({
    snapshot,
    tools: Object.freeze([...tools.values()]),
  });
}
