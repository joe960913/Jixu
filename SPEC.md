# Jixu Single-Agent Harness Specification

**Version:** 0.4.0
**Status:** normative, pre-release
**Last updated:** 2026-08-19

## 1. Product definition

Jixu is a small TypeScript **single-Agent Harness**. An application defines one
Agent, creates or opens durable Threads, sends input, and observes model and Tool
work through one coherent API.

Jixu is designed for developers who want the directness of a small agent loop
without giving up durable execution, recovery, replay, or explicit side-effect
boundaries. Those reliability mechanisms belong underneath the ordinary Agent
experience; they are not extra frameworks that users must assemble.

The public promise is:

> Define one Agent. Give it Tools and Skills. Continue its work in a durable
> Thread.

- **JX-PROD-001.** A Harness MUST own exactly one immutable Agent definition.
- **JX-PROD-002.** A Thread MUST belong to that Agent for its entire lifetime.
- **JX-PROD-003.** Ordinary input MUST continue the selected Thread and trigger
  the Agent automatically.
- **JX-PROD-004.** Durability features MUST use the same Thread execution model
  as ordinary prompts; they MUST NOT introduce a workflow or orchestration
  runtime beside it.

## 2. Goals

1. Make the common path as small as `createHarness`, `createThread`, and
   `thread.send`.
2. Preserve multi-turn Agent context across process restarts.
3. Make externally observable work durable before dispatch.
4. Keep model providers, Tools, Stores, and user interfaces replaceable.
5. Support pause, continue, fork, clear, recovery, and replay without a second
   source of truth.
6. Keep the kernel deterministic, I/O-free, and easy to explain.
7. Provide an excellent reference TUI without coupling the Harness to OpenTUI.
8. Let the Agent create and revise a lightweight execution Plan when difficult
   work benefits from one, without imposing planning overhead on simple work.
9. Keep long-running work coherent across context windows through automatic,
   inspectable Continuity Handoffs rather than opaque summary replacement.

## 3. Non-goals

Jixu does not provide:

- multi-Agent orchestration, handoff, supervisors, swarms, or Agent graphs;
- Agent-as-Tool as a special primitive;
- a workflow DSL or a second execution engine for predetermined graphs;
- a mandatory Plan for every prompt, a user-facing Plan Mode in core, or a Plan
  that schedules Effects like a workflow;
- hosted control planes, queues, schedulers, billing, or telemetry services;
- hidden exactly-once claims;
- provider-owned conversation state as canonical state;
- provider-native compaction as the sole portable continuity record; or
- a separate Memory, Session, Conversation, Run, Job, or Task object for the
  same Thread lifecycle.

An application can call external systems through an ordinary Tool. That does
not make those systems Jixu Agents and does not change the single-Agent model.

## 4. Concept model

### 4.1 Public mental model

Normal developers need four concepts:

| Concept | Meaning |
| --- | --- |
| **Harness** | The configured entry point. It owns one Agent and binds that Agent to model Drivers, a Store, IDs, time, and Signals. |
| **Agent** | Immutable instructions, model selection, Tools, and Skill-derived instructional context. It is configuration, not execution state. |
| **Thread** | One durable, ordered history in which that Agent receives input, calls Tools, and replies over time. |
| **Tool** | A typed capability the Agent can invoke to act outside the model. |

`Skill` is an instructional input attached to the Agent. It does not own a
lifecycle, status, event log, or durable identity in the kernel.

### 4.2 Internal reliability model

The implementation uses these supporting terms:

| Term | Meaning |
| --- | --- |
| **Event** | An immutable durable fact accepted by a Thread. |
| **State** | The deterministic projection of a Thread's ordered Events. |
| **Reducer** | The pure function that maps State and Event to new State and Effects. |
| **Effect** | A typed request for external work. |
| **Driver** | An adapter that performs one Effect. |
| **Store** | Durable Event, immutable Artifact, and optional Checkpoint storage ports. |
| **Artifact** | Immutable content addressed by digest and referenced from an Event. |
| **Plan** | Optional Event-backed coordination data for one current objective. |
| **Continuity Handoff** | Immutable, validated context data accepted at a compaction boundary. |
| **Context Manifest** | A redacted record of which versioned sources formed one model request and why. |
| **Signal** | A transient observation such as a token delta or progress update. |
| **Checkpoint** | A disposable State cache used only to accelerate recovery. |

