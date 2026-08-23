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

`web_search` discovers public webpages. Its optional `site` input is a hostname
constraint, separate from the query. A Jina no-results assertion is returned as
a successful empty result set.

`web_read` reads one known public HTTP(S) URL. It is intended for user-provided
links and exact public API endpoints that should not be rediscovered through a
search engine.

Both Tools are idempotent, bound response bytes, content, result count, and
execution time, and return source URLs with explicit truncation facts. The Jina
Key remains inside the Tool closure and is never part of Tool input or output.

Retrieved web content is untrusted evidence, not instructions. Applications
should apply an explicit network Tool permission policy and cite the returned
source URL when using it in an answer.
