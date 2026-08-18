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

export function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => jsonEquals(item, right[index]));
  }
  if (!isJsonObject(left) || !isJsonObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!jsonEquals(leftKeys, rightKeys)) {
    return false;
  }
  return leftKeys.every((key) => jsonEquals(left[key], right[key]));
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (!isJsonObject(value)) {
    throw new TypeError("Canonical JSON input must be JSON data");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

export function jsonDigest(value: unknown): string {
  assertJsonValue(value);
  const source = canonicalJson(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
