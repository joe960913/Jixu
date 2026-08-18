export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

function isJsonValueInner(value: unknown, seen: Set<object>): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const isJsonArray = value.every((item) => isJsonValueInner(item, seen));
    seen.delete(value);
    return isJsonArray;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return false;
  }

  const isJsonRecord = Object.values(value).every((item) =>
    isJsonValueInner(item, seen),
  );
  seen.delete(value);
  return isJsonRecord;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInner(value, new Set<object>());
}

export function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isJsonValue(value)
  );
}

export function assertJsonValue(
  value: unknown,
  label = "value",
): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError(`${label} must be finite, acyclic JSON data`);
  }
}

export function cloneJson<T>(value: T): T {
  assertJsonValue(value);
  return structuredClone(value);
}

function freezeJsonInner(value: JsonValue): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const child of Object.values(value)) {
    freezeJsonInner(child);
  }
  Object.freeze(value);
}

export function cloneFrozenJson<T>(value: T): T {
  const cloned = cloneJson(value);
  freezeJsonInner(cloned as JsonValue);
  return cloned;
}
