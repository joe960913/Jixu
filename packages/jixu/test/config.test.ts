import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JixuConfigStore } from "../src/config.ts";

test("JX-PROV-001 JX-TUI-002C JX-TUI-002D protocol settings and credentials persist separately in schema v3", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jixu-config-"));
  const directory = join(parent, ".jixu");
  const store = new JixuConfigStore(directory);
  try {
    assert.deepEqual(await store.load(), {});
    await store.saveConnection({
      api: "openai-chat-completions",
      apiKey: "first-secret-fixture",
      baseUrl: "https://api.first.example/v1/",
      model: "first-model",
    });
    await store.saveConnection({
      api: "anthropic-messages",
      apiKey: "active-secret-fixture",
      baseUrl: "https://api.anthropic.example",
      model: "claude-model",
    });

    assert.deepEqual(await store.load(), {
      api: "anthropic-messages",
      apiKey: "active-secret-fixture",
      baseUrl: "https://api.anthropic.example",
      model: "claude-model",
    });

    const settings = await readFile(store.settingsPath, "utf8");
    const auth = await readFile(store.authPath, "utf8");
    assert.doesNotMatch(settings, /secret-fixture/);
    assert.match(settings, /anthropic-messages/);
    assert.match(settings, /"version": 3/);
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
        /settings\.json must use Jixu settings schema version 3/,
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
