import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHarness,
  defineAgent,
  InMemoryEventStore,
  ToolExecutionError,
} from "jixu-core";
import type {
  ModelDriver,
  ModelOutcome,
  ToolExecutionContext,
} from "jixu-core";

import { createJinaWebSearchTool } from "../src/index.ts";

const TEST_MODEL_CAPABILITIES = {
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  resolvedModel: "deterministic",
  source: { kind: "explicit", name: "jina-tool-test" },
} as const;

function context(signal = new AbortController().signal): ToolExecutionContext {
  return {
    cancellation: signal,
    effectId: "effect-1",
    idempotencyKey: "idempotency-1",
    signals: { emit() {} },
    threadId: "thread-1",
  };
}

function jinaResponse(data: readonly unknown[]): Response {
  return new Response(JSON.stringify({ code: 200, data, status: 20_000 }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

test("JX-AC-048 missing Jina Key fails before network dispatch with the settings path", async () => {
  let calls = 0;
  const tool = createJinaWebSearchTool({
    fetch: async () => {
      calls += 1;
      return jinaResponse([]);
    },
  });

  await assert.rejects(
    tool.execute(tool.parseInput({ query: "current Jixu release" }), context()),
    (error: unknown) => {
      assert.ok(error instanceof ToolExecutionError);
      assert.equal(error.code, "jina_api_key_missing");
      assert.match(error.message, /tools\.webSearch\.apiKey/);
      assert.match(error.message, /~\/\.jixu\/settings\.json/);
      assert.doesNotMatch(error.message, /Authorization|Bearer/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("JX-AC-048 Jina Web Search normalizes source-linked content and bounds durable output", async () => {
  const requests: Array<{
    readonly input: RequestInfo | URL;
    readonly init?: RequestInit;
  }> = [];
  const tool = createJinaWebSearchTool({
    apiKey: "Bearer fixture-secret",
    fetch: async (input, init) => {
      requests.push({ input, ...(init === undefined ? {} : { init }) });
      return jinaResponse([
        {
          content: "abcdefghij",
          description: "First description",
          title: "First",
          url: "https://example.com/first",
        },
        {
          content: "klmnopqrst",
          description: "Second description",
          title: "Second",
          url: "https://example.org/second",
        },
        {
          content: "not selected",
          description: "Third description",
          title: "Third",
          url: "https://example.net/third",
        },
      ]);
    },
    maxContentCharactersPerResult: 6,
    maxTotalContentCharacters: 8,
  });
  const input = tool.parseInput({
    maxResults: 2,
    query: "  focused search  ",
    site: "example.com/path",
  });
  assert.deepEqual(input, {
    maxResults: 2,
    query: "focused search",
    site: "https://example.com",
  });
  assert.deepEqual(tool.authorize(input), {
    action: "web_search",
    resources: ["site:example.com"],
  });

  const output = tool.parseOutput(await tool.execute(input, context()));
  assert.equal(output.query, "focused search");
  assert.equal(output.results.length, 2);
  assert.deepEqual(output.results.map((result) => result.content), ["abcdef", "kl"]);
  assert.deepEqual(
    output.results.map((result) => result.contentTruncated),
    [true, true],
  );
  assert.equal(output.truncated, true);

  const captured = requests[0];
  assert.notEqual(captured, undefined);
  if (captured === undefined) return;
  assert.equal(String(captured.input), "https://s.jina.ai/");
  assert.equal(captured.init?.method, "POST");
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer fixture-secret");
  assert.equal(headers.get("x-site"), "https://example.com");
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    num: 2,
    options: "Markdown",
    q: "focused search",
  });
});

test("JX-AC-048 ordinary Harness dispatch is durable and Replay performs no Jina request", async () => {
  let fetchCalls = 0;
  let modelCalls = 0;
  const webSearch = createJinaWebSearchTool({
    apiKey: "fixture-secret",
    fetch: async () => {
      fetchCalls += 1;
      return jinaResponse([
        {
          content: "Source-backed page content.",
          description: "A source description",
          title: "Primary source",
          url: "https://example.com/source",
        },
      ]);
    },
  });
  const driver: ModelDriver = {
    async generate(): Promise<ModelOutcome> {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            status: "succeeded",
            value: {
              content: "",
              toolCalls: [
                {
                  arguments: { maxResults: 1, query: "durable web evidence" },
                  id: "search-1",
                  name: "web_search",
                },
              ],
            },
          }
        : {
            status: "succeeded",
            value: {
              content: "The source supports the answer.",
              toolCalls: [],
            },
          };
    },
  };
  const store = new InMemoryEventStore();
  const harness = createHarness({
    agent: defineAgent({
      instructions: "Search before answering.",
      model: { model: "deterministic", provider: "mock" },
      modelCapabilities: TEST_MODEL_CAPABILITIES,
      tools: [webSearch],
    }),
    modelDrivers: { mock: driver },
    store,
  });

  const thread = await harness.createThread();
  await thread.send("Find durable web evidence");
  const events = await thread.events();
  assert.equal(
    events.filter((event) => event.type === "tool.requested").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "tool.completed").length,
    1,
  );
  assert.equal(fetchCalls, 1);

  await thread.replay();
  assert.equal(fetchCalls, 1);
});

test("JX-AC-048 Jina failures are typed, sanitized, and preserve retryability", async () => {
  const cases = [
    [401, "jina_authentication_failed", false],
    [429, "jina_rate_limited", true],
    [503, "jina_upstream_unavailable", true],
  ] as const;
  for (const [status, code, retryable] of cases) {
    const tool = createJinaWebSearchTool({
      apiKey: "fixture-secret",
      fetch: async () => new Response("upstream-secret-body", { status }),
    });
    await assert.rejects(
      tool.execute(tool.parseInput({ query: "failure" }), context()),
      (error: unknown) => {
        assert.ok(error instanceof ToolExecutionError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.doesNotMatch(error.message, /fixture-secret|upstream-secret-body/);
        return true;
      },
    );
  }
});

test("JX-AC-048 Jina response byte, JSON, timeout, and cancellation boundaries fail closed", async () => {
  const tooLarge = createJinaWebSearchTool({
    apiKey: "fixture-secret",
    fetch: async () => jinaResponse([{ content: "large", url: "https://example.com" }]),
    maxResponseBytes: 10,
  });
  await assert.rejects(
    tooLarge.execute(tooLarge.parseInput({ query: "large" }), context()),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "jina_response_too_large",
  );

  const malformed = createJinaWebSearchTool({
    apiKey: "fixture-secret",
    fetch: async () => new Response("not-json", { status: 200 }),
  });
  await assert.rejects(
    malformed.execute(malformed.parseInput({ query: "malformed" }), context()),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "jina_response_invalid",
  );

  const hangingFetch: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted === true) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  const timeout = createJinaWebSearchTool({
    apiKey: "fixture-secret",
    fetch: hangingFetch,
    timeoutMs: 1,
  });
  await assert.rejects(
    timeout.execute(timeout.parseInput({ query: "timeout" }), context()),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "jina_timeout" &&
      error.retryable,
  );

  const cancellation = new AbortController();
  cancellation.abort();
  const cancelled = createJinaWebSearchTool({
    apiKey: "fixture-secret",
    fetch: hangingFetch,
  });
  await assert.rejects(
    cancelled.execute(
      cancelled.parseInput({ query: "cancelled" }),
      context(cancellation.signal),
    ),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "web_search_cancelled",
  );
});
