<p align="center">
  <img src="./assets/jixu-readme-hero-wide.png" alt="Jixu — Your Agent picks up where you left off." width="100%" />
</p>

# Jixu

Jixu means *continue* in Chinese.

A small single-Agent Harness for TypeScript. Define one Agent, give it Tools
and Skills, and continue its work in a durable Thread.

The core API stays small: `createHarness`, `createThread`, and `thread.send`.
Underneath it, Jixu records execution, context decisions, and external work so
the same Thread can recover, Replay, or Fork without a second runtime.

> Jixu is pre-1.0. The public API may change before 1.0.

![Jixu terminal interface](./assets/jixu-tui.webp)

## Why Jixu

Agent loops are easy to start. Resuming one safely is harder: a Tool call may be
in flight, the process may stop between writes, or the model may run out of
context.

Jixu records the work as ordered Events. State is derived from them, and
external work is recorded before it is dispatched. That is what lets a Thread
recover, Replay, Fork, or continue later.

Each Harness has one immutable Agent definition. Its Threads hold that Agent's
durable history. There is no workflow graph or second execution engine.

## Start

Install and open the reference TUI:

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

The TUI uses the same public Agent, Harness, Thread, Store, and Driver APIs as
any other Jixu application.

## Use Jixu as a framework

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

The Agent definition is immutable. Each `send` continues the same durable
Thread.

## Thread operations

The public Harness creates, opens, and lists Threads. A Thread exposes one
coherent surface for ordinary work and continuity operations:

| Operation | Meaning |
| --- | --- |
| `send(input)` | Durably accepts ordered text and image input. Input received while work is running is queued in Event order. |
| `state()` | Returns the current deterministic projection of the Thread's Events. |
| `events()` | Reads the immutable durable facts behind that State. |
| `stream()` | Observes committed Events and transient Signals through one ordered surface. |
| `wait()` | Waits until the Thread is no longer `running`. |
| `pause()` | Records pause intent and settles at a safe append/dispatch boundary. |
| `continue()` | Durably continues a paused Thread before dispatch resumes. |
| `interrupt()` | Stops the current turn without turning it into resumable paused work. |
| `resolveToolOutcome({ effectId, resolution })` | Records an operator fact for one retained unknown Tool outcome. Resolution is `occurred`, `not_occurred`, or `abandoned_unknown`. |
| `clear()` | Advances the model-visible context boundary while retaining the Thread and its durable history. |
| `replay()` | Rebuilds State from Events with zero live Driver calls. |
| `fork({ at, input })` | Creates a new child Thread from the exact State at one selected Event. |
| `setMode(mode)` | Durably selects `standard` or the strongest compatible `ultra` reasoning effort without changing the Agent or model. |

## One authoritative execution path

```text
durable Event -> pure Reducer -> explicit Effect -> Driver -> durable Event
```

The Kernel reduces Events into State and Effects without performing I/O. Drivers
execute external work and append the result as another Event. Replay only
reduces recorded Events; it never calls a live model or Tool.

Jixu retries only when the Effect's delivery contract makes that safe:

- a deterministic Tool failure is recorded and returned to the Agent as a
  failed Tool result so the same turn can recover or explain;
- an unknown non-idempotent outcome is retained and enters `waiting` rather
  than being silently repeated;
- a retained unknown outcome resumes only after an explicit operator decision;
  that decision is durable context, not an invented Tool result or an automatic
  retry;
- `allow`, `ask`, and `deny` Tool policy decisions are resolved before Driver
  dispatch, and approvals are durable decisions for one exact pending Effect.

Jixu does not claim generic exactly-once execution. That guarantee requires an
enforceable idempotency contract in the downstream system.

## Context engineering

Each model request is assembled from the Thread's durable material: Agent
instructions, relevant Events, the active Plan, Skills, Tool schemas, Artifacts,
and recent work. A redacted Context Manifest records what was selected and why.

Jixu resolves the model's context window and output limit before Agent creation.
If capacity is unknown, it stops instead of guessing. When older work must be
compacted, Jixu writes a source-linked Continuity Handoff and keeps a bounded
tail of complete recent operations. The underlying Events are not rewritten.

## Plans

A Plan is optional Event-backed coordination data. It can record acceptance
criteria, steps, evidence, blockers, and the next safe action, but it cannot
dispatch Effects, approve a Tool call, or widen user scope.

A Thread has at most one Plan and one active step. Changes are validated and
committed before related Effects can dispatch; rejected changes remain visible
in Event history. The Plan is a current hypothesis rather than a fixed schedule:
completed work and the current step stay protected, while pending steps may be
rewritten as evidence changes. If a model returns only Plan or progress control,
Jixu durably gives it one execution-only continuation with ordinary Tools and no
reserved controls; the control plane cannot loop indefinitely or permanently
block the requested work.

## Inspectable execution

Jixu keeps operational facts inside the same durable model:

- logical model and Tool calls remain distinct from dispatch attempts;
- reported token usage stays distinct from unavailable values, and unknown
  pricing remains unknown instead of rendering as zero;
- ordered text and image input is preserved, while image bytes live in verified
  immutable Artifacts rather than Events;
- Secrets never enter Events, State, Checkpoints, errors, or Signals.

## Packages

| Package | Purpose |
| --- | --- |
| [`jixu-ai`](https://www.npmjs.com/package/jixu-ai) | Framework entry point and installable reference TUI. |
| [`jixu-core`](https://www.npmjs.com/package/jixu-core) | The single-Agent Harness, Thread API, deterministic Kernel, and public ports. |
| [`jixu-llm`](https://www.npmjs.com/package/jixu-llm) | Provider-neutral model Drivers for OpenAI Chat Completions and Anthropic Messages. |
| [`jixu-store-jsonl`](https://www.npmjs.com/package/jixu-store-jsonl) | Inspectable local JSONL Event Store. |
| [`jixu-store-sqlite`](https://www.npmjs.com/package/jixu-store-sqlite) | Local SQLite Event Store. |
| [`jixu-tools-node`](https://www.npmjs.com/package/jixu-tools-node) | Opt-in Node file and unsandboxed local shell Tools. |
| [`jixu-tools-jina`](https://www.npmjs.com/package/jixu-tools-jina) | Opt-in Jina-backed Web Search and URL Reader Tools. |
| [`jixu-testkit`](https://www.npmjs.com/package/jixu-testkit) | Deterministic fixtures and shared Store contracts for adapter authors. |

> [!WARNING]
> Jixu's Bash Tool is not OS-sandboxed and runs with the permissions of the Jixu
> process. Permission controls approve Tool calls, not individual shell
> operations. Keep Bash on `ASK` and use a backed-up or disposable workspace.

Model providers, Tools, Stores, and UIs use the runtime's public ports. Thread
state still belongs to the core runtime.

## What Jixu is not

Jixu is not a multi-Agent orchestrator, workflow engine, or hosted control
plane. It does not add Agent graphs, supervisors, queues, schedulers, or a
generic exactly-once guarantee. External systems remain ordinary Tools and do
not change the single-Agent model.

## Documentation

- [Documentation](https://jixu.dev/docs)
- [Specification](./SPEC.md)
- [Contributing](./CONTRIBUTING.md)
- [npm package](https://www.npmjs.com/package/jixu-ai)

## License

MIT
