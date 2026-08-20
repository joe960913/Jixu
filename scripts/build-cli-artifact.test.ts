import assert from "node:assert/strict";
import test from "node:test";

import { resolveMacSigningPlan } from "./build-cli-artifact.ts";

test("JX-AC-051 npm pre-releases allow ad-hoc macOS signing without weakening stable releases", () => {
  assert.deepEqual(
    resolveMacSigningPlan({
      publicRelease: true,
      version: "0.1.0-beta.0",
    }),
    {
      identity: "-",
      signature: "ad-hoc",
      timestamp: false,
    },
  );
  assert.throws(
    () =>
      resolveMacSigningPlan({
        publicRelease: true,
        version: "1.0.0",
      }),
    /stable public macOS releases require JIXU_CODESIGN_IDENTITY/u,
  );
  assert.deepEqual(
    resolveMacSigningPlan({
      identity: "Developer ID Application: Jixu",
      publicRelease: true,
      version: "1.0.0",
    }),
    {
      identity: "Developer ID Application: Jixu",
      signature: "developer-id",
      timestamp: true,
    },
  );
});
