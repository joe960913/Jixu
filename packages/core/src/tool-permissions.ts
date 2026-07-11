import { SchemaValidationError } from "./errors.ts";

export type ToolPermissionEffect = "allow" | "ask" | "deny";

export interface ToolPermissionRule {
  readonly action: string;
  readonly effect: ToolPermissionEffect;
  readonly resource: string;
}

export interface ToolPermissionPolicy {
  readonly defaultEffect: ToolPermissionEffect;
  readonly rules: readonly ToolPermissionRule[];
}

export interface ToolAuthorizationRequest {
  readonly action: string;
  readonly resources: readonly string[];
}

export interface ToolResourcePermission {
  readonly effect: ToolPermissionEffect;
  readonly matchedRuleIndex: number | null;
  readonly resource: string;
}

export interface ToolPermissionResolution {
  readonly action: string;
  readonly effect: ToolPermissionEffect;
  readonly resources: readonly ToolResourcePermission[];
}

export const ALLOW_ALL_TOOL_POLICY: ToolPermissionPolicy = Object.freeze({
  defaultEffect: "allow",
  rules: Object.freeze([]),
});

function permissionEffect(value: unknown, label: string): ToolPermissionEffect {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  throw new SchemaValidationError(`${label} must be allow, ask, or deny`);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SchemaValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

export function defineToolPermissionPolicy(
  policy: ToolPermissionPolicy,
): ToolPermissionPolicy {
  if (policy === null || typeof policy !== "object") {
    throw new SchemaValidationError("Tool permission policy must be an object");
  }
  if (!Array.isArray(policy.rules)) {
    throw new SchemaValidationError("Tool permission policy rules must be an array");
  }
  return Object.freeze({
    defaultEffect: permissionEffect(
      policy.defaultEffect,
      "Tool permission policy defaultEffect",
    ),
    rules: Object.freeze(
      policy.rules.map((rule, index) => {
        if (rule === null || typeof rule !== "object") {
          throw new SchemaValidationError(
            `Tool permission policy rule ${index} must be an object`,
          );
        }
        return Object.freeze({
          action: nonEmpty(
            rule.action,
            `Tool permission policy rule ${index}.action`,
          ),
          effect: permissionEffect(
            rule.effect,
            `Tool permission policy rule ${index}.effect`,
          ),
          resource: nonEmpty(
            rule.resource,
            `Tool permission policy rule ${index}.resource`,
          ),
        });
      }),
    ),
  });
}

function wildcardExpression(pattern: string): RegExp {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") {
      expression += ".*";
    } else if (character === "?") {
      expression += ".";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

export function matchesToolPermissionPattern(
  pattern: string,
  value: string,
): boolean {
  return wildcardExpression(pattern).test(value);
}

function resolveResource(
  policy: ToolPermissionPolicy,
  action: string,
  resource: string,
): ToolResourcePermission {
  let effect = policy.defaultEffect;
  let matchedRuleIndex: number | null = null;
  policy.rules.forEach((rule, index) => {
    if (
      matchesToolPermissionPattern(rule.action, action) &&
      matchesToolPermissionPattern(rule.resource, resource)
    ) {
      effect = rule.effect;
      matchedRuleIndex = index;
    }
  });
  return Object.freeze({ effect, matchedRuleIndex, resource });
}

export function resolveToolPermission(
  policy: ToolPermissionPolicy,
  request: ToolAuthorizationRequest,
): ToolPermissionResolution {
  const parsedPolicy = defineToolPermissionPolicy(policy);
  const action = nonEmpty(request.action, "Tool authorization action");
  if (!Array.isArray(request.resources) || request.resources.length === 0) {
    throw new SchemaValidationError(
      "Tool authorization resources must contain at least one resource",
    );
  }
  const resources = Object.freeze(
    request.resources.map((resource, index) =>
      resolveResource(
        parsedPolicy,
        action,
        nonEmpty(resource, `Tool authorization resource ${index}`),
      ),
    ),
  );
  const effect = resources.some((resource) => resource.effect === "deny")
    ? "deny"
    : resources.some((resource) => resource.effect === "ask")
      ? "ask"
      : "allow";
  return Object.freeze({ action, effect, resources });
}