These terms are necessary to implement the guarantee, but ordinary callers MUST
NOT construct Events, invoke Reducers, or dispatch Effects.

### 4.3 Words that are not product concepts

- A **turn** is the causal span from one accepted user input until the Thread is
  ready for more input. It has no independent store, handle, or lifecycle.
- **Context** is the model-facing projection of Thread State and versioned
  sources. It is data, not a durable object or authority.
- A **Plan**, **Continuity Handoff**, and **Context Manifest** are typed data
  inside that model. They are not execution identities or public lifecycles.
- **Transcript**, **activity**, and **inspection** are UI projections.
- **Fork**, **replay**, **clear**, **pause**, and **continue** are operations on a
  Thread, not new runtime entities.
- `session`, `conversation`, `run`, `workflow`, `job`, and `task` MUST NOT be
  used as synonyms for Thread in public APIs or project documentation.

If a proposed noun overlaps an existing concept, simplify the design instead
of adding the noun.

## 5. Architecture

### 5.1 Dependency direction

```text
Application / reference TUI
            |
      Harness / Thread API
            |
     deterministic Kernel
       /            \
  Store port       Effect ports
                       |
             model / Tool Drivers
```

- Core defines domain data, the Reducer, ports, and the Harness/Thread API.
- Adapters depend on core ports. Core never imports adapters.
- A UI observes and controls Threads only through public APIs.
- Harness memory, UI state, provider state, and traces are never authority.

### 5.2 One authoritative path

Externally observable work follows exactly one path:

```text
durable Event -> pure Reducer -> explicit Effect -> Driver -> durable Event
```

- **JX-ARCH-001.** The ordered durable Event log is the sole authority for a
  Thread.
- **JX-ARCH-002.** State MUST be reproducible by reducing Events in order.
- **JX-ARCH-003.** An external Effect MUST be durably requested before Driver
  dispatch.
- **JX-ARCH-004.** Reducers MUST NOT perform I/O, read clocks, generate IDs, or
  call SDKs.
- **JX-ARCH-005.** Unknown Event types or schema versions MUST fail closed.
- **JX-ARCH-006.** Secrets MUST NOT enter Events, State, Checkpoints, errors, or
  Signals.

### 5.3 Harness coordination

The Harness is a coordinator, not durable authority. For each proposal it MUST:

1. validate the Event against the schema and current Thread revision;
2. append it with optimistic concurrency;
3. reduce committed Events into State;
4. expose committed Events and transient Signals to observers;
5. durably append every Effect request;
6. dispatch only accepted Effects; and
7. append the typed Driver outcome.

There MUST be only one Thread state machine and one Event history.

## 6. Thread lifecycle

### 6.1 Statuses

A Thread has one status:

| Status | Meaning |
| --- | --- |
| `idle` | Durable and ready to accept ordinary user input. |
| `running` | Processing accepted input or Tool results. |
| `waiting` | Blocked on a named external decision or indeterminate Effect. |
| `paused` | Administratively stopped at a safe dispatch boundary. |

When the accepted input queue is empty, the end of an Agent reply returns the
Thread to `idle`; it does not complete the Thread. Model or Tool failures are
durable turn outcomes and return the Thread to `idle` with `lastError`, unless an
indeterminate external outcome requires `waiting`.

- **JX-THREAD-001.** Creating a Thread MUST durably record its Agent snapshot
  before the Thread becomes visible.
- **JX-THREAD-002.** `send(input)` MUST accept non-empty input while `idle` or
  `running` and durably append it. Input accepted while `idle` starts the Agent
  automatically; input accepted while `running` is queued in Event order.
- **JX-THREAD-003.** A final model response with no Tool calls MUST start the
  next queued input automatically, or return the same Thread to `idle` when the
  queue is empty.
- **JX-THREAD-004.** A later `send` MUST provide the model the current compiled
  Thread context, logically representing prior accepted user, assistant, and
  Tool work after the most recent clear boundary according to §10.
- **JX-THREAD-005.** Concurrent state-changing operations on one Thread MUST be
  serialized or rejected with a typed error.
