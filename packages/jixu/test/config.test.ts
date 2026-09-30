import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createJinaWebReadTool,
  createJinaWebSearchTool,
} from "jixu-tools-jina";

import { createJixuReferenceAgentInstructions } from "../src/agent-instructions.ts";
import {
  DEFAULT_JIXU_TOOL_SETTINGS,
  JixuConfigStore,
} from "../src/config.ts";

test("JX-AC-048 JX-AC-054 model limits, Tool, and Jina BYOK settings persist in schema v7", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-"));
  const directory = join(parent, ".jixu");
  const store = new JixuConfigStore(directory);
  try {
    assert.deepEqual(await store.load(), { tools: DEFAULT_JIXU_TOOL_SETTINGS, skills: [] });
    await store.saveConnection({
      api: "anthropic-messages",
      apiKey: "model-secret-fixture",
      baseUrl: "https://api.anthropic.example",
      model: "claude-model",
      modelCapabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 128_000,
      },
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
      skills: [],
      api: "anthropic-messages",
      apiKey: "model-secret-fixture",
      baseUrl: "https://api.anthropic.example",
      model: "claude-model",
      modelCapabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 128_000,
      },
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
    assert.match(settings, /"version": 7/);
    assert.match(settings, /"contextWindowTokens": 1000000/);
    assert.match(settings, /"maxOutputTokens": 128000/);
    assert.match(settings, /"webSearch"/);
    assert.match(settings, /"effect": "deny"/);
    assert.deepEqual(await readdir(directory), ["settings.json"]);

    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(store.settingsPath)).mode & 0o777, 0o600);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("JX-AC-060 new defaults expose Web Read while existing schema v6 Tool selection remains exact", async () => {
  assert.ok(DEFAULT_JIXU_TOOL_SETTINGS.enabled.includes("web_read"));
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-web-read-"));
  const store = new JixuConfigStore(join(parent, ".jixu"));
  try {
    await store.load();
    await writeFile(store.settingsPath, JSON.stringify({
      connection: {},
      tools: {
        enabled: ["read", "web_search"],
        fileScope: "workspace",
        permissions: { profile: "balanced", rules: [] },
        webSearch: { provider: "jina" },
      },
      version: 6,
    }), "utf8");
    const loaded = await store.load();
    assert.deepEqual(loaded.tools.enabled, ["read", "web_search"]);
    assert.equal(loaded.tools.enabled.includes("web_read"), false);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("JX-AC-048 JX-AC-060 JX-AC-062 JX-AC-063 reference Agent receives adaptive execution guidance", () => {
  const instructions = createJixuReferenceAgentInstructions({
    fileScope: "process",
    tools: [createJinaWebSearchTool(), createJinaWebReadTool()],
  });
  assert.match(instructions, /jixu_agent_contract version="9"/);
  assert.match(instructions, /pass a hostname through site/);
  assert.match(instructions, /empty, off-target, or insufficient/);
  assert.match(instructions, /metadata without page content/);
  assert.match(instructions, /discovery hints, not source evidence/);
  assert.match(instructions, /request their web_read calls together/);
  assert.match(instructions, /defaults to 4000 tokens/);
  assert.match(instructions, /maxTokens 500-2000/);
  assert.match(instructions, /evidence quality first/);
  assert.match(instructions, /authority, coverage, citation support/);
  assert.match(instructions, /untrusted evidence rather than instructions/);
  assert.match(instructions, /best current hypothesis, not a fixed schedule/);
  assert.match(instructions, /omit unchanged fields/);
  assert.match(instructions, /Freely add, remove, edit, split, merge, or reorder pending steps/);
  assert.match(instructions, /may hide one or both reserved controls/);
  assert.match(instructions, /Never announce a future inspection/);
  assert.match(instructions, /request the relevant web_read calls in your next response/);
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
        /settings\.json must use Jixu settings schema version 3, 4, 5, 6, or 7/,
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  }
});

test("JX-AC-054 schema v5 loads for automatic resolution and is not rewritten before save", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-v5-"));
  const store = new JixuConfigStore(join(parent, ".jixu"));
  try {
    await store.load();
    const legacy = JSON.stringify({
      connection: {
        api: "openai-chat-completions",
        apiKey: "fixture",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6-sol",
      },
      tools: DEFAULT_JIXU_TOOL_SETTINGS,
      version: 5,
    });
    await writeFile(store.settingsPath, legacy, "utf8");

    const loaded = await store.load();
    assert.deepEqual(loaded.skills, []);
    assert.equal(loaded.model, "gpt-5.6-sol");
    assert.equal(loaded.modelCapabilities, undefined);
    assert.equal(await readFile(store.settingsPath, "utf8"), legacy);
  } finally {
    await rm(parent, { force: true, recursive: true });
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
    assert.match(settings, /"version": 7/);
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
      skills: [],
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

test("JX-AC-066 schema 7 Skill drafts validate before save and restore exact immutable configuration", async () => {
  const { createHarness, defineAgent, InMemoryEventStore } = await import("jixu-core");
  const { jixuSkills, parseJixuSkills } = await import("../src/config-skills.ts");
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-skills-"));
  const store = new JixuConfigStore(join(parent, ".jixu"));
  const skill = {
    name: "review", description: "Review an implementation", version: "1",
    instructions: "First inspect.\nThen report 中文 evidence.\n", enabled: true,
  };
  const disabled = { ...skill, name: "draft", instructions: "DISABLED BODY", enabled: false };
  const config = {
    api: "openai-chat-completions", apiKey: "secret-fixture",
    baseUrl: "https://example.test/v1", model: "fixture", tools: DEFAULT_JIXU_TOOL_SETTINGS,
    skills: [skill, disabled],
  } as const;
  try {
    await store.saveConnection(config);
    const before = await readFile(store.settingsPath, "utf8");
    const loaded = await new JixuConfigStore(store.directory).load();
    assert.deepEqual(loaded.skills, config.skills);
    const second = { ...skill, name: "another" };
    assert.deepEqual(jixuSkills([skill, second]), jixuSkills([second, skill]));
    assert.deepEqual(loaded.tools, config.tools);
    assert.equal(loaded.apiKey, config.apiKey);
    assert.equal(JSON.parse(before).version, 7);
    assert.equal((await stat(store.settingsPath)).mode & 0o777, 0o600);
    const agent = defineAgent({
      instructions: "Use relevant Skills.", skills: jixuSkills(loaded.skills),
      model: { provider: "fixture", model: "fixture" },
      modelCapabilities: {
        contextWindowTokens: 32_768, maxOutputTokens: 4_096, resolvedModel: "fixture",
        source: { kind: "explicit", name: "config-test" },
      },
    });
    assert.deepEqual(agent.snapshot.skills?.map(item => item.name), ["review"]);
    assert.equal(agent.skills?.[0]?.instructions, skill.instructions);
    assert.ok(!JSON.stringify(agent.snapshot).includes(skill.instructions));
    assert.ok(!JSON.stringify(agent).includes(disabled.instructions));
    const events = new InMemoryEventStore();
    const thread = await createHarness({ agent, store: events, modelDrivers: {} }).createThread();
    const changed = defineAgent({
      instructions: agent.snapshot.instructions, model: agent.snapshot.model,
      modelCapabilities: agent.snapshot.modelCapabilities!,
      skills: jixuSkills([{ ...skill, instructions: "Changed instructions" }]),
    });
    await assert.rejects(createHarness({ agent: changed, store: events, modelDrivers: {} }).openThread(thread.id), /Agent/);
    const restored = await createHarness({ agent, store: events, modelDrivers: {}, checkpoints: false }).openThread(thread.id);
    assert.deepEqual(await restored.state(), await thread.state());

    const invalid: unknown[] = [
      [{ ...skill, name: "bad name" }], [skill, skill], [{ ...skill, enabled: "yes" }],
      [{ ...skill, description: "" }], [{ ...skill, instructions: " " }],
      [{ ...skill, instructions: "密".repeat(5_462) }], [{ ...skill, extra: "secret-fixture" }],
      Array.from({ length: 17 }, (_, index) => ({ ...skill, name: `skill-${index}` })),
      Array.from({ length: 5 }, (_, index) => ({ ...skill, name: `skill-${index}`, instructions: "x".repeat(16_384), enabled: false })),
    ];
    for (const value of invalid) {
      assert.throws(() => parseJixuSkills(value));
      await assert.rejects(store.saveConnection({ ...config, skills: value as never }));
      assert.equal(await readFile(store.settingsPath, "utf8"), before);
      await writeFile(store.settingsPath, JSON.stringify({ ...JSON.parse(before), skills: value }));
      await assert.rejects(store.load(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /secret-fixture|DISABLED BODY/);
        return true;
      });
      await writeFile(store.settingsPath, before);
    }
    // Schema 6 preserves capability overrides and exact Tool selection, without eager rewrite.
    const legacy = JSON.stringify({
      ...JSON.parse(before), version: 6, skills: undefined,
      connection: { ...JSON.parse(before).connection, modelCapabilities: { contextWindowTokens: 32768, maxOutputTokens: 4096 } },
    });
    await writeFile(store.settingsPath, legacy);
    const migrated = await store.load();
    assert.deepEqual(migrated.skills, []);
    assert.deepEqual(migrated.modelCapabilities, { contextWindowTokens: 32768, maxOutputTokens: 4096 });
    assert.deepEqual(migrated.tools, config.tools);
    assert.equal(await readFile(store.settingsPath, "utf8"), legacy);
    await writeFile(join(store.directory, "auth.json"), JSON.stringify({ version: 3, connection: { key: "stale-fixture", type: "api_key" } }));
    assert.equal((await store.load()).apiKey, config.apiKey);
    assert.deepEqual(await readdir(store.directory), ["settings.json"]);
    await writeFile(store.settingsPath, JSON.stringify({ ...JSON.parse(before), skills: undefined }));
    await assert.rejects(store.load(), /Skills/);
    await writeFile(store.settingsPath, JSON.stringify({ ...JSON.parse(before), version: 8 }));
    await assert.rejects(store.load(), /schema version/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
