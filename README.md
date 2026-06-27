# Jixu

**Agents that continue.**

Jixu is a small, event-sourced TypeScript Agent Harness. Define one Agent, give
it Tools, and continue its work in a durable Thread.

> **Project status:** pre-release. Packages are not published yet and the public
> API may still change before the first stable version.

## Why Jixu

Jixu treats the Harness as the durable operating layer around one capable Agent:

- a Thread continues naturally across messages and process restarts;
- external work is durably requested before dispatch;
- pause, continue, clear, fork, recovery, and replay use the same lifecycle;
- non-trivial work can carry one compact, recoverable execution Plan;
- model providers, Tools, Stores, and interfaces remain replaceable; and
- the reference TUI consumes the same public API as any other application.

The compact execution model is:

```text
durable Event -> pure Reducer -> explicit Effect -> Driver -> durable Event
```

Signals such as streamed model tokens are observable but non-authoritative. The
ordered Event log remains the source of truth; Checkpoints are disposable caches.

The normative product and architecture contracts live in [SPEC.md](./SPEC.md)
and [ARCHITECTURE.md](./ARCHITECTURE.md).

## Public Harness API

```ts
import { createHarness, defineAgent } from "@jixu/core";
import { SqliteEventStore } from "@jixu/store-sqlite";

const agent = defineAgent({
  instructions: "Be precise.",
  model: { provider: "provider", model: "model-name" },
  tools: [yourTool],
});

const harness = createHarness({
  agent,
  modelDrivers: { provider: yourModelDriver },
  store: new SqliteEventStore("./jixu.db"),
});

const thread = await harness.createThread();
await thread.send("Compare these three companies.");
await thread.send("Now challenge the strongest assumption.");

const reopened = await harness.openThread(thread.id);
const threads = await harness.listThreads();
```

A Thread also exposes `clear`, `events`, `state`, `stream`, `wait`, `pause`,
`continue`, `fork`, and side-effect-free `replay`. Input accepted while a Thread
is running is durably queued and starts automatically after the current turn.

Planning is adaptive rather than a mode: simple requests proceed with no Plan,
while the Agent may create and revise one active Plan for dependent or uncertain
work. Plan changes are validated and committed as `plan.updated` before related
Tool Effects run. `thread.state().activePlan` exposes the current projection;
historical revisions remain in `thread.events()`. A Plan coordinates work but
does not grant permission or dispatch Effects.

`thread.state().metrics` is the durable efficiency projection: logical model
and Tool calls, retry attempts, terminal outcomes, reported input/output/
reasoning/cache tokens, and trusted USD cost. Terminal model Events retain the
canonical accounting facts, so Replay, recovery, clear, and Fork reproduce the
same totals. Provider-reported cost is accepted only from a trusted adapter;
other providers can inject a versioned `costCalculator`. Missing usage or
pricing stays explicit instead of becoming zero.

## Reference TUI

Prerequisites: Node.js 22.18+ for the workspace and Bun 1.3+ for the source TUI.

```bash
pnpm install
pnpm dev
```

The first launch enters the ordinary workspace even without credentials. It
shows `Model not configured` and `use /config`; setup is never a forced gate.
The endpoint can implement either `/v1/responses` or `/v1/chat/completions`.
Jixu stores credentials separately in `~/.jixu/auth.json` and non-secret settings
in `~/.jixu/settings.json` with restrictive POSIX permissions.
The footer shows the selected Thread's known USD cost; `USD —` means no trusted
price is available, and a trailing `+` marks a known partial total.

Normal prompts continue the selected Thread. Useful controls are:

- `/new` creates and selects an empty Thread;
- `/clear` clears the selected Thread context without changing its ID;
- `/resume` opens a keyboard-selectable list of previous Threads;
- `/pause` and `/continue` control a Thread at durable dispatch boundaries;
- `/fork <event-id> <input>` creates a child Thread with explicit lineage;
- `/events`, `/state`, and `/replay` inspect durable behavior; and
- `/config`, `/help`, and `/quit` manage the local application.

Typing `/` or a command prefix opens a filtered menu above the composer. Use Up
and Down to select, Escape to close, and Enter to invoke or insert a command.

The first-party Agent exposes workspace-bounded `read`, `write`, and `edit`
Tools plus an explicitly unsandboxed local `bash` Tool.

## Validation

```bash
pnpm run check
pnpm run test:packages
```

`check` runs the build, typecheck, lint, core acceptance tests, and the OpenTUI
smoke path. `test:packages` additionally verifies the same compiled artifacts in
clean npm, pnpm, Yarn, and Bun consumers. Generated packages and consumer
lockfiles remain temporary.

The JSONL Store is intended for one active local process. The SQLite adapter uses
Node's built-in `node:sqlite`, which remains experimental in the supported Node
runtime.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow.

## License

MIT
