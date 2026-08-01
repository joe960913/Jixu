import {
  defineSchema,
  defineTool,
  ToolExecutionError,
} from "jixu-core";
import type { JsonObject, JsonValue, Tool } from "jixu-core";

export const JINA_WEB_SEARCH_TOOL_NAME = "web_search" as const;
export const JINA_TOOL_NAMES = Object.freeze([JINA_WEB_SEARCH_TOOL_NAME] as const);
export type JinaWebSearchToolName = (typeof JINA_TOOL_NAMES)[number];

export type JinaWebSearchInput = {
  readonly maxResults?: number;
  readonly query: string;
  readonly site?: string;
};

export type JinaWebSearchResult = {
  readonly content: string;
  readonly contentTruncated: boolean;
  readonly description: string;
  readonly title: string;
  readonly url: string;
};

export type JinaWebSearchOutput = {
  readonly query: string;
  readonly results: readonly JinaWebSearchResult[];
  readonly truncated: boolean;
};

export interface JinaWebSearchConfig {
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly maxContentCharactersPerResult?: number;
  readonly maxResponseBytes?: number;
  readonly maxTotalContentCharacters?: number;
  readonly settingsPath?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 5;
const MAX_QUERY_CHARACTERS = 2_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_CONTENT_CHARACTERS_PER_RESULT = 12_000;
const DEFAULT_MAX_TOTAL_CONTENT_CHARACTERS = 48_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const JINA_ENDPOINT = "https://s.jina.ai/";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`${label}.${unknown} is unknown`);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new TypeError(`${label}.${key} must be a string`);
  }
  return field;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string") {
    throw new TypeError(`${label}.${key} must be a string`);
  }
  return field;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  return positiveInteger(value, label);
}

function normalizeQuery(value: string): string {
  const query = value.trim();
  if (query.length === 0) throw new TypeError("web_search input.query must not be empty");
  if (query.length > MAX_QUERY_CHARACTERS) {
    throw new TypeError(
      `web_search input.query must not exceed ${MAX_QUERY_CHARACTERS} characters`,
    );
  }
  return query;
}

function normalizeSite(value: string): string {
  const clean = value.trim();
  if (clean.length === 0) throw new TypeError("web_search input.site must not be empty");
  let parsed: URL;
  try {
    parsed = new URL(clean.includes("://") ? clean : `https://${clean}`);
  } catch {
    throw new TypeError("web_search input.site must be a valid HTTP or HTTPS site");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(
      "web_search input.site must be an HTTP or HTTPS site without credentials, query, or fragment",
    );
  }
  return parsed.origin;
}

const inputSchema = defineSchema<JinaWebSearchInput>({
  jsonSchema: {
    additionalProperties: false,
    properties: {
      maxResults: {
        description: "Maximum number of results to return, from 1 through 5.",
        maximum: MAX_RESULTS,
        minimum: 1,
        type: "integer",
      },
      query: {
        description: "A focused web search query.",
        maxLength: MAX_QUERY_CHARACTERS,
        minLength: 1,
        type: "string",
      },
      site: {
        description: "Optional hostname or HTTP(S) site to restrict the search.",
        type: "string",
      },
    },
    required: ["query"],
    type: "object",
  },
  parse(value) {
    const input = object(value, "web_search input");
    onlyKeys(input, ["maxResults", "query", "site"], "web_search input");
    const maxResults = input.maxResults === undefined
      ? undefined
      : positiveInteger(input.maxResults, "web_search input.maxResults");
    if (maxResults !== undefined && maxResults > MAX_RESULTS) {
      throw new TypeError(`web_search input.maxResults must not exceed ${MAX_RESULTS}`);
    }
    const siteValue = optionalString(input, "site", "web_search input");
    return {
      ...(maxResults === undefined ? {} : { maxResults }),
      query: normalizeQuery(requiredString(input, "query", "web_search input")),
      ...(siteValue === undefined ? {} : { site: normalizeSite(siteValue) }),
    };
  },
});