- **JX-THREAD-006.** `wait()` MUST resolve whenever the Thread is no longer
  `running`.
- **JX-THREAD-007.** Opening a Thread with a different Agent snapshot MUST fail
  closed.
- **JX-THREAD-008.** A failed turn MUST NOT silently discard the Thread's
  earlier context or create a replacement Thread.
- **JX-THREAD-013.** Accepted queued input MUST survive restart and be activated
  once in derived State in durable Event order; its external Effects retain the
  delivery guarantees in §8. `send` while `waiting` or `paused` MUST fail with a
  typed status error unless a separately specified operation satisfies the wait
  or continues the Thread.

`waiting` and `paused` are not synonyms. Waiting records a named condition;
paused records an explicit administrative stop.

### 6.2 Context clear

- **JX-THREAD-009.** `clear()` MUST retain the Thread ID and durable Event
  history while resetting model-facing messages, the active Plan, accepted
  Handoff projection, last result, and last error.
- **JX-THREAD-010.** Clear MUST be a durable Event and replay deterministically.
- **JX-THREAD-011.** Clear MUST be accepted only while `idle`.
- **JX-THREAD-012.** Clear MUST NOT create, fork, delete, or replace a Thread.

## 7. Event, State, and observation

### 7.1 Event envelope

Every Event contains:

```ts
interface ThreadEvent<TType extends string, TPayload> {
  id: string;
  threadId: string;
  sequence: number;
  type: TType;
  schemaVersion: number;
  timestamp: string;
  causationId?: string;
  correlationId?: string;
  payload: TPayload;
}
```

- **JX-EVT-001.** `(threadId, sequence)` MUST be unique and contiguous from 1.
- **JX-EVT-002.** Event IDs MUST be globally unique within one Store.
- **JX-EVT-003.** Persisted payloads MUST be JSON-serializable and versioned.
- **JX-EVT-004.** Events MUST be immutable after append.
- **JX-EVT-005.** Correlation metadata MAY group work but MUST NOT replace
  Thread or Event identity.

The v0.4 families are:

- `thread.created`
- `thread.forked`
- `thread.pause_requested`
- `thread.paused`
- `thread.continued`
- `thread.waiting`
- `input.received`
- `plan.updated`
- `context.cleared`
- `context.compaction_requested`
- `context.compacted`
- `context.compaction_failed`
- `model.requested`
- `model.completed`
- `model.failed`
- `tool.requested`
- `tool.completed`
- `tool.failed`

### 7.2 Signals

- **JX-SIG-001.** Signals MUST NOT affect State or correctness.
- **JX-SIG-002.** Signals MAY be dropped, duplicated, or reordered.
- **JX-SIG-003.** Provider token deltas and Tool progress MUST be Signals, not
  durable Events.
- **JX-SIG-004.** A live Thread stream MUST expose committed Events and Signals
  through one ordered observation surface without claiming Signals are durable.

## 8. Effects and Drivers

Every Effect carries `id`, `threadId`, `type`, `input`, and idempotency metadata.

- **JX-EFF-001.** The Reducer emits typed Effects but never executes them.
- **JX-EFF-002.** Drivers return typed success, failure, cancellation, or
  indeterminate outcomes.
- **JX-EFF-003.** Every outcome Event MUST causally reference its request.
- **JX-EFF-004.** A retry of the same logical Effect MUST preserve its
  idempotency identity.
- **JX-EFF-005.** Exactly-once behavior MUST NOT be claimed without an
  enforceable downstream idempotency contract.
- **JX-EFF-006.** Semantic context compaction MUST be a typed Effect handled by
  a compatible model or compaction Driver; it MUST NOT perform hidden I/O inside
  the Reducer or Context Compiler.

Jixu provides at-least-once dispatch for Effects declared idempotent. For
non-idempotent Effects whose durable outcome is unknown, recovery MUST enter
`waiting` rather than guess or silently repeat the action.

## 9. Continuity operations

### 9.1 Pause and continue

- **JX-CONT-001.** `pause()` MUST record intent and resolve only at a safe
  append/dispatch boundary.
- **JX-CONT-002.** `continue()` MUST accept only a paused Thread and durably
  return it to `running` before dispatch.
- **JX-CONT-003.** Opening an `idle` or `waiting` Thread MUST NOT append a
  continue Event.
