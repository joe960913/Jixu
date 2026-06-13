import type {
  AgentSnapshot,
  ModelRef,
  ToolDescriptor,
  ToolIdempotency,
} from "./domain.ts";
import { SchemaValidationError } from "./errors.ts";
import { cloneFrozenJson } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { SignalSink } from "./ports.ts";

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
  readonly runId: string;
  readonly signals: SignalSink;
}

export interface Tool<TInput extends JsonValue, TOutput extends JsonValue> {
  readonly descriptor: ToolDescriptor;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
  parseInput(value: unknown): TInput;
  parseOutput(value: unknown): TOutput;
}

export interface ToolConfig<TInput extends JsonValue, TOutput extends JsonValue> {
  readonly description: string;
  readonly execute: (
    input: TInput,
    context: ToolExecutionContext,
  ) => Promise<TOutput> | TOutput;
  readonly idempotency?: ToolIdempotency;
  readonly input: Schema<TInput>;
  readonly inputSchemaVersion?: number;
  readonly name: string;
  readonly output: Schema<TOutput>;
  readonly outputSchemaVersion?: number;
}

export function defineTool<
  TInput extends JsonValue,
  TOutput extends JsonValue,
>(config: ToolConfig<TInput, TOutput>): Tool<TInput, TOutput> {
  const descriptor: ToolDescriptor = Object.freeze({
    description: config.description,
    idempotency: config.idempotency ?? "none",
    inputSchema: config.input.jsonSchema,
    inputSchemaVersion: config.inputSchemaVersion ?? 1,
    name: config.name,
    outputSchema: config.output.jsonSchema,
    outputSchemaVersion: config.outputSchemaVersion ?? 1,
  });

  return Object.freeze({
    descriptor,
    execute: async (input: TInput, context: ToolExecutionContext) =>
      config.execute(input, context),
    parseInput: (value: unknown) => config.input.parse(value),
    parseOutput: (value: unknown) => config.output.parse(value),
  });
}

export type ExecutableTool = Tool<JsonValue, JsonValue>;

export interface AgentDefinition {
  readonly snapshot: AgentSnapshot;
  readonly tools: readonly ExecutableTool[];
}

export interface AgentConfig {
  readonly instructions: string;
  readonly model: ModelRef;
  readonly tools?: readonly ExecutableTool[];
}

export function defineAgent(config: AgentConfig): AgentDefinition {
  const tools = new Map<string, ExecutableTool>();
  for (const tool of config.tools ?? []) {
    if (tools.has(tool.descriptor.name)) {
      throw new SchemaValidationError(
        `Tool name ${tool.descriptor.name} is duplicated`,
      );
    }
    tools.set(tool.descriptor.name, tool);
  }

  const snapshot: AgentSnapshot = Object.freeze({
    instructions: config.instructions,
    model: Object.freeze({ ...config.model }),
    tools: Object.freeze([...tools.values()].map((tool) => tool.descriptor)),
  });

  return Object.freeze({
    snapshot,
    tools: Object.freeze([...tools.values()]),
  });
}
