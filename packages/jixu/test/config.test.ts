import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JixuConfigStore } from "../src/config.ts";

test("JX-TUI-002C JX-TUI-002D compatible settings and credentials persist separately", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-"));
  const directory = join(parent, ".jixu");
  const store = new JixuConfigStore(directory);
  try {
    assert.deepEqual(await store.load(), {});
    await store.saveConnection({
      apiFormat: "responses",
      apiKey: "first-secret-fixture",
      baseUrl: "https://api.first.example/v1/",
      model: "first-model",
    });
    await store.saveConnection({
      apiFormat: "chat-completions",
      apiKey: "active-secret-fixture",
      baseUrl: "https://router.example/api/v1",
      model: "vendor/model-example",
    });

    assert.deepEqual(await store.load(), {
      apiFormat: "chat-completions",
      apiKey: "active-secret-fixture",
      baseUrl: "https://router.example/api/v1",
      model: "vendor/model-example",
    });

    const settings = await readFile(store.settingsPath, "utf8");
    const auth = await readFile(store.authPath, "utf8");
    assert.doesNotMatch(settings, /secret-fixture/);
    assert.match(settings, /chat-completions/);
    assert.match(settings, /https:\/\/router\.example\/api\/v1/);
    assert.match(settings, /vendor\/model-example/);
    assert.match(auth, /active-secret-fixture/);
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

test("JX-TUI-002C legacy provider-indexed configuration loads as Responses format", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-legacy-"));
  const store = new JixuConfigStore(join(parent, ".jixu"));
  try {
    await store.load();
    await writeFile(store.settingsPath, JSON.stringify({
      defaultProvider: "openrouter",
      models: { openrouter: "vendor/legacy-model" },
      version: 1,
    }), "utf8");
    await writeFile(store.authPath, JSON.stringify({
      providers: {
        openrouter: { key: "legacy-secret-fixture", type: "api_key" },
      },
      version: 1,
    }), "utf8");

    assert.deepEqual(await store.load(), {
      apiFormat: "responses",
      apiKey: "legacy-secret-fixture",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "vendor/legacy-model",
    });
  } finally {
    await rm(parent, { force: true, recursive: true });
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

test("JX-TUI-002C mixed configuration schema versions fail closed", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-mixed-"));
  const store = new JixuConfigStore(join(parent, ".jixu"));
  try {
    await store.load();
    await writeFile(store.settingsPath, JSON.stringify({
      connection: {
        apiFormat: "responses",
        baseUrl: "https://api.example/v1",
        model: "model",
      },
      version: 2,
    }), "utf8");
    await writeFile(store.authPath, JSON.stringify({ providers: {}, version: 1 }), "utf8");
    await assert.rejects(store.load(), /schema versions do not match/);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