- **JX-CONT-004.** An explicit pause MUST survive restart.

The word `resume` is reserved for selecting and opening a previous Thread in
the reference application. It is not a Thread lifecycle method.

### 9.2 Fork

- **JX-FORK-001.** Fork MUST create a new Thread ID.
- **JX-FORK-002.** The child MUST record parent Thread ID, parent Event ID, and
  parent sequence.
- **JX-FORK-003.** The parent MUST remain immutable.
- **JX-FORK-004.** The child MUST begin from the exact deterministic State at
  the selected Event, then reset in-flight work before accepting child input.
- **JX-FORK-005.** Child creation MUST be atomic; partial children MUST NOT
  become listable.

### 9.3 Replay

- **JX-REPLAY-001.** Replay MUST reduce durable Events only.
- **JX-REPLAY-002.** Replay MUST dispatch zero live Drivers.
- **JX-REPLAY-003.** Replay MUST reproduce the same State for the same supported
  Event sequence and Reducer version.
- **JX-REPLAY-004.** Re-execution with different inputs or models is a Fork,
  not replay.

## 10. Context engineering and continuity

Context is a bounded projection compiled for one model request. It is not the
Event log, a provider conversation, or another durable authority.

### 10.1 Autonomous execution Plan

An execution Plan helps the one Agent coordinate non-trivial work while the
ordinary model/Tool loop continues. It is distinct from a user-selected Plan
Mode, which is a surface policy outside the core specification.

- **JX-PLAN-001.** A Plan MUST be an optional projection of `plan.updated`
  Events inside one Thread State. It MUST NOT own a separate store, state
  machine, execution identity, or public lifecycle.
- **JX-PLAN-002.** Planning policy MUST support both direct execution with no
  Plan and autonomous Plan creation for work with dependent stages, material
  uncertainty, long recovery horizons, or explicit verification boundaries. A
  turn alone MUST NOT cause a ceremonial Plan to be created.
- **JX-PLAN-003.** Each Plan snapshot MUST be revisioned and contain one
  objective, acceptance criteria, a bounded ordered step list, step statuses,
  evidence references, assumptions or blockers, the next safe action, and one
  of `active`, `completed`, `superseded`, or `abandoned`. Step status MUST be
  `pending`, `in_progress`, `completed`, `blocked`, or `skipped`.
- **JX-PLAN-004.** A Thread MUST have at most one active Plan and one active
  step. New evidence MAY revise that Plan; a materially changed objective MUST
  supersede it instead of silently rewriting its history.
- **JX-PLAN-005.** A Plan MUST NOT authorize an action, widen user scope,
  dispatch or schedule an Effect, reserve compute, or bypass Policy. Only the
  ordinary Event/Reducer/Effect/Driver path may act.
- **JX-PLAN-006.** A model-proposed Plan change MUST be validated and committed
  as `plan.updated` before the new Plan projection is exposed to context or a
  surface and before Effects proposed by the same model output are dispatched.
- **JX-PLAN-007.** The active Plan MUST survive recovery and be eligible for
  every subsequent model context and Continuity Handoff. Completed,
  superseded, and abandoned Plans remain inspectable in Events but MUST be
  excluded from default model context.

### 10.2 Context compilation and manifest

The Context Compiler selects from immutable Agent material, Thread Events after
the active clear boundary, the active Plan, the latest accepted Continuity
Handoff after that boundary, activated Skills, exposed Tool schemas, immutable
Artifacts or workspace snapshots, and external knowledge already materialized
through an Effect.

- **JX-CTX-001.** Compilation MUST be deterministic for the same Agent revision,
  Thread State and source revisions, model capability profile, Context Policy,
  token budget, and compiler version.
- **JX-CTX-002.** Every candidate source MUST carry provenance, version or
  digest, trust and sensitivity metadata, priority, estimated cost, and causal
  source. Secret values MUST NOT be context metadata.
- **JX-CTX-003.** Every `model.requested` Event MUST contain a redacted Context
  Manifest that records included and excluded source identities and reasons,
  active clear boundary, Agent and compiler versions, active Plan revision,
  accepted Handoff digest, recent raw-tail boundary, activated Skills, exposed
  Tool schemas, input and output budgets, and a logical request digest.
