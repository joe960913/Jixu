import { defineSkill, type SkillConfig, type SkillDefinition } from "jixu-core";

export interface JixuSkillSettings extends SkillConfig {
  readonly enabled: boolean;
}

/** Validates local drafts, including disabled entries, before they can be saved. */
export function parseJixuSkills(value: unknown): readonly JixuSkillSettings[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new TypeError("Skills must contain at most 16 entries.");
  }
  const names = new Set<string>();
  let bytes = 0;
  return Object.freeze(value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError("Each Skill must be an object.");
    }
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(",") !== "description,enabled,instructions,name,version" ||
      typeof item.enabled !== "boolean" ||
      typeof item.name !== "string" || typeof item.description !== "string" ||
      typeof item.version !== "string" || typeof item.instructions !== "string"
    ) {
      throw new TypeError("Each Skill requires name, description, version, instructions and enabled.");
    }
    const skill = defineSkill({
      name: item.name, description: item.description,
      version: item.version, instructions: item.instructions,
    });
    if (names.has(skill.descriptor.name)) {
      throw new TypeError("Skill names must be unique.");
    }
    names.add(skill.descriptor.name);
    bytes += skill.descriptor.byteLength;
    if (bytes > 65_536) throw new TypeError("Skills exceed 65536 body bytes in total.");
    return Object.freeze({
      name: skill.descriptor.name, description: skill.descriptor.description,
      version: skill.descriptor.version, instructions: skill.instructions,
      enabled: item.enabled,
    });
  }));
}

/** The CLI and consumers share this conversion; core validates the Agent again. */
export function jixuSkills(
  settings: readonly JixuSkillSettings[] = [],
): readonly SkillDefinition[] {
  return Object.freeze(parseJixuSkills(settings)
    .filter(item => item.enabled)
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .map(defineSkill));
}
