# Jixu

Jixu is a durable single-Agent Harness for TypeScript. Define one Agent, give
it Tools, and continue its work in a durable Thread.

> Jixu is pre-release. The public API may change before 1.0.

## Install

Jixu requires Node.js 22.19 or later.

Install the TUI globally with npm, pnpm, or Bun:

```bash
npm install -g jixu
# pnpm add -g jixu
# bun add -g jixu
```

Then start it from any terminal:

```bash
jixu
```

You can also run it without a global install:

```bash
npx jixu
# pnpm dlx jixu
# yarn dlx jixu
# bunx jixu
```

The initial native TUI targets are macOS arm64, macOS x64, and Linux x64
with glibc. Bun is not required at runtime.

Install the Agent Framework packages separately when building an application:

```bash
npm install @jixu/core @jixu/llm @jixu/store-sqlite
```

## Quick start

```ts
import { createHarness, defineAgent } from "@jixu/core";
import { createLLMModelDriver } from "@jixu/llm";
import { SqliteEventStore } from "@jixu/store-sqlite";

const agent = defineAgent({
  instructions: "Be precise and verify your work.",
  model: { provider: "model", model: "your-model" },
  tools: [],
});

const harness = createHarness({
  agent,
  modelDrivers: {
    model: createLLMModelDriver({
      api: "openai-chat-completions",
      apiKey: process.env.MODEL_API_KEY,
      baseURL: "https://api.example.com/v1",
    }),
  },
  store: new SqliteEventStore("./jixu.db"),
});

const thread = await harness.createThread();
const state = await thread.send("Review this design and identify its main risk.");

console.log(state.result);
```

## What Jixu provides

- Durable multi-turn Threads that survive process restarts.
- Explicit side-effect boundaries with durable requests and outcomes.
- Recovery, pause, continue, fork, clear, and side-effect-free replay.
- Replaceable model, Tool, Store, and interface adapters.

The ordered Event log is the source of truth. State is derived from Events, and
external work follows one path:

```text
Event -> Reducer -> Effect -> Driver -> Event
```

See [SPEC.md](./SPEC.md) for the full product contract and
[CONTRIBUTING.md](./CONTRIBUTING.md) for development guidance.

## License

MIT