- **JX-CTX-004.** Deterministic hygiene MAY deduplicate content, omit stale
  capability metadata, or replace large Tool output with an Artifact reference.
  It MUST NOT mutate or delete the source Event or Artifact.

### 10.3 Adaptive compaction and Continuity Handoff

Compaction is an automatic representation change, not an ordinary chat summary.
It hands enough verified work state to a future model request that execution can
continue safely without treating the compacted text as Thread authority.

- **JX-CTX-005.** Before each model request, Context Policy MUST estimate
  assembled input, projected next model and Tool material, reserved model
  output, and a safety margin against the model context limit. If the budget is
  at risk after hygiene, it MUST request compaction at the next safe boundary.
  It MAY compact at a completed phase boundary when expected savings justify
  the cost.
- **JX-CTX-006.** A compaction boundary MUST NOT split a model item, Tool
  call/result pair, approval, or other causally complete operation.
- **JX-CTX-007.** `context.compaction_requested` MUST durably request a typed
  compaction Effect before Driver dispatch. Success or failure MUST be recorded
  as `context.compacted` or `context.compaction_failed`.
- **JX-CTX-008.** A Continuity Handoff MUST be immutable, schema-versioned,
  redacted, source-linked, and validated before acceptance. Its Artifact MUST
  exist and verify by digest before `context.compacted` references it.
- **JX-CTX-009.** An accepted Handoff MUST preserve the current objective and
  acceptance criteria; scope, constraints, and permissions; active Plan and
  completed-step evidence; current State, pending Effects, waits, approvals,
  and unresolved questions; decisions and rejected alternatives; failures,
  attempted approaches, and do-not-retry guidance; relevant files, Artifacts,
  snapshots, and validation; blockers and exact next safe action; and source
  Event range, clear boundary, schema/compiler/model versions, and digests.
  Authorization-related fields MUST reference committed Policy decisions; the
  Handoff's semantic body MUST NOT grant permission.
- **JX-CTX-010.** Context after compaction MUST contain immutable Agent material,
  the latest accepted Handoff, the active Plan, and a bounded tail of recent
  complete raw operations, plus other currently relevant sources. The raw tail
  MUST preserve complete Tool call/result pairs.
- **JX-CTX-011.** A failed, invalid, missing, or digest-mismatched Handoff MUST
  leave the previous context projection active. Compaction MUST NOT delete or
  rewrite raw Events or Artifacts.
- **JX-CTX-012.** Repeated compaction MUST merge, deduplicate, and reconcile
  source-linked facts rather than summarize an untraceable summary. A
  provider-native opaque compaction item MAY be retained as an optimization but
  MUST NOT be the sole portable Handoff or Thread authority.
- **JX-CTX-013.** Clear and compaction MUST remain distinct. Clear advances the
  explicit model-visible boundary inside the same Thread; compaction preserves
  the current objective while changing only its representation.

## 11. Agent capabilities

### 11.1 Tools

- **JX-TOOL-001.** Tool names MUST be unique within the Agent.
- **JX-TOOL-002.** Tool inputs and outputs MUST be schema-versioned and
  JSON-serializable at the durable boundary.
- **JX-TOOL-003.** Tool execution occurs only through a Driver.
- **JX-TOOL-004.** Tool implementations MUST declare idempotency honestly.
- **JX-TOOL-005.** Credentials remain behind the Driver boundary.

### 11.2 Skills

- **JX-SKILL-001.** Skills supply instructional context; they do not execute
  Effects.
- **JX-SKILL-002.** The Agent snapshot MUST record the Skill catalogue metadata
  and digests required to detect incompatible recovery, without storing secrets
  or eagerly embedding every Skill body.
- **JX-SKILL-003.** Skill content MUST be activated progressively. Its version
  and digest MUST be materialized before the content enters a model request or
  Continuity Handoff.

### 11.3 MCP and providers

- MCP Tools MUST adapt to ordinary Tool descriptors and Driver execution.
- Model providers MUST adapt to the model Driver port.
- Neither MCP nor a provider may introduce a second Thread state machine.
- Provider conversation IDs MAY be correlation metadata only.

## 12. Storage and recovery

The Store contract supports:

