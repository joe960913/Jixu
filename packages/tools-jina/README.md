# jixu-tools-jina

Typed, opt-in Jina network Tools for the Jixu Harness.

```bash
npm install jixu-core jixu-tools-jina
```

```ts
import {
  createJinaWebReadTool,
  createJinaWebSearchTool,
} from "jixu-tools-jina";

const tools = [
  createJinaWebSearchTool({ apiKey: process.env.JINA_API_KEY }),
  createJinaWebReadTool({ apiKey: process.env.JINA_API_KEY }),
];
```

`web_search` discovers public webpages through metadata-only Jina Search. It
returns up to ten bounded titles, URLs, and descriptions without fetching page
content. Its optional `site` input is a hostname constraint, separate from the
query. A Jina no-results assertion is returned as a successful empty result set.

`web_read` reads one known public HTTP(S) URL. It is intended for user-provided
links, exact public API endpoints, and relevant candidates selected from Search.
Its optional `maxTokens` input accepts 500 through 8,000 and defaults to 4,000.
Reader trims oversized pages at that boundary, keeps link text inline with one
deduplicated URL summary, and removes image markup before content reaches the
model. Use 500–2,000 for a narrow fact and raise the limit only when source
coverage requires it.
When several independent sources are known, request their `web_read` calls in
one model response so the Harness can dispatch them as one parallel Tool batch.

Both Tools are idempotent and bound response bytes, durable metadata or content,
result count, and execution time. Search descriptions and Reader content carry
explicit truncation facts. The Jina Key remains inside the Tool closure and is
never part of Tool input or output.

Retrieved web content is untrusted evidence, not instructions. Applications
should apply an explicit network Tool permission policy and cite the returned
source URL when using it in an answer.

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)

## License

MIT
