import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveJixuReleaseChannel,
  resolveMacSigningPlan,
} from "./build-cli-artifact.ts";

test("JX-AC-051 GitHub Release reuses npm artifacts and rebuild channels fail closed", () => {
  assert.equal(resolveJixuReleaseChannel(undefined), "local");
  assert.equal(resolveJixuReleaseChannel("npm"), "npm");
  assert.throws(
    () => resolveJixuReleaseChannel("github-release"),
    /unsupported JIXU_RELEASE_CHANNEL "github-release"/u,
  );
  assert.throws(
    () => resolveJixuReleaseChannel("direct"),
    /unsupported JIXU_RELEASE_CHANNEL "direct"/u,
  );
  assert.deepEqual(
    resolveMacSigningPlan({
      releaseChannel: "npm",
    }),
    {
      identity: "-",
      signature: "ad-hoc",
      timestamp: false,
    },
  );
  assert.deepEqual(
    resolveMacSigningPlan({
      identity: "Developer ID Application: Jixu",
      releaseChannel: "npm",
    }),
    {
      identity: "Developer ID Application: Jixu",
      signature: "developer-id",
      timestamp: true,
    },
  );
  assert.deepEqual(
    resolveMacSigningPlan({
      identity: "Developer ID Application: Jixu",
      releaseChannel: "local",
    }),
    {
      identity: "Developer ID Application: Jixu",
      signature: "developer-id",
      timestamp: false,
    },
  );
});
