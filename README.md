# Jixu

**Pick up where you left off.**

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

`@jixu/llm` exposes one protocol selector with two supported values:
`openai-chat-completions` for any Tool-calling OpenAI-compatible Chat
Completions endpoint, and `anthropic-messages` for Anthropic Messages.

```ts
import { createLLMModelDriver } from "@jixu/llm";

const driver = createLLMModelDriver({
  api: "openai-chat-completions",
  apiKey: process.env.MODEL_API_KEY,
  baseURL: "https://api.example.com/v1",
});
```

Both paths normalize streaming text, client-side Tool calls, Plan/progress
controls, typed failures, and usage. The first-party clients perform no hidden
retry or protocol fallback; Jixu's durable Effect path owns retry attempts.
OpenAI Responses is not part of this boundary.

## Reference TUI

Prerequisites: Node.js 22.19+ for the workspace and Bun 1.3+ for the source TUI.

```bash
pnpm install
pnpm dev
```

The first launch enters the ordinary workspace even without credentials. It
shows `Model not configured` and `use /config`; setup is never a forced gate.
The endpoint can implement OpenAI-compatible `/v1/chat/completions` or
Anthropic `/v1/messages` with client-side Tool calling.
Jixu is local BYOK. Model credentials, Tool credentials, endpoint configuration,
and Tool policy live in `~/.jixu/settings.json` using settings schema version 5
with restrictive POSIX permissions. Existing schema v3/v4 settings and the
legacy schema v3 `auth.json` are consolidated in place without a backup; the
migration preserves the prior Tool selection, file reach, and permission policy,
then removes `auth.json`. Pre-release schema versions 1 and 2 are not migrated;
re-enter the connection through `/config`.

Jina-backed Web Search is a first-party Tool. Enable `web_search` and add the
raw Jina key without a `Bearer ` prefix:

```json
{
  "version": 5,
  "connection": {
    "api": "openai-chat-completions",
    "apiKey": "your-model-key",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "your-model"
  },
  "tools": {
    "enabled": ["read", "write", "edit", "bash", "web_search"],
    "fileScope": "workspace",
    "permissions": { "profile": "balanced", "rules": [] },
    "webSearch": { "provider": "jina", "apiKey": "your-jina-key" }
  }
}
```

Configuration changes apply to the immutable Agent used by Threads created
after restarting Jixu. If the Jina key is absent, `web_search` performs no
network request and points to this settings field.
The footer shows the selected Thread's known USD cost; `USD —` means no trusted
price is available, and a trailing `+` marks a known partial total.

On a wide terminal, the transcript stays dominant beside an always-present
Attention Rail. `NOW`, `PLAN`, `VERIFIED`, and `NEEDS YOU` summarize observable
work without replacing the durable Event log. Simple work explicitly shows
`Direct execution`; a real active Plan additionally opens a bounded horizontal
strip above the Composer. Compact terminals keep the same meanings in a
two-line attention strip. Attention sections and Tool receipts use portable
one-cell Unicode markers in a fixed two-column text gutter. The adjacent label
is always the semantic authority. The normal OpenTUI text path is used, so
custom drawing surfaces, Nerd Fonts, Kitty, Sixel, encoded images, DPI, and
image scaling are not involved. `/events` remains the raw ordered inspection
surface.

Normal prompts continue the selected Thread. Useful controls are:

- `/new` creates and selects an empty Thread;
- `/clear` clears the selected Thread context without changing its ID;
- `/resume` opens a keyboard-selectable list of previous Threads;
- `/pause` and `/continue` control a Thread at durable dispatch boundaries;
- `/approve` allows the waiting Tool call once and `/deny` rejects it;
- `/fork <event-id> <input>` creates a child Thread with explicit lineage;
- `/events`, `/state`, and `/replay` inspect durable behavior; and
- `/config`, `/help`, and `/quit` manage the local application.

Typing `/` or a command prefix opens a filtered menu above the composer. Use Up
and Down to select, Escape to close, and Enter to invoke or insert a command.

`/config` includes a Tool Center backed by the executable Agent catalogue. It
enables or disables first-party Tools and applies ordered `allow`, `ask`, or
`deny` rules before Driver dispatch; the last matching action/resource rule wins.
`balanced` allows the three file Tools and asks for `bash`, `review` only allows
`read` by default, and `unrestricted` allows every enabled Tool. An `ask`
decision is an Event-backed waiting boundary and survives restart.

`@jixu/tools-node` keeps `read`, `write`, and `edit` workspace-bounded by
default. The Tool Center can deliberately restore process-level file reach.
`bash` always remains an unsandboxed local process Tool; permission policy
controls whether Jixu dispatches it but does not create an OS sandbox. The
footer therefore reports the enabled Tool names, the current file scope, and
the separate `BASH process` boundary.

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