- atomic Thread creation;
- optimistic Event append;
- ordered Event reads;
- listing Thread IDs;
- atomic Fork creation;
- immutable Artifact writes and digest-verified reads; and
- optional Checkpoint reads and writes.

- **JX-STORE-001.** Thread State recovery MUST work from Events alone.
  Referenced Artifact bytes are verified separately and MUST NOT decide State.
- **JX-STORE-002.** Checkpoints MUST be disposable and validated against their
  matching Event and State digest.
- **JX-STORE-003.** Missing, stale, corrupt, or incompatible Checkpoints MUST be
  ignored in favor of Event replay.
- **JX-STORE-004.** Event append MUST reject revision conflicts.
- **JX-STORE-005.** Thread listing MUST be derived from the Store; the reference
  application MUST NOT maintain a second conversation/session index.
- **JX-STORE-006.** Recovery MUST distinguish ready Effects from already
  dispatched pending Effects.
- **JX-STORE-007.** Unknown persisted data MUST fail closed with a typed error.
- **JX-STORE-008.** An Event that references an Artifact MUST be appended only
  after that Artifact exists durably and verifies under the recorded digest.

## 13. Public API

The target API is intentionally small:

```ts
const agent = defineAgent({
  instructions: "Be precise.",
  model: { provider: "provider", model: "model-name" },
  tools: [readFile],
});

const harness = createHarness({
  agent,
  modelDrivers: { provider: modelDriver },
  store,
});

const thread = await harness.createThread();
await thread.send("Compare these three companies.");
await thread.send("Now challenge the strongest assumption.");

const reopened = await harness.openThread(thread.id);
const threads = await harness.listThreads();
```

The public Harness exposes:

- `createThread()`
- `openThread(id)`
- `listThreads()`

A Thread exposes:

- `id`
- `send(input)`
- `clear()`
- `events()`
- `state()`
- `stream()`
- `wait()`
- `pause()`
- `continue()`
- `fork({ at, input })`
- `replay()`

- **JX-API-001.** The ordinary path MUST NOT expose Store transactions, Event
  construction, Reducers, or Effect dispatch.
- **JX-API-002.** Harness configuration MUST bind exactly one Agent.
- **JX-API-003.** Public errors MUST be typed and include Thread and Effect
  identity where relevant.
- **JX-API-004.** Observation APIs MUST be usable without a UI framework.
- **JX-API-005.** No compatibility alias for Runtime, Run, Session, or
  Conversation may be introduced during the pre-release rename.

## 14. Reference TUI

The TUI is a first-party application of the same public Harness API. It does
not own execution truth.

- **JX-TUI-001.** First launch without credentials MUST enter the ordinary
  workspace and show `Model not configured` plus `use /config`; it MUST NOT
  force a setup page.
- **JX-TUI-002.** A non-command prompt without a complete model configuration
  MUST be rejected without creating a Thread.
- **JX-TUI-003.** Typing `/` or a command prefix MUST open a filtered menu above
  the composer. Up/Down select, Enter accepts, and Escape closes it.
- **JX-TUI-004.** Command metadata MUST have one typed source of truth shared by
  help, completion, and dispatch.
- **JX-TUI-005.** The composer help area MAY use multiple lines and Nippon-color
  tokens to express hierarchy instead of compressing unrelated information.
- **JX-TUI-006.** Normal input MUST call `send` on the selected Thread.
- **JX-TUI-007.** `/clear` MUST clear the selected Thread's context and visible
  transcript without changing its ID.
- **JX-TUI-008.** `/new` MUST create and select one empty Thread.
- **JX-TUI-009.** `/resume` MUST open a keyboard-selectable list from
  `harness.listThreads()` and select a compatible Thread. It MUST NOT continue a
  paused Thread.
- **JX-TUI-010.** `/continue` MUST continue only a paused Thread.
- **JX-TUI-011.** `/fork` MUST create and select a distinct child Thread with
  explicit lineage.
- **JX-TUI-012.** `/events`, `/state`, and `/replay` MUST inspect durable data
  through Thread APIs.
- **JX-TUI-013.** TUI orchestration, command metadata, transcript projection,
  screen layout, and configuration MUST remain separate modules; no catch-all
  UI source file may own all of them.

Configuration stores credentials separately from non-secret settings, uses
restrictive POSIX permissions, and never records secrets in Thread data.