function parseResult(value: unknown, index: number): JinaWebSearchResult {
  const result = object(value, `Jina result ${index}`);
  const url = requiredString(result, "url", `Jina result ${index}`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`Jina result ${index}.url must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`Jina result ${index}.url must use HTTP or HTTPS`);
  }
  const contentTruncated = result.contentTruncated;
  if (typeof contentTruncated !== "boolean") {
    throw new TypeError(`Jina result ${index}.contentTruncated must be a boolean`);
  }
  return {
    content: requiredString(result, "content", `Jina result ${index}`),
    contentTruncated,
    description: requiredString(result, "description", `Jina result ${index}`),
    title: requiredString(result, "title", `Jina result ${index}`),
    url: parsed.href,
  };
}

const outputSchema = defineSchema<JinaWebSearchOutput>({
  jsonSchema: {
    additionalProperties: false,
    properties: {
      query: { type: "string" },
      results: {
        items: {
          additionalProperties: false,
          properties: {
            content: { type: "string" },
            contentTruncated: { type: "boolean" },
            description: { type: "string" },
            title: { type: "string" },
            url: { type: "string" },
          },
          required: [
            "title",
            "url",
            "description",
            "content",
            "contentTruncated",
          ],
          type: "object",
        },
        type: "array",
      },
      truncated: { type: "boolean" },
    },
    required: ["query", "results", "truncated"],
    type: "object",
  },
  parse(value) {
    const output = object(value, "web_search output");
    onlyKeys(output, ["query", "results", "truncated"], "web_search output");
    if (!Array.isArray(output.results)) {
      throw new TypeError("web_search output.results must be an array");
    }
    if (typeof output.truncated !== "boolean") {
      throw new TypeError("web_search output.truncated must be a boolean");
    }
    return {
      query: requiredString(output, "query", "web_search output"),
      results: output.results.map(parseResult),
      truncated: output.truncated,
    };
  },
});

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  abort: AbortController,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        abort.abort();
        throw new ToolExecutionError(
          "jina_response_too_large",
          `Jina Search response exceeded the ${maximumBytes} byte limit`,
          false,
        );
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function upstreamFailure(status: number, settingsPath: string): ToolExecutionError {
  if (status === 401 || status === 403) {
    return new ToolExecutionError(
      "jina_authentication_failed",
      `Jina rejected the API key in ${settingsPath}`,
      false,
    );
  }
  if (status === 429) {
    return new ToolExecutionError(
      "jina_rate_limited",
      "Jina Search is rate limited; try again later",
      true,
    );
  }
  if (status >= 500) {
    return new ToolExecutionError(
      "jina_upstream_unavailable",
      `Jina Search returned HTTP ${status}`,
      true,
    );
  }
  return new ToolExecutionError(
    "jina_request_failed",
    `Jina Search returned HTTP ${status}`,
    false,
  );
}

function normalizeApiKey(value: string | undefined): string | undefined {
  const clean = value?.trim().replace(/^Bearer\s+/iu, "");
  return clean === undefined || clean.length === 0 ? undefined : clean;
}

function normalizeJinaResponse(
  raw: unknown,
  input: JinaWebSearchInput,
  maxContentCharactersPerResult: number,
  maxTotalContentCharacters: number,
): JinaWebSearchOutput {
  const response = object(raw, "Jina Search response");
  if (!Array.isArray(response.data)) {
    throw new ToolExecutionError(
      "jina_response_invalid",
      "Jina Search response did not contain a result array",
      false,
    );
  }
  const maximumResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  let remainingContent = maxTotalContentCharacters;
  let truncated = response.data.length > maximumResults;
  const results: JinaWebSearchResult[] = [];
  for (const [index, candidate] of response.data.slice(0, maximumResults).entries()) {
    let source: Record<string, unknown>;
    try {
      source = object(candidate, `Jina result ${index}`);
    } catch {
      throw new ToolExecutionError(
        "jina_response_invalid",
        `Jina Search result ${index} was not an object`,
        false,
      );
    }
    const title = typeof source.title === "string" ? source.title.trim() : "";
    const url = typeof source.url === "string" ? source.url.trim() : "";
    const description = typeof source.description === "string"
      ? source.description.trim()
      : "";
    const content = typeof source.content === "string"
      ? source.content.replace(/\r\n?/gu, "\n").trim()
      : "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolExecutionError(
        "jina_response_invalid",
        `Jina Search result ${index} contained an invalid URL`,
        false,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ToolExecutionError(
        "jina_response_invalid",
        `Jina Search result ${index} contained a non-HTTP URL`,
        false,
      );
    }
    const contentLimit = Math.min(
      maxContentCharactersPerResult,
      remainingContent,
    );
    const boundedContent = content.slice(0, contentLimit);
    const contentTruncated = boundedContent.length < content.length;
    truncated ||= contentTruncated;
    remainingContent -= boundedContent.length;
    results.push({
      content: boundedContent,
      contentTruncated,
      description,
      title: title.length === 0 ? parsed.hostname : title,
      url: parsed.href,
    });
  }
  return { query: input.query, results, truncated };
}

export function createJinaWebSearchTool(
  config: JinaWebSearchConfig = {},
): Tool<JinaWebSearchInput, JinaWebSearchOutput> {
  const apiKey = normalizeApiKey(config.apiKey);
  const fetchImplementation = config.fetch ?? fetch;
  const maxContentCharactersPerResult = boundedPositiveInteger(
    config.maxContentCharactersPerResult,
    DEFAULT_MAX_CONTENT_CHARACTERS_PER_RESULT,
    "maxContentCharactersPerResult",
  );
  const maxResponseBytes = boundedPositiveInteger(
    config.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const maxTotalContentCharacters = boundedPositiveInteger(
    config.maxTotalContentCharacters,
    DEFAULT_MAX_TOTAL_CONTENT_CHARACTERS,
    "maxTotalContentCharacters",
  );
  const settingsPath = config.settingsPath ?? "~/.jixu/settings.json";
  const timeoutMs = boundedPositiveInteger(
    config.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );

  return defineTool({
    authorization: {
      action: JINA_WEB_SEARCH_TOOL_NAME,
      resources: (input) => [
        input.site === undefined
          ? "internet"
          : `site:${new URL(input.site).hostname}`,
      ],
    },
    description:
      "Search the public web through Jina and return bounded, source-linked page content. Use focused queries and cite result URLs in the final response.",
    idempotency: "idempotent",
    input: inputSchema,
    name: JINA_WEB_SEARCH_TOOL_NAME,
    origin: "builtin",
    output: outputSchema,
    risk: "network",
    async execute(input, context) {
      if (apiKey === undefined) {
        throw new ToolExecutionError(
          "jina_api_key_missing",
          `Web Search requires a Jina API key. Add tools.webSearch.apiKey to ${settingsPath}, restart Jixu, then create the next Thread.`,
          false,
        );
      }
      const abort = new AbortController();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([
        context.cancellation,
        timeout,
        abort.signal,
      ]);
      let response: Response;
      try {
        response = await fetchImplementation(JINA_ENDPOINT, {
          body: JSON.stringify({
            q: input.query,
            num: input.maxResults ?? DEFAULT_MAX_RESULTS,
            options: "Markdown",
          }),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-Max-Tokens": "8000",
            "X-Retain-Images": "none",
            "X-Timeout": String(Math.max(1, Math.floor(timeoutMs / 1_000))),
            ...(input.site === undefined ? {} : { "X-Site": input.site }),
          },
          method: "POST",
          signal,
        });
      } catch {
        if (context.cancellation.aborted) {
          throw new ToolExecutionError(
            "web_search_cancelled",
            "Web Search was cancelled",
            false,
          );
        }
        if (timeout.aborted) {
          throw new ToolExecutionError(
            "jina_timeout",
            `Jina Search exceeded the ${timeoutMs} ms timeout`,
            true,
          );
        }
        throw new ToolExecutionError(
          "jina_network_error",
          "Jina Search could not be reached",
          true,
        );
      }
      if (!response.ok) throw upstreamFailure(response.status, settingsPath);
      let source: string;
      try {
        source = await readBoundedBody(response, maxResponseBytes, abort);
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        throw new ToolExecutionError(
          "jina_network_error",
          "Jina Search response could not be read",
          true,
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(source) as unknown;
      } catch {
        throw new ToolExecutionError(
          "jina_response_invalid",
          "Jina Search returned invalid JSON",
          false,
        );
      }
      return normalizeJinaResponse(
        raw,
        input,
        maxContentCharactersPerResult,
        maxTotalContentCharacters,
      );
    },
  });
}

export type JinaWebSearchTool = Tool<
  JinaWebSearchInput,
  JinaWebSearchOutput
>;

export function assertJinaWebSearchOutput(value: JsonValue): JinaWebSearchOutput {
  return outputSchema.parse(value);
}

export const JINA_WEB_SEARCH_OUTPUT_SCHEMA = outputSchema.jsonSchema as JsonObject;
