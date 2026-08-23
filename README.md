<p align="center">
  <img src="./assets/jixu-readme-hero-wide.png" alt="Jixu — Your Agent picks up where you left off." width="100%" />
</p>

# Jixu

Jixu means *continue* in Chinese.

A small single-Agent Harness for TypeScript. Define one Agent, give it Tools
and Skills, and continue its work in a durable Thread.

> Jixu is pre-1.0. The public API may change before 1.0.

![Jixu terminal interface](./assets/jixu-tui.webp)

## Start

```bash
npm install -g jixu-ai
jixu
```

Global installation also works with `pnpm add -g jixu-ai` and
`bun add -g jixu-ai`. Or run Jixu without installing it:

```bash
npx jixu-ai
# pnpm dlx jixu-ai
# yarn dlx jixu-ai
# bunx jixu-ai
```

The package launcher requires Node.js 22.19.0 or newer. The native TUI supports
macOS arm64 and Linux x64 with glibc; Intel macOS is not supported. Bun is not
required at runtime.

## Framework

```bash
npm install jixu-core jixu-llm jixu-store-sqlite
```

```ts
import { createHarness, defineAgent } from "jixu-core";
import {
  createLLMModelDriver,
  resolveLLMModelCapabilities,
} from "jixu-llm";
import { SqliteEventStore } from "jixu-store-sqlite";

const connection = {
  api: "openai-chat-completions" as const,
  apiKey: process.env.MODEL_API_KEY,
  baseURL: "https://api.openai.com/v1",
  model: "gpt-5.6-sol",
};

const modelCapabilities = await resolveLLMModelCapabilities(connection);
const agent = defineAgent({
  instructions: "Be precise and verify your work.",
  model: { provider: "model", model: connection.model },
  modelCapabilities,
  tools: [],
});

const harness = createHarness({
  agent,
  modelDrivers: {
    model: createLLMModelDriver({
      api: connection.api,
      apiKey: connection.apiKey,
      baseURL: connection.baseURL,
      maxOutputTokens: modelCapabilities.maxOutputTokens,
    }),
  },
  store: new SqliteEventStore("./jixu.db"),
});

const thread = await harness.createThread();
const state = await thread.send("Review this design and identify its main risk.");

console.log(state.result);
```

Jixu resolves and freezes model capacity before Agent creation. Known endpoints
use verified metadata or Jixu's versioned catalogue; custom deployments declare
`explicit: { contextWindowTokens, maxOutputTokens }`. If capacity is uncertain,
Jixu stops rather than guessing.

Context Policy works within those limits and does not alter provider generation
defaults.

Threads start in `standard` mode. `await thread.setMode("ultra")` durably
requests the strongest compatible reasoning effort without changing the model
or protocol.

Thread input preserves ordered text and image parts. Images are stored as
verified immutable Artifacts; durable Events contain references, never raw
bytes.

## Design

An Agent is immutable configuration. A Thread is its durable history. The
ordered Event log is the sole authority; State is derived from it. External
work follows one path:

```text
Event -> Reducer -> Effect -> Driver -> Event
```

Replay calls no live Driver. Unknown persisted data fails closed. Secrets never
enter Events, State, Checkpoints, errors, or Signals.

Read [SPEC.md](./SPEC.md) for the product contract and
[CONTRIBUTING.md](./CONTRIBUTING.md) for development guidance.

## License

MIT
