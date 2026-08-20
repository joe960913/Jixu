import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_JIXU_TOOL_SETTINGS,
  JixuConfigStore,
} from "../src/config.ts";

test("JX-AC-047 protocol, Tool settings, and credentials persist separately in schema v4", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-"));
  const directory = join(parent, ".jixu");
  const store = new JixuConfigStore(directory);
  try {
    assert.deepEqual(await store.load(), { tools: DEFAULT_JIXU_TOOL_SETTINGS });
    await store.saveConnection({
      api: "openai-chat-completions",
      apiKey: "first-secret-fixture",
      baseUrl: "https://api.first.example/v1/",
      model: "first-model",
      tools: DEFAULT_JIXU_TOOL_SETTINGS,
    });
    await store.saveConnection({
      api: "anthropic-messages",
      apiKey: "active-secret-fixture",
      baseUrl: "https://api.anthropic.example",
      model: "claude-model",
      tools: {
        enabled: ["read", "bash"],
        fileScope: "workspace",
        permissions: {
          profile: "balanced",
          rules: [{ action: "bash", effect: "deny", resource: "*" }],
        },
      },
    });

    assert.deepEqual(await store.load(), {
      api: "anthropic-messages",
      apiKey: "active-secret-fixture",
      baseUrl: "https://api.anthropic.example",
      model: "claude-model",
      tools: {
        enabled: ["read", "bash"],
        fileScope: "workspace",
        permissions: {
          profile: "balanced",
          rules: [{ action: "bash", effect: "deny", resource: "*" }],
        },
      },
    });

    const settings = await readFile(store.settingsPath, "utf8");
    const auth = await readFile(store.authPath, "utf8");
    assert.doesNotMatch(settings, /secret-fixture/);
    assert.match(settings, /anthropic-messages/);
    assert.match(settings, /"version": 4/);
    assert.match(settings, /"effect": "deny"/);
    assert.match(auth, /active-secret-fixture/);
    assert.match(auth, /"version": 3/);
    assert.doesNotMatch(auth, /first-secret-fixture/);
    assert.deepEqual(
      (await readdir(directory)).sort(),
      ["auth.json", "settings.json"],
    );

    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(store.authPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("JX-PROV-001 JX-TUI-002C pre-release configuration schemas v1 and v2 fail closed", async () => {
  for (const version of [1, 2]) {
    const parent = await mkdtemp(join(tmpdir(), `jixu-config-v${version}-`));
    const store = new JixuConfigStore(join(parent, ".jixu"));
    try {
      await store.load();
      await writeFile(
        store.settingsPath,
        JSON.stringify({
          connection: {
            apiFormat: "chat-completions",
            baseUrl: "https://api.example/v1",
            model: "legacy-model",
          },
          version,
        }),
        "utf8",
      );
      await assert.rejects(
        store.load(),
        /settings\.json must use Jixu settings schema version 3 or 4/,
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  }
});

test("JX-TUI-002D malformed auth fails closed without leaking its contents", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-invalid-"));
  const store = new JixuConfigStore(join(parent, ".jixu"));
  try {
    await store.load();
    await writeFile(store.authPath, "not-json-with-secret-fixture", "utf8");
    await assert.rejects(
      store.load(),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /Could not load auth\.json/);
        assert.doesNotMatch(error.message, /secret-fixture/);
        return true;
      },
    );
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("JX-PROV-001 JX-TUI-002C unknown protocol fails closed", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-api-"));
  const store = new JixuConfigStore(join(parent, ".jixu"));
  try {
    await store.load();
    await assert.rejects(
      store.saveConnection({
        api: "responses" as never,
        apiKey: "fixture",
        baseUrl: "https://api.example/v1",
        model: "model",
        tools: DEFAULT_JIXU_TOOL_SETTINGS,
      }),
      /LLM API is invalid/,
    );
    await writeFile(
      store.settingsPath,
      JSON.stringify({
        connection: {
          api: "responses",
          baseUrl: "https://api.example/v1",
          model: "model",
        },
        version: 3,
      }),
      "utf8",
    );
    await assert.rejects(store.load(), /settings\.json api is invalid/);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("JX-AC-047 schema v3 migrates in place without a backup and preserves legacy reach", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-v3-"));
  const directory = join(parent, ".jixu");
  const store = new JixuConfigStore(directory);
  try {
    await store.load();
    await writeFile(
      store.settingsPath,
      JSON.stringify({
        connection: {
          api: "openai-chat-completions",
          baseUrl: "https://api.example/v1",
          model: "legacy-model",
        },
        version: 3,
      }),
      "utf8",
    );

    const loaded = await store.load();
    assert.deepEqual(loaded.tools, {
      enabled: ["read", "write", "edit", "bash"],
      fileScope: "process",
      permissions: { profile: "unrestricted", rules: [] },
    });
    assert.match(await readFile(store.settingsPath, "utf8"), /"version": 4/);
    assert.deepEqual(await readdir(directory), ["settings.json"]);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("JX-AC-047 unknown Tools and malformed permission rules fail closed", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-tools-"));
  const store = new JixuConfigStore(join(parent, ".jixu"));
  try {
    await store.load();
    const base = {
      connection: {
        api: "openai-chat-completions",
        baseUrl: "https://api.example/v1",
        model: "model",
      },
      version: 4,
    };
    await writeFile(
      store.settingsPath,
      JSON.stringify({
        ...base,
        tools: {
          enabled: ["read", "network-search"],
          fileScope: "workspace",
          permissions: { profile: "balanced", rules: [] },
        },
      }),
      "utf8",
    );
    await assert.rejects(store.load(), /not a registered first-party Tool/);

    await writeFile(
      store.settingsPath,
      JSON.stringify({
        ...base,
        tools: {
          enabled: ["read"],
          fileScope: "workspace",
          permissions: {
            profile: "balanced",
            rules: [{ action: "read", effect: "sometimes", resource: "*" }],
          },
        },
      }),
      "utf8",
    );
    await assert.rejects(store.load(), /effect must be allow, ask, or deny/);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
