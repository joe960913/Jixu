# Jixu

**Agents that continue.**

Jixu is a small, event-sourced TypeScript runtime for agents that can pause,
resume, fork, and replay.

> **Project status:** M2 continuity runtime and its M2.1 experiential gate are
> implemented locally, awaiting maintainer acceptance. Packages remain
> unpublished and the public API is pre-release.

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

## Try the reference TUI

Prerequisites: Node.js 22.18+ for the workspace and Bun 1.3+ for the source TUI.

```bash
pnpm install
pnpm dev
```

Setup happens inside the TUI:

1. choose the endpoint API format: Responses or Chat Completions;
2. enter a compatible Base URL, such as `https://api.example.com/v1`;
3. enter its API Key; and
4. enter any valid model ID as free-form text.

Jixu works with endpoints that implement either `/v1/responses` or
`/v1/chat/completions`. The selected format is explicit and Jixu does not retry
the same request through the other API, avoiding accidental duplicate work or
charges.

Jixu stores the endpoint API Key in `~/.jixu/auth.json` and non-secret defaults in
`~/.jixu/settings.json`. On POSIX systems the directory is restricted to `0700`
and the files to `0600`. A complete saved configuration reconnects on the next
launch; use `/config` to replace it without leaving the TUI. Environment
variables and CLI flags are optional prefill mechanisms, not prerequisites.

Each prompt starts an ordinary durable `Agent` Run. The reference Agent exposes
the built-in `read`, `write`, `edit`, and `bash` Tools. File Tools stay inside
the selected workspace; `bash` is a local unsandboxed shell running with the
Jixu process permissions.

Useful controls:

- `/events`, `/state`, and `/replay` inspect durable behavior;
- `/pause` and `/resume` control the current Run at dispatch boundaries;
- `/fork <event-id> <input>` starts a new Run from an earlier Event;
- `/config` changes the API format, Base URL, credentials, and model ID; and
- `/help` shows the complete command list.

The current source checkout has one canonical pnpm lockfile. Installation from
packed release candidates through npm, pnpm, Yarn, and Bun is an M4 release
acceptance item; it is not yet a supported published-package claim.

## Implemented through M2.1

- Deterministic Event → Reducer → Effect → Driver execution.
- Recovery from the durable Event log, with ready and pending Effects kept
  distinct.
- Idempotent retry identity and safe waiting for unknown non-idempotent Tool
  outcomes.
- Durable pause/resume, atomic Fork, and side-effect-free Replay.
- Disposable, validated Checkpoints.
- In-memory, inspectable JSONL, and local SQLite Store adapters sharing one
  contract suite.
- Live Event and Signal observation through `run.stream()`.
- One unified `@jixu/llm` adapter boundary for Responses- and Chat
  Completions-compatible endpoints, plus OpenAI and OpenRouter convenience
  factories.
- Opt-in, workspace-bounded Node `read`, `write`, and `edit` Tools plus an
  explicitly unsandboxed local `bash` Tool.
- A reference OpenTUI application that runs the same ordinary `Agent`, persists
  credentials separately, and exposes continuity controls.

The JSONL Store is intended for one active local process. The SQLite adapter
uses Node's built-in `node:sqlite`, which is still marked experimental by the
supported Node 24 runtime.

## Current kernel API

```ts
import { createRuntime, defineAgent } from "@jixu/core";
import { SqliteEventStore } from "@jixu/store-sqlite";

const runtime = createRuntime({
  modelDrivers: { provider: yourModelDriver },
  store: new SqliteEventStore("./jixu.db"),
});

const agent = defineAgent({
  instructions: "Be precise.",
  model: { provider: "provider", model: "model-name" },
  tools: [yourTool],
});

const run = await runtime.run(agent, "Compare these three companies.");
const completed = await run.wait();

const forkPoint = (await run.events()).at(-1);
if (forkPoint === undefined) throw new Error("Run has no Events");

const alternative = await run.fork({
  at: forkPoint.id,
  input: "Re-evaluate using a different assumption.",
});

const replay = await run.replay();
const recovered = await runtime.recover(agent, run.id);
```

Live Runs also expose `pause()` and `resume()` at durable dispatch boundaries.
Anthropic, MCP, Agent Skills, cancellation, package publication, standalone
executables, and release examples remain planned for later milestones.

## License

MIT
