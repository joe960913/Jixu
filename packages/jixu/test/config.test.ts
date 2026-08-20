import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_JIXU_TOOL_SETTINGS,
  JixuConfigStore,
} from "../src/config.ts";

test("JX-AC-048 model, Tool, and Jina BYOK settings persist in one schema v5 file", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-"));
  const directory = join(parent, ".jixu");
  const store = new JixuConfigStore(directory);
  try {
    assert.deepEqual(await store.load(), { tools: DEFAULT_JIXU_TOOL_SETTINGS });
    await store.saveConnection({
      api: "anthropic-messages",
      apiKey: "model-secret-fixture",
      baseUrl: "https://api.anthropic.example",
      model: "claude-model",
      tools: {
        enabled: ["read", "bash", "web_search"],
        fileScope: "workspace",
        permissions: {
          profile: "balanced",
          rules: [{ action: "bash", effect: "deny", resource: "*" }],
        },
        webSearch: { apiKey: "jina-secret-fixture", provider: "jina" },
      },
    });

    assert.deepEqual(await store.load(), {
      api: "anthropic-messages",
      apiKey: "model-secret-fixture",
      baseUrl: "https://api.anthropic.example",
      model: "claude-model",
      tools: {
        enabled: ["read", "bash", "web_search"],
        fileScope: "workspace",
        permissions: {
          profile: "balanced",
          rules: [{ action: "bash", effect: "deny", resource: "*" }],
        },
        webSearch: { apiKey: "jina-secret-fixture", provider: "jina" },
      },
    });

    const settings = await readFile(store.settingsPath, "utf8");
    assert.match(settings, /model-secret-fixture/);
    assert.match(settings, /jina-secret-fixture/);
    assert.match(settings, /"version": 5/);
    assert.match(settings, /"webSearch"/);
    assert.match(settings, /"effect": "deny"/);
    assert.deepEqual(await readdir(directory), ["settings.json"]);

    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(store.settingsPath)).mode & 0o777, 0o600);
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
      await writeFile(store.settingsPath, JSON.stringify({ connection: {}, version }), "utf8");
      await assert.rejects(
        store.load(),
        /settings\.json must use Jixu settings schema version 3, 4, or 5/,
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  }
});

test("JX-SEC-008 malformed settings fail closed without leaking their contents", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-invalid-"));
  const store = new JixuConfigStore(join(parent, ".jixu"));
  try {
    await store.load();
    await writeFile(store.settingsPath, "not-json-with-secret-fixture", "utf8");
    await assert.rejects(
      store.load(),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /Could not load settings\.json/);
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
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("JX-AC-048 schema v3 and legacy auth migrate in place without a backup", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-v3-"));
  const directory = join(parent, ".jixu");
  const store = new JixuConfigStore(directory);
  const legacyAuthPath = join(directory, "auth.json");
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
    await writeFile(
      legacyAuthPath,
      JSON.stringify({
        connection: { key: "legacy-model-secret", type: "api_key" },
        version: 3,
      }),
      "utf8",
    );

    const loaded = await store.load();
    assert.equal(loaded.apiKey, "legacy-model-secret");
    assert.deepEqual(loaded.tools, {
      enabled: ["read", "write", "edit", "bash"],
      fileScope: "process",
      permissions: { profile: "unrestricted", rules: [] },
      webSearch: { provider: "jina" },
    });
    const settings = await readFile(store.settingsPath, "utf8");
    assert.match(settings, /"version": 5/);
    assert.match(settings, /legacy-model-secret/);
    assert.deepEqual(await readdir(directory), ["settings.json"]);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("JX-AC-047 JX-AC-048 schema v4 preserves Tool policy while consolidating auth", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-v4-"));
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
          model: "model",
        },
        tools: {
          enabled: ["read", "bash"],
          fileScope: "workspace",
          permissions: {
            profile: "balanced",
            rules: [{ action: "bash", effect: "deny", resource: "*" }],
          },
        },
        version: 4,
      }),
      "utf8",
    );
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify({
        connection: { key: "model-secret", type: "api_key" },
        version: 3,
      }),
      "utf8",
    );

    assert.deepEqual(await store.load(), {
      api: "openai-chat-completions",
      apiKey: "model-secret",
      baseUrl: "https://api.example/v1",
      model: "model",
      tools: {
        enabled: ["read", "bash"],
        fileScope: "workspace",
        permissions: {
          profile: "balanced",
          rules: [{ action: "bash", effect: "deny", resource: "*" }],
        },
        webSearch: { provider: "jina" },
      },
    });
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
        apiKey: "fixture",
        baseUrl: "https://api.example/v1",
        model: "model",
      },
      version: 5,
    };
    await writeFile(
      store.settingsPath,
      JSON.stringify({
        ...base,
        tools: {
          enabled: ["read", "network-search"],
          fileScope: "workspace",
          permissions: { profile: "balanced", rules: [] },
          webSearch: { provider: "jina" },
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
          webSearch: { provider: "jina" },
        },
      }),
      "utf8",
    );
    await assert.rejects(store.load(), /effect must be allow, ask, or deny/);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
