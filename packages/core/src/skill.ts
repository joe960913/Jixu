import { SchemaValidationError } from "./errors.ts";
import { cloneFrozenJson, isJsonObject, jsonDigest, jsonEquals } from "./json.ts";
import type { JsonObject } from "./json.ts";

export const SKILL_CONTROL_NAME = "jixu_activate_skill";
const MAX_SKILLS = 16;
const MAX_BODY_BYTES = 16_384;
const MAX_CATALOGUE_BYTES = 65_536;

export interface SkillConfig {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly instructions: string;
}

export interface SkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly byteLength: number;
  readonly digest: string;
}

export interface SkillDefinition {
  readonly descriptor: SkillDescriptor;
  readonly instructions: string;
}

export interface ActivatedSkill {
  readonly eventId: string;
  readonly sequence: number;
  readonly skill: SkillDefinition;
}

export interface SkillControlDescriptor {
  readonly name: typeof SKILL_CONTROL_NAME;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface SkillContext {
  readonly catalogue: readonly SkillDescriptor[];
  readonly active: readonly SkillDefinition[];
  readonly control: SkillControlDescriptor | null;
}

function boundedText(value: unknown, limit: number, label: string): string {
  if (
    typeof value !== "string" || value.trim().length === 0 || value.length > limit
  ) {
    throw new SchemaValidationError(`${label} must contain 1-${limit} characters`);
  }
  return value;
}

export function parseSkillDescriptor(value: unknown): SkillDescriptor {
  if (!isJsonObject(value)) {
    throw new SchemaValidationError("Skill descriptor must be an object");
  }
  const name = boundedText(value.name, 64, "Skill name");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new SchemaValidationError("Skill name must be a lowercase ASCII slug");
  }
  const descriptor = {
    name,
    description: boundedText(value.description, 512, "Skill description"),
    version: boundedText(value.version, 64, "Skill version"),
    byteLength: value.byteLength,
    digest: value.digest,
  };
  if (
    typeof descriptor.byteLength !== "number" ||
    !Number.isInteger(descriptor.byteLength) ||
    descriptor.byteLength < 1 || descriptor.byteLength > MAX_BODY_BYTES ||
    typeof descriptor.digest !== "string" ||
    !/^fnv1a32:[a-f0-9]{8}$/u.test(descriptor.digest) ||
    !jsonEquals(value, descriptor)
  ) {
    throw new SchemaValidationError("Skill descriptor is invalid");
  }
  return descriptor as SkillDescriptor;
}

export function defineSkill(config: SkillConfig): SkillDefinition {
  const instructions = boundedText(
    config.instructions, MAX_BODY_BYTES, "Skill instructions",
  );
  const descriptor = parseSkillDescriptor({
    name: config.name,
    description: config.description,
    version: config.version,
    byteLength: new TextEncoder().encode(instructions).byteLength,
    digest: jsonDigest(instructions),
  });
  return cloneFrozenJson({ descriptor, instructions });
}

export function parseSkillDefinition(value: unknown): SkillDefinition {
  if (!isJsonObject(value)) {
    throw new SchemaValidationError("Skill must be an object");
  }
  const descriptor = parseSkillDescriptor(value.descriptor);
  const skill = defineSkill({
    ...descriptor,
    instructions: boundedText(value.instructions, MAX_BODY_BYTES, "Skill instructions"),
  });
  if (!jsonEquals(value, skill)) {
    throw new SchemaValidationError("Skill body does not match its descriptor");
  }
  return skill;
}

export function parseSkillCatalogue(value: unknown): readonly SkillDescriptor[] {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) {
    throw new SchemaValidationError(
      `Skill catalogue must contain at most ${MAX_SKILLS} entries`,
    );
  }
  const catalogue = value.map(parseSkillDescriptor);
  if (
    new Set(catalogue.map((skill) => skill.name)).size !== catalogue.length ||
    catalogue.reduce((total, skill) => total + skill.byteLength, 0) > MAX_CATALOGUE_BYTES
  ) {
    throw new SchemaValidationError(
      "Skill catalogue contains duplicate names or exceeds 65536 body bytes",
    );
  }
  return catalogue;
}

export function createSkillContext(
  catalogue: readonly SkillDescriptor[],
  active: readonly SkillDefinition[],
  allowActivation: boolean,
): SkillContext {
  const names = catalogue
    .filter((skill) => !active.some((item) => item.descriptor.name === skill.name))
    .map((skill) => skill.name);
  return {
    catalogue,
    active,
    control: !allowActivation || names.length === 0 ? null : {
      name: SKILL_CONTROL_NAME,
      description: "Load one relevant inactive Skill before using its instructions. Call this control alone, without ordinary Tool calls or Plan changes. The accepted body will be supplied in the next request. It grants no capabilities or permissions.",
      inputSchema: {
        additionalProperties: false,
        properties: { name: { type: "string", enum: names } },
        required: ["name"],
        type: "object",
      },
    },
  };
}

export function parseSkillContext(value: unknown): SkillContext {
  if (!isJsonObject(value) || !Array.isArray(value.active)) {
    throw new SchemaValidationError("Skill Context is invalid");
  }
  const catalogue = parseSkillCatalogue(value.catalogue);
  const active = value.active.map(parseSkillDefinition);
  if (
    new Set(active.map((skill) => skill.descriptor.name)).size !== active.length ||
    active.some((skill) => !catalogue.some((entry) => jsonEquals(entry, skill.descriptor)))
  ) {
    throw new SchemaValidationError("Active Skill does not match catalogue");
  }
  const parsed = createSkillContext(catalogue, active, value.control !== null);
  if (!jsonEquals(value, parsed)) {
    throw new SchemaValidationError("Skill Context control is invalid");
  }
  return parsed;
}

export function assertSkillActivation(
  name: string,
  skill: SkillDefinition,
  context: SkillContext | undefined,
): void {
  if (
    context?.control === null || context === undefined ||
    context.active.some((active) => active.descriptor.name === name) ||
    !context.catalogue.some((entry) =>
      entry.name === name && jsonEquals(entry, skill.descriptor),
    )
  ) {
    throw new SchemaValidationError(
      "Skill activation is unavailable or does not match the inactive catalogue",
    );
  }
  parseSkillDefinition(skill);
}
