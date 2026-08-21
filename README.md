# Jixu

> Define one Agent. Give it Tools and Skills. Continue its work in a durable
> Thread.

Jixu is a small single-Agent Harness for TypeScript. Recovery, replay, context
continuity, and side-effect control stay beneath one direct API.

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

Model capacity is resolved before Agent creation and frozen in its snapshot.
Jixu accepts authoritative endpoint metadata, a versioned first-party catalogue
for recognized direct endpoints, or
`explicit: { contextWindowTokens, maxOutputTokens }` for a custom deployment.
Ambiguity fails closed. Context Policy works within those verified limits; it
does not silently tune provider generation defaults.

Threads begin in `standard` mode. `await thread.setMode("ultra")` durably asks
the same model and protocol for the strongest compatible reasoning effort.

Thread input can preserve ordered text and image parts. Image bytes are stored
as verified immutable Artifacts; durable Events contain references, never raw
bytes.

## Design

The Agent is immutable configuration. The Thread is one durable history. The
ordered Event log is the sole authority, and State is its deterministic
projection. External work has one path:

```text
Event -> Reducer -> Effect -> Driver -> Event
```

Replay dispatches no live Driver. Unknown persisted data fails closed. Secrets
never enter Events, State, Checkpoints, errors, or Signals.

Read [SPEC.md](./SPEC.md) for the product contract and
[CONTRIBUTING.md](./CONTRIBUTING.md) for development guidance.

## License

MIT