## 15. Security

- **JX-SEC-001.** Secrets MUST remain behind configuration and Driver
  boundaries.
- **JX-SEC-002.** Errors MUST be sanitized before durable append.
- **JX-SEC-003.** Unknown Tools are rejected before dispatch.
- **JX-SEC-004.** Local file Tools MUST enforce their documented workspace
  boundary.
- **JX-SEC-005.** Unsandboxed shell execution MUST be opt-in and visibly
  disclosed.
- **JX-SEC-006.** Stored credentials MUST be written atomically and, on POSIX,
  with user-only permissions.

## 16. Package boundaries

| Package | Responsibility |
| --- | --- |
| `@jixu/core` | Agent definition, deterministic kernel, ports, Harness, and Thread API. |
| `@jixu/llm` | Model Driver adapters. |
| `@jixu/store-jsonl` | Inspectable local JSONL Store. |
| `@jixu/store-sqlite` | Local SQLite Store. |
| `@jixu/tools-node` | Opt-in Node file and shell Tools. |
| `@jixu/testkit` | Store and Driver contract suites. |
| `jixu` | Public facade, CLI, configuration, and reference TUI. |

Core MUST remain free of provider SDKs, MCP SDKs, database drivers, web
frameworks, and UI frameworks.

## 17. Acceptance criteria

- **JX-AC-001 — Single-turn success.** One input durably requests a model,
  executes requested Tools, records outcomes, returns a final reply, and leaves
  the same Thread `idle`.
- **JX-AC-002 — Multi-turn continuity.** Two sequential `send` calls use one
  Thread ID; the second model request represents the first complete turn either
  as raw context or through an accepted Handoff and raw tail.
- **JX-AC-003 — Durable clear.** After `clear`, the Thread ID and old Events
  remain, while subsequent model context excludes messages, Plan, and Handoff
  projection from before the clear.
- **JX-AC-004 — Crash recovery.** Recovery after an accepted Effect request
  resumes only work allowed by its delivery contract.
- **JX-AC-005 — Indeterminate Tool outcome.** An unknown non-idempotent outcome
  enters `waiting` and is not repeated automatically.
- **JX-AC-006 — Fork.** Forking at Event N creates an atomic child Thread with
  exact parent State at N and leaves the parent unchanged.
- **JX-AC-007 — Replay safety.** Replay invokes zero live Drivers and reproduces
  State.
- **JX-AC-008 — Checkpoint disposal.** Missing, stale, corrupt, and incompatible
  Checkpoints all recover the same State from Events.
- **JX-AC-009 — Pause and continue.** Pause settles at a safe boundary,
  survives restart, and only explicit continue restarts dispatch.
- **JX-AC-010 — Failed turn continuity.** A typed model or Tool failure is
  durable and does not erase earlier Thread context.
- **JX-AC-011 — Unknown Event.** Unsupported persisted data fails closed.
- **JX-AC-012 — Concurrency rejection.** Conflicting writers cannot both commit
  the same next sequence.
- **JX-AC-013 — Store contracts.** Every Store adapter passes the same creation,
  append, list, read, Fork, immutable Artifact, and Checkpoint contract suite.
- **JX-AC-014 — Minimal public path.** A developer can define one Agent, create
  one Harness, create one Thread, define one Tool, and complete two messages
  without constructing internal runtime objects.
- **JX-AC-015 — Runnable reference Harness.** The TUI runs the same public
  Agent/Harness/Thread path with live Signals and first-party Node Tools.
- **JX-AC-016 — Provider boundary.** Responses- and Chat-Completions-compatible
  endpoints map into the same model Driver contract without fallback duplicate
  dispatch.
- **JX-AC-017 — Package portability.** Clean npm, pnpm, Yarn, and Bun consumers
  import the same artifacts and execute the documented public path on Node.
- **JX-AC-018 — TUI Thread controls.** Slash completion, multi-turn send,
  `/clear`, `/new`, `/resume`, `/continue`, `/fork`, and inspection commands
  exercise the public Thread API with keyboard-accessible interaction.
- **JX-AC-019 — Single-Agent boundary.** No public API, Event, State, package, or
  reference UI introduces multi-Agent orchestration or Agent handoff.
