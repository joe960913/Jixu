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
  ModelGenerateEffect,
  ModelOutcome,
  ToolExecutionContext,
} from "jixu-core";

import {
  createJinaWebReadTool,
  createJinaWebSearchTool,
} from "../src/index.ts";
import type { JinaWebSearchOutput } from "../src/index.ts";

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

function jinaReaderResponse(data: unknown): Response {
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

test("JX-AC-060 Web Read missing Jina Key fails before network dispatch with the settings path", async () => {
  let calls = 0;
  const tool = createJinaWebReadTool({
    fetch: async () => {
      calls += 1;
      return jinaReaderResponse({});
    },
  });
  await assert.rejects(
    tool.execute(tool.parseInput({ url: "https://example.com" }), context()),
    (error: unknown) => {
      assert.ok(error instanceof ToolExecutionError);
      assert.equal(error.code, "jina_api_key_missing");
      assert.match(error.message, /tools\.webSearch\.apiKey/);
      assert.doesNotMatch(error.message, /Authorization|Bearer/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("JX-AC-048 Jina Web Search returns bounded metadata without page content", async () => {
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
          content: "page content must not enter the normalized output",
          description: "abcdefghij",
          title: "First",
          url: "https://example.com/first",
        },
        {
          content: "second page content must also be ignored",
          description: "klmnopqrst",
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
    maxDescriptionCharactersPerResult: 6,
    maxTotalDescriptionCharacters: 8,
  });
  const input = tool.parseInput({
    maxResults: 2,
    query: "  focused search  ",
    site: "https://example.com",
  });
  assert.deepEqual(input, {
    maxResults: 2,
    query: "focused search",
    site: "example.com",
  });
  assert.deepEqual(tool.authorize(input), {
    action: "web_search",
    resources: ["site:example.com"],
  });

  const output = tool.parseOutput(await tool.execute(input, context()));
  assert.equal(output.query, "focused search");
  assert.equal(output.results.length, 2);
  assert.deepEqual(
    output.results.map((result) => result.description),
    ["abcdef", "kl"],
  );
  assert.deepEqual(
    output.results.map((result) => result.descriptionTruncated),
    [true, true],
  );
  assert.equal("content" in output.results[0]!, false);
  assert.equal(output.truncated, true);
  assert.equal(tool.descriptor.outputSchemaVersion, 2);

  const captured = requests[0];
  assert.notEqual(captured, undefined);
  if (captured === undefined) return;
  assert.equal(String(captured.input), "https://s.jina.ai/search");
  assert.equal(captured.init?.method, "POST");
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer fixture-secret");
  assert.equal(headers.get("x-max-tokens"), null);
  assert.equal(headers.get("x-site"), null);
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    num: 2,
    q: "focused search",
    respondWith: "no-content",
    retainImages: "none",
    retainLinks: "text",
    site: ["example.com"],
  });
});

test("JX-AC-048 Jina Web Search uses a hostname-only site field and treats 42206 no-results as success", async () => {
  const noResults = createJinaWebSearchTool({
    apiKey: "fixture-secret",
    fetch: async () => new Response(JSON.stringify({
      code: 422,
      message: "No search results available for query exact fixture",
      readableMessage: "AssertionFailureError: no results",
      status: 42_206,
    }), { status: 422 }),
  });
  assert.deepEqual(
    await noResults.execute(
      noResults.parseInput({ query: "exact fixture", site: "example.com" }),
      context(),
    ),
    { query: "exact fixture", results: [], truncated: false },
  );

  assert.throws(
    () => noResults.parseInput({
      query: "path-bearing site",
      site: "https://example.com/path",
    }),
    /without credentials, path, query, or fragment/,
  );
  assert.equal(
    noResults.parseInput({ maxResults: 10, query: "broad discovery" })
      .maxResults,
    10,
  );
  assert.throws(
    () => noResults.parseInput({ maxResults: 11, query: "too broad" }),
    /must not exceed 10/,
  );

  const otherAssertion = createJinaWebSearchTool({
    apiKey: "fixture-secret",
    fetch: async () => new Response(JSON.stringify({
      code: 422,
      message: "Another assertion failed",
      status: 42_206,
    }), { status: 422 }),
  });
  await assert.rejects(
    otherAssertion.execute(
      otherAssertion.parseInput({ query: "invalid request" }),
      context(),
    ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "jina_request_failed" &&
      !error.retryable,
  );
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

test("JX-AC-062 metadata discovery fans independent Reader calls into one durable parallel batch", { timeout: 2_000 }, async () => {
  let searchCalls = 0;
  let readCalls = 0;
  let activeReads = 0;
  let maximumActiveReads = 0;
  let releaseReads!: () => void;
  const allReadsStarted = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const fetchImplementation: typeof fetch = async (input, init) => {
    const endpoint = String(input);
    if (endpoint === "https://s.jina.ai/search") {
      searchCalls += 1;
      return jinaResponse(
        Array.from({ length: 10 }, (_, index) => ({
          content: `unrequested page body ${index + 1}`,
          description: `Candidate ${index + 1} description`,
          title: `Candidate ${index + 1}`,
          url: `https://source-${index + 1}.example/evidence`,
        })),
      );
    }
    assert.equal(endpoint, "https://r.jina.ai/");
    const body = JSON.parse(String(init?.body)) as { readonly url: string };
    readCalls += 1;
    activeReads += 1;
    maximumActiveReads = Math.max(maximumActiveReads, activeReads);
    if (activeReads === 3) releaseReads();
    await allReadsStarted;
    activeReads -= 1;
    return jinaReaderResponse({
      content: `Primary evidence from ${body.url}`,
      description: "Official source",
      title: new URL(body.url).hostname,
      url: body.url,
    });
  };
  const webSearch = createJinaWebSearchTool({
    apiKey: "fixture-secret",
    fetch: fetchImplementation,
  });
  const webRead = createJinaWebReadTool({
    apiKey: "fixture-secret",
    fetch: fetchImplementation,
  });
  const modelEffects: ModelGenerateEffect[] = [];
  const driver: ModelDriver = {
    generate(effect): Promise<ModelOutcome> {
      modelEffects.push(structuredClone(effect));
      if (modelEffects.length === 1) {
        return Promise.resolve({
          status: "succeeded",
          value: {
            content: "",
            toolCalls: [
              {
                arguments: { query: "three official instruction sources" },
                id: "search-metadata",
                name: "web_search",
              },
            ],
          },
        });
      }
      if (modelEffects.length === 2) {
        const searchMessage = effect.input.messages.findLast(
          (message) => message.role === "tool" && message.name === "web_search",
        );
        assert.notEqual(searchMessage, undefined);
        assert.ok(searchMessage !== undefined && "output" in searchMessage);
        if (searchMessage === undefined || !("output" in searchMessage)) {
          throw new Error("Search metadata message is missing");
        }
        const output = searchMessage.output as JinaWebSearchOutput;
        assert.equal(output.results.length, 10);
        assert.ok(output.results.every((result) => !("content" in result)));
        return Promise.resolve({
          status: "succeeded",
          value: {
            content: "",
            toolCalls: output.results.slice(0, 3).map((result, index) => ({
              arguments: { url: result.url },
              id: `read-source-${index + 1}`,
              name: "web_read",
            })),
          },
        });
      }
      const readMessages = effect.input.messages.filter(
        (message) => message.role === "tool" && message.name === "web_read",
      );
      assert.equal(readMessages.length, 3);
      return Promise.resolve({
        status: "succeeded",
        value: {
          content:
            "Compared [source 1](https://source-1.example/evidence), [source 2](https://source-2.example/evidence), and [source 3](https://source-3.example/evidence).",
          toolCalls: [],
        },
      });
    },
  };
  const store = new InMemoryEventStore();
  const thread = await createHarness({
    agent: defineAgent({
      instructions: "Discover metadata, read independent sources together, then cite them.",
      model: { model: "deterministic", provider: "mock" },
      modelCapabilities: TEST_MODEL_CAPABILITIES,
      tools: [webSearch, webRead],
    }),
    modelDrivers: { mock: driver },
    store,
  }).createThread();

  const state = await thread.send("Compare three official instruction sources");
  const events = await thread.events();
  const readRequests = events.filter(
    (event) =>
      event.type === "tool.requested" &&
      event.payload.effect.input.name === "web_read",
  );
  const firstReadCompletion = events.findIndex(
    (event) => event.type === "tool.completed" && event.payload.name === "web_read",
  );
  assert.equal(searchCalls, 1);
  assert.equal(readCalls, 3);
  assert.equal(maximumActiveReads, 3);
  assert.equal(modelEffects.length, 3);
  assert.equal(readRequests.length, 3);
  assert.ok(
    readRequests.every((request) => request.sequence < firstReadCompletion + 1),
  );
  assert.match(state.result ?? "", /source-1\.example/);

  await thread.replay();
  assert.equal(searchCalls, 1);
  assert.equal(readCalls, 3);
});

test("JX-AC-010 JX-AC-048 JX-AC-049 Jina HTTP 503 remains Agent-visible and does not terminate the turn", async () => {
  let fetchCalls = 0;
  const effects: ModelGenerateEffect[] = [];
  const webSearch = createJinaWebSearchTool({
    apiKey: "fixture-secret",
    fetch: async () => {
      fetchCalls += 1;
      return new Response("upstream-secret-body", { status: 503 });
    },
  });
  const driver: ModelDriver = {
    generate(effect): Promise<ModelOutcome> {
      effects.push(structuredClone(effect));
      return Promise.resolve(
        effects.length === 1
          ? {
              status: "succeeded",
              value: {
                content: "",
                toolCalls: [
                  {
                    arguments: { query: "repository image outage" },
                    id: "search-503",
                    name: "web_search",
                  },
                ],
              },
            }
          : {
              status: "succeeded",
              value: {
                content: "Jina Search is temporarily unavailable; retry later.",
                toolCalls: [],
              },
            },
      );
    },
  };
  const store = new InMemoryEventStore();
  const thread = await createHarness({
    agent: defineAgent({
      instructions: "Search before answering and explain Tool failures.",
      model: { model: "deterministic", provider: "mock" },
      modelCapabilities: TEST_MODEL_CAPABILITIES,
      tools: [webSearch],
    }),
    modelDrivers: { mock: driver },
    store,
  }).createThread();

  const state = await thread.send("Investigate the outage");
  const failure = (await thread.events()).findLast(
    (event) => event.type === "tool.failed",
  );
  assert.equal(fetchCalls, 1);
  assert.equal(failure?.payload.error.code, "jina_upstream_unavailable");
  assert.equal(failure?.payload.error.retryable, true);
  assert.doesNotMatch(failure?.payload.error.message ?? "", /fixture-secret|upstream-secret-body/);
  assert.equal(effects.length, 2);
  assert.equal(
    effects[1]?.input.runtimeContext?.continuation.reason,
    "tool_failed",
  );
  assert.deepEqual(effects[1]?.input.messages.at(-1), {
    disposition: "failed",
    error: {
      code: "jina_upstream_unavailable",
      message: "Jina Search returned HTTP 503",
      retryable: true,
    },
    name: "web_search",
    role: "tool",
    toolCallId: "search-503",
  });
  assert.equal(state.status, "idle");
  assert.equal(state.error, null);
  assert.equal(
    state.result,
    "Jina Search is temporarily unavailable; retry later.",
  );

  assert.deepEqual(await thread.replay(), state);
  assert.equal(fetchCalls, 1);
});

test("JX-AC-060 Jina Web Read normalizes one known URL and bounds durable content", async () => {
  const requests: Array<{
    readonly input: RequestInfo | URL;
    readonly init?: RequestInit;
  }> = [];
  const tool = createJinaWebReadTool({
    apiKey: "Bearer fixture-secret",
    fetch: async (input, init) => {
      requests.push({ input, ...(init === undefined ? {} : { init }) });
      return jinaReaderResponse({
        content: "abcdefghij",
        description: "API response",
        title: "Exact source",
        url: "https://api.example.com/data?period=week",
      });
    },
    maxReadContentCharacters: 6,
  });
  const input = tool.parseInput({
    url: " https://api.example.com/data?period=week ",
  });
  assert.deepEqual(input, {
    maxTokens: 4_000,
    url: "https://api.example.com/data?period=week",
  });
  assert.deepEqual(tool.authorize(input), {
    action: "web_read",
    resources: ["origin:https://api.example.com"],
  });
  assert.throws(
    () => tool.parseInput({ url: "https://user:secret@example.com/private" }),
    /without embedded credentials/,
  );

  assert.deepEqual(tool.parseOutput(await tool.execute(input, context())), {
    content: "abcdef",
    contentTruncated: true,
    description: "API response",
    title: "Exact source",
    url: "https://api.example.com/data?period=week",
  });

  const captured = requests[0];
  assert.notEqual(captured, undefined);
  if (captured === undefined) return;
  assert.equal(String(captured.input), "https://r.jina.ai/");
  assert.equal(captured.init?.method, "POST");
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer fixture-secret");
  assert.equal(headers.get("x-max-tokens"), "4000");
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    maxTokens: 4_000,
    respondWith: "content",
    retainImages: "none",
    retainLinks: "text",
    url: "https://api.example.com/data?period=week",
    withLinksSummary: true,
  });
  assert.equal(tool.descriptor.outputSchemaVersion, 2);
});

test("JX-AC-060 Jina Web Read validates overrides and reports an upstream token cap", async () => {
  let captured: RequestInit | undefined;
  const tool = createJinaWebReadTool({
    apiKey: "fixture-secret",
    fetch: async (_input, init) => {
      captured = init;
      return jinaReaderResponse({
        content: "bounded upstream content",
        description: "",
        title: "Long source",
        url: "https://example.com/long",
        usage: { tokens: 1_200 },
      });
    },
  });

  assert.throws(
    () => tool.parseInput({ maxTokens: 499, url: "https://example.com" }),
    /from 500 through 8000/,
  );
  assert.throws(
    () => tool.parseInput({ maxTokens: 8_001, url: "https://example.com" }),
    /from 500 through 8000/,
  );
  const input = tool.parseInput({
    maxTokens: 1_200,
    url: "https://example.com/long",
  });
  assert.deepEqual(input, {
    maxTokens: 1_200,
    url: "https://example.com/long",
  });
  assert.deepEqual(tool.parseOutput(await tool.execute(input, context())), {
    content: "bounded upstream content",
    contentTruncated: true,
    description: "",
    title: "Long source",
    url: "https://example.com/long",
  });
  assert.equal(new Headers(captured?.headers).get("x-max-tokens"), "1200");
  assert.equal(JSON.parse(String(captured?.body)).maxTokens, 1_200);
});

test("JX-AC-060 ordinary Harness dispatch records Web Read once and Replay performs no Reader request", async () => {
  let fetchCalls = 0;
  let modelCalls = 0;
  const webRead = createJinaWebReadTool({
    apiKey: "fixture-secret",
    fetch: async () => {
      fetchCalls += 1;
      return jinaReaderResponse({
        content: '{"downloads":1086}',
        description: "",
        title: "",
        url: "https://api.example.com/downloads",
      });
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
                  arguments: { url: "https://api.example.com/downloads" },
                  id: "read-1",
                  name: "web_read",
                },
              ],
            },
          }
        : {
            status: "succeeded",
            value: {
              content: "The exact public API returned the download count.",
              toolCalls: [],
            },
          };
    },
  };
  const store = new InMemoryEventStore();
  const harness = createHarness({
    agent: defineAgent({
      instructions: "Read exact public sources.",
      model: { model: "deterministic", provider: "mock" },
      modelCapabilities: TEST_MODEL_CAPABILITIES,
      tools: [webRead],
    }),
    modelDrivers: { mock: driver },
    store,
  });

  const thread = await harness.createThread();
  await thread.send("Read the exact download source");
  const events = await thread.events();
  assert.equal(
    events.filter((event) =>
      event.type === "tool.requested" &&
      event.payload.effect.input.name === "web_read"
    ).length,
    1,
  );
  assert.equal(
    events.filter((event) =>
      event.type === "tool.completed" && event.payload.name === "web_read"
    ).length,
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

test("JX-AC-060 Jina Reader failures are typed, sanitized, and preserve retryability", async () => {
  const cases = [
    [401, "jina_authentication_failed", false],
    [429, "jina_rate_limited", true],
    [503, "jina_upstream_unavailable", true],
  ] as const;
  for (const [status, code, retryable] of cases) {
    const tool = createJinaWebReadTool({
      apiKey: "fixture-secret",
      fetch: async () => new Response("upstream-secret-body", { status }),
    });
    await assert.rejects(
      tool.execute(tool.parseInput({ url: "https://example.com" }), context()),
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

test("JX-AC-060 Jina Reader response, timeout, and cancellation boundaries fail closed", async () => {
  const tooLarge = createJinaWebReadTool({
    apiKey: "fixture-secret",
    fetch: async () => jinaReaderResponse({
      content: "large",
      url: "https://example.com",
    }),
    maxResponseBytes: 10,
  });
  await assert.rejects(
    tooLarge.execute(
      tooLarge.parseInput({ url: "https://example.com" }),
      context(),
    ),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "jina_response_too_large",
  );

  const invalidData = [
    new Response("not-json", { status: 200 }),
    new Response("null", { status: 200 }),
    jinaReaderResponse({ content: "content", url: "file:///private" }),
  ];
  for (const response of invalidData) {
    const tool = createJinaWebReadTool({
      apiKey: "fixture-secret",
      fetch: async () => response.clone(),
    });
    await assert.rejects(
      tool.execute(tool.parseInput({ url: "https://example.com" }), context()),
      (error: unknown) =>
        error instanceof ToolExecutionError && error.code === "jina_response_invalid",
    );
  }

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
  const timeout = createJinaWebReadTool({
    apiKey: "fixture-secret",
    fetch: hangingFetch,
    timeoutMs: 1,
  });
  await assert.rejects(
    timeout.execute(timeout.parseInput({ url: "https://example.com" }), context()),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "jina_timeout" &&
      error.retryable,
  );

  const cancellation = new AbortController();
  cancellation.abort();
  const cancelled = createJinaWebReadTool({
    apiKey: "fixture-secret",
    fetch: hangingFetch,
  });
  await assert.rejects(
    cancelled.execute(
      cancelled.parseInput({ url: "https://example.com" }),
      context(cancellation.signal),
    ),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "web_read_cancelled",
  );
});
