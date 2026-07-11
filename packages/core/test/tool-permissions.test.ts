import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defineToolPermissionPolicy,
  matchesToolPermissionPattern,
  resolveToolPermission,
} from "../src/index.ts";

test("JX-AC-047 ordered Tool permission rules use last match and deny multi-resource calls", () => {
  const policy = defineToolPermissionPolicy({
    defaultEffect: "ask",
    rules: [
      { action: "read", effect: "allow", resource: "workspace/**" },
      { action: "read", effect: "deny", resource: "workspace/secrets/*" },
      { action: "read", effect: "allow", resource: "workspace/secrets/example.env" },
    ],
  });

  assert.equal(matchesToolPermissionPattern("read", "read"), true);
  assert.equal(matchesToolPermissionPattern("workspace/**", "workspace/a/b.ts"), true);
  assert.equal(matchesToolPermissionPattern("workspace/*.ts", "workspace/a.ts"), true);
  assert.equal(matchesToolPermissionPattern("workspace/*.ts", "workspace/a.js"), false);

  assert.equal(
    resolveToolPermission(policy, {
      action: "read",
      resources: ["workspace/secrets/example.env"],
    }).effect,
    "allow",
  );
  const mixed = resolveToolPermission(policy, {
    action: "read",
    resources: ["workspace/source.ts", "workspace/secrets/production.env"],
  });
  assert.equal(mixed.effect, "deny");
  assert.deepEqual(
    mixed.resources.map((resource) => resource.effect),
    ["allow", "deny"],
  );
});

test("JX-AC-047 malformed Tool permission policies fail closed", () => {
  assert.throws(
    () =>
      defineToolPermissionPolicy({
        defaultEffect: "allow",
        rules: [{ action: "", effect: "allow", resource: "*" }],
      }),
    /action must be a non-empty string/,
  );
  assert.throws(
    () =>
      resolveToolPermission(
        { defaultEffect: "allow", rules: [] },
        { action: "read", resources: [] },
      ),
    /must contain at least one resource/,
  );
});