- **JX-AC-020 — Input during execution.** Input sent while a Thread is running
  is durable before acknowledgement, survives restart, and starts automatically
  in Event order after the current turn reaches a safe boundary.
- **JX-AC-021 — Adaptive Plan lifecycle.** A deterministic scenario can proceed
  with no Plan, while a non-trivial scenario can create, revise, complete, and
  supersede a Plan through `plan.updated`; no State can contain two active Plans
  or two active steps.
- **JX-AC-022 — Plan safety and recovery.** Plan changes dispatch no Effects and
  grant no permission. An active Plan survives recovery and enters context and
  a Handoff; historical inactive Plans remain inspectable but leave default
  context.
- **JX-AC-023 — Safe automatic compaction.** Budget pressure requests compaction
  before context exhaustion, never splits a complete model or Tool operation,
  and resumes with the accepted Handoff plus a bounded complete raw tail.
- **JX-AC-024 — Handoff fidelity.** Across at least two compactions, objective,
  constraints, decisions, completed evidence, failures and do-not-retry notes,
  active Plan, pending Effects, relevant Artifacts, validation, and next action
  remain source-linked and usable.
- **JX-AC-025 — Compaction failure safety.** Driver failure, invalid schema,
  missing Artifact, or digest mismatch records a typed failure and leaves the
  previous context projection active with all raw Events intact.
- **JX-AC-026 — Portable continuity.** When a provider emits an opaque
  compaction item, a compatible different model Driver can still reconstruct
  the logical working set from Jixu's structured Handoff, Events, and Artifacts.
- **JX-AC-027 — Context explainability.** Every model request has a redacted
  Context Manifest that accounts for included, transformed, and excluded
  sources, Plan and Handoff revisions, raw-tail boundary, schema versions,
  budgets, and logical request digest.

The minimum validation for a code change is targeted tests, typecheck, lint, and
`git diff --check`. Release work also runs the complete acceptance suite and
package portability checks.

## 18. Compatibility and migration

This is an intentional pre-release breaking correction. The old public model
treated one prompt as a terminal Run and then attempted to add Conversation and
Session objects around it. That produced duplicate lifecycle concepts and did
not match normal Agent interaction.

The migration is:

| Removed | Replacement |
| --- | --- |
| `Runtime` | `Harness` |
| `Run` / `RunHandle` | `Thread` |
| `runtime.run(agent, input)` | `harness.createThread()` then `thread.send(input)` |
| `runtime.recover(agent, id)` | `harness.openThread(id)` |
| `run.resume()` | `thread.continue()` |
| `Conversation` or `Session` index | `harness.listThreads()` from the Store |

Existing `JX-RUN-*` requirements are deprecated and replaced by
`JX-THREAD-*`. Existing `run.*` Event names and `runId` fields are pre-release
data and are replaced by `thread.*` and `threadId`; no automatic migration is
promised before the first published stable version.

The previously drafted `JX-TUI-010A` Conversation index is withdrawn. It was
never an accepted architectural requirement and MUST NOT be implemented.

Version 0.4 adds `plan.updated` and the `context.compaction_*` Event family,
Context Manifests, immutable Handoff Artifacts, and running-input queue semantics
to the pre-release design. These are not aliases for old Run or Session data.
Persisted 0.3 drafts without explicit compatible upcasters MUST fail closed; no
automatic migration is promised before the first stable release.

## 19. Implementation order

1. Reconcile public and durable Runtime/Run remnants to Harness/Thread and keep
   exactly one Agent and one Event authority.
2. Complete Thread creation, ordered running-input queueing, durable clear,
   Store-backed listing, and open/recovery.
3. Add the revisioned active Plan projection and typed model control output,
   without adding a public Plan lifecycle or Effect scheduler.
4. Add versioned context sources, deterministic compilation, Context Manifests,
   immutable Handoff Artifacts, and adaptive safe-boundary compaction.
5. Align progressive Skills, Tool disclosure, policy, model adapters, and the
   reference TUI with the same Context and Thread path.
6. Run targeted acceptance, Store and Driver contracts, typecheck, lint,
   package portability, and the ordinary public Harness path.

Later capabilities such as more model adapters, MCP Tools, approvals, richer
observation, and deployment coordinators MUST extend this same single-Agent
Thread model.
