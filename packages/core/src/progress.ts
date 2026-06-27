import { SchemaValidationError } from "./errors.ts";
import { cloneFrozenJson, isJsonObject } from "./json.ts";
import type { JsonObject } from "./json.ts";

export const MODEL_PROGRESS_SIGNAL_TYPE = "model.progress";
export const PROGRESS_CONTROL_NAME = "jixu_progress_update";

export interface ProgressControlDescriptor {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: typeof PROGRESS_CONTROL_NAME;
}

export interface ProgressUpdate {
  readonly message: string;
}

const MAX_PROGRESS_LENGTH = 48;

export const PROGRESS_CONTROL: ProgressControlDescriptor = cloneFrozenJson({
  description:
    "Report at most one short user-visible phrase before meaningful Tool work or a material change of approach. Call this only in a response that also requests at least one ordinary Tool; never call it as the sole output or with a final answer. Use the user's language and describe only the next observable action. Never reveal hidden reasoning or use generic filler. This reports intent; it does not perform or authorize work.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      message: {
        maxLength: MAX_PROGRESS_LENGTH,
        minLength: 1,
        type: "string",
      },
    },
    required: ["message"],
    type: "object",
  },
  name: PROGRESS_CONTROL_NAME,
});

export function parseProgressUpdate(
  value: unknown,
  label = "Progress control",
): ProgressUpdate {
  if (!isJsonObject(value) || typeof value.message !== "string") {
    throw new SchemaValidationError(`${label} must contain a message string`);
  }
  const message = value.message.replace(/\s+/gu, " ").trim();
  if (message.length === 0 || message.length > MAX_PROGRESS_LENGTH) {
    throw new SchemaValidationError(
      `${label}.message must contain 1-${MAX_PROGRESS_LENGTH} characters`,
    );
  }
  return Object.freeze({ message });
}
