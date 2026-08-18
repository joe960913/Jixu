# Jixu

**Agents that continue.**

Jixu is a small, event-sourced TypeScript runtime for agents that can pause,
resume, fork, and replay.

> **Project status:** M1 deterministic kernel implemented. The package is not
> published; continuity features begin in M2.

## Why Jixu

Most agent libraries begin with prompts, tools, or workflow graphs. Jixu begins
with the lifetime of a run:

- What survives a process crash?
- What is authoritative after a tool call?
- How can a human pause and resume work safely?
- How can a run fork without copying an opaque conversation?
- How can developers replay behavior without repeating side effects?

Jixu answers those questions with one compact execution model:

```text
durable Event -> pure Reducer -> explicit Effect -> Driver -> durable Event
```

Streaming model tokens and progress updates are non-authoritative `Signal`s.
The durable event log is the only source of truth.

## Design commitments

- A small, readable kernel.
- Plain TypeScript and serializable state.
- MCP, Agent Skills, and ordinary typed tools instead of replacement protocols.
- Provider, storage, and UI independence.
- Replay never repeats external side effects.
- Fork creates a new run with explicit lineage.
- Checkpoints accelerate recovery but never become a second source of truth.

## Acceptance-driven development

Jixu evolves through explicit behavior contracts and acceptance evidence.
Every behavior change must:

1. identify the observable contract it changes;
2. preserve the canonical terminology and architectural invariants;
3. include tests mapped to stable requirement or acceptance IDs; and
4. keep adapter details out of the kernel.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow.

## Planned API

```ts
import { createRuntime, defineAgent } from "jixu";
import { openai } from "@jixu/provider-openai";

const runtime = createRuntime();

const agent = defineAgent({
  model: openai("gpt-5"),
  tools: [searchWeb, readPage],
  skills: ["./skills"],
});

const run = await runtime.run(agent, "Compare these three companies.");

for await (const item of run.stream()) {
  console.log(item);
}

await run.pause();
await run.resume();

const alternative = await run.fork({
  at: "evt_42",
  input: "Re-evaluate using a different assumption.",
});

const replay = await run.replay();
```

The API above is part of the v0.1 specification target, not a published package
yet.

## License

MIT
