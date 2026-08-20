import { SchemaValidationError } from "./errors.ts";
import { isJsonObject } from "./json.ts";

export const TOOL_OUTPUT_SIGNAL_TYPE = "tool.output.delta";
export const MAX_TOOL_OUTPUT_DELTA_LENGTH = 4_096;

export interface ToolOutputDelta {
  readonly delta: string;
  readonly effectId: string;
  readonly name: string;
  readonly stream: "stderr" | "stdout";
}

export function parseToolOutputDelta(
  value: unknown,
  label = "Tool output Signal",
): ToolOutputDelta {
  if (!isJsonObject(value)) {
    throw new SchemaValidationError(`${label} must be an object`);
  }
  const { delta, effectId, name, stream } = value;
  if (typeof effectId !== "string" || effectId.length === 0) {
    throw new SchemaValidationError(`${label}.effectId must be a non-empty string`);
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new SchemaValidationError(`${label}.name must be a non-empty string`);
  }
  if (stream !== "stdout" && stream !== "stderr") {
    throw new SchemaValidationError(`${label}.stream must be stdout or stderr`);
  }
  if (
    typeof delta !== "string" ||
    delta.length === 0 ||
    delta.length > MAX_TOOL_OUTPUT_DELTA_LENGTH
  ) {
    throw new SchemaValidationError(
      `${label}.delta must contain 1-${MAX_TOOL_OUTPUT_DELTA_LENGTH} characters`,
    );
  }
  return Object.freeze({ delta, effectId, name, stream });
}
