# Jixu Core Runtime Specification

| Field | Value |
| --- | --- |
| Version | `0.2.6` |
| Status | M2 Active — experiential acceptance pending |
| Updated | 2026-08-18 |
| Target | Jixu v0.1 |

This document is the normative specification for Jixu. When prose, examples,
tests, and implementation disagree, this document wins until it is deliberately
changed through the process in §15.

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative.

## 1. Product definition

Jixu is an embeddable TypeScript runtime that owns the durable execution
lifecycle of an AI agent run.

Jixu is not defined by a chat UI, a workflow editor, a hosted control plane, a
memory product, or a new tool protocol. Applications bring those surfaces. Jixu
provides the small execution kernel underneath them.

The public promise is:

> A Jixu run can pause, survive interruption, resume, fork with explicit
> lineage, and replay without repeating external side effects.

## 2. Goals

- **JX-GOAL-001 — Small kernel.** The execution semantics MUST remain readable
  and auditable without understanding provider, UI, database, or deployment
  code.
- **JX-GOAL-002 — Durable runs.** A committed run MUST be recoverable after
  process interruption from its durable events.
- **JX-GOAL-003 — Explicit effects.** Model calls, tool calls, approvals, and
  timers MUST cross an explicit Effect/Driver boundary.
- **JX-GOAL-004 — Safe replay.** Replaying a run MUST NOT call models, tools, or
  other external systems.
- **JX-GOAL-005 — Explicit forks.** Forking MUST create a new run with durable
  parent lineage and an immutable fork point.
- **JX-GOAL-006 — Ecosystem-native.** Jixu MUST support ordinary typed tools,
  MCP tools, and Agent Skills without replacing their protocols.
- **JX-GOAL-007 — Testability.** Complete agent behavior MUST be testable with
  deterministic IDs, time, model outputs, and tool outputs.
- **JX-GOAL-008 — Embeddability.** The core MUST NOT require a web server,
  database service, container runtime, or Jixu cloud account.

## 3. Non-goals for v0.1

- **JX-NOGOAL-001.** A drag-and-drop workflow or graph authoring product.
- **JX-NOGOAL-002.** A vector database or autonomous long-term memory system.
- **JX-NOGOAL-003.** A replacement for MCP, Agent Skills, provider SDKs, or
  application-specific tools.
- **JX-NOGOAL-004.** A hosted multi-tenant platform or observability SaaS.
- **JX-NOGOAL-005.** Distributed active-active execution of one run.
- **JX-NOGOAL-006.** General multi-agent planning. Future subagents will compose
  the same Run primitive instead of adding a second execution model.
- **JX-NOGOAL-007.** Exactly-once delivery across external systems that do not
  support idempotency.
- **JX-NOGOAL-008.** Provider-specific conversation state as runtime authority.

## 4. Design principles

### 4.1 One authority

The ordered durable event log is the sole authority for a Run. In-memory state,
checkpoints, UI state, traces, and streamed tokens are projections or caches.
They MUST NOT become competing sources of truth.

### 4.2 One execution model

All externally observable work follows the same path:

```text
Event -> Reducer -> Effect -> Driver -> Event
```

Special cases MUST NOT bypass this path for convenience.

### 4.3 Plain data at boundaries

Durable Events, State, Effect requests, and Effect outcomes MUST be serializable
and schema-versioned. Runtime behavior MUST NOT depend on hidden closures or
provider-owned mutable objects.

### 4.4 Progressive complexity

Developers SHOULD be able to run a simple tool-using Agent without learning
event sourcing. Durability, fork, replay, custom stores, and policies become
visible only when used.

### 4.5 Honest guarantees

Jixu MUST distinguish a guarantee it can enforce locally from a guarantee that
requires cooperation from a Tool or provider. The runtime MUST expose an
indeterminate outcome instead of claiming exactly-once execution when it cannot
prove it.

### 4.6 Executable acceptance

A milestone that changes developer-facing behavior MUST provide a runnable
acceptance path. Unit and contract tests are necessary evidence, but they do not
by themselves prove that a developer can install, start, observe, and control a
real Agent. Reference surfaces MAY expose advanced internals progressively;
they MUST NOT introduce a second Agent type or a second execution model.

## 5. Canonical terminology

These terms are exclusive. New code and documentation MUST NOT introduce a
synonym for an existing concept.

| Term | Definition |
| --- | --- |
| **Agent** | An immutable definition containing instructions, model selection, Tools, Skills, and policy. It is configuration, not live execution. |
| **Runtime** | The live coordinator that binds a Store and Drivers to the Kernel, starts and recovers Runs, and dispatches Effects. Runtime memory is not durable authority. |
| **Run** | One durable execution instance of an Agent. Lifecycle, lineage, Events, and derived State belong to a Run. |
| **Kernel** | The I/O-free domain logic that validates transitions, reduces Events, and determines Effects. |
| **Event** | An immutable, durable fact already accepted by the Run. Events are authoritative and ordered. |
| **Signal** | A transient observation such as a model token delta or progress update. Signals are not authoritative and are not required for recovery. |
| **State** | The deterministic projection produced by reducing a Run's Events in order. State is derived, never independently authoritative. |
| **Reducer** | A pure function that applies one Event to State and determines the next State and requested Effects. |
| **Effect** | A serializable request for work outside the pure Reducer, such as a model call or Tool call. |
| **Driver** | An adapter that performs one Effect and reports its outcome as a new Event. |
| **Tool** | A typed capability an Agent may invoke. A Tool can act; it is not instructional context. |
| **Skill** | Versioned instructional context and resources loaded progressively. A Skill does not execute actions. |
| **Provider** | A model-specific Driver adapter. Provider conversation state is never Run authority. |
| **Store** | A persistence adapter for durable Events and optional Checkpoints. |
| **Checkpoint** | A disposable performance snapshot derived from Events. It may accelerate recovery but may always be rebuilt. |
| **Policy** | Deterministic runtime rules for approval, retry, limits, and permission decisions. |
| **Fork** | The operation that creates a new Run from the State at an Event in a parent Run. A fork is not a second kind of Run. |
| **Replay** | Purely reducing recorded Events to reconstruct State and outputs. Replay performs no Effects. |

The core MUST NOT use `session`, `thread`, `workflow`, `job`, or `task` as a
synonym for Run. Applications MAY use those words for their own concepts if the
mapping to Run is explicit at the boundary.

## 6. Architecture

### 6.1 Dependency direction

```text
Application API
      |
      v
Runtime / Agent / Run facade
      |
      v
Jixu Kernel  <------- Testkit
      |
      +------ Store port ------ JSONL / SQLite
      +------ Model port ------ OpenAI / Anthropic
      +------ Tool port ------- Local Tool / MCP
      +------ Runtime ports --- Clock / IDs / Signals
```

- The Kernel MAY depend only on core types and declared ports.
- Adapters depend on the Kernel; the Kernel MUST NOT import adapters.
- Provider, MCP, Skill loader, Store, CLI, and UI code MUST remain outside the
  Kernel package.
- The high-level API MAY compose adapters but MUST NOT weaken Kernel invariants.
- A reference TUI MAY observe and control a Run only through public Runtime and
  Run APIs. UI state is never Run authority.

### 6.2 Kernel transition

Conceptually, the Kernel exposes a pure transition:

```ts
type Transition = (
  state: RunState,
  event: RunEvent,
) => {
  state: RunState;
  effects: EffectRequest[];
};
```

The concrete API MAY differ, but the purity boundary MUST remain testable.

### 6.3 Runtime coordination

For each accepted input or Effect outcome, the runtime MUST:

1. validate the proposed Event against its schema and current Run revision;
2. append the Event durably;
3. reduce the committed Event into State;
4. identify newly requested Effects;
5. append an Effect-requested Event before dispatching an external Effect;
6. dispatch through the matching Driver; and
7. append exactly one known outcome Event when the outcome is known.

An external call MUST NOT occur before its request is durably represented.

### 6.4 Ready and pending Effects

The derived `RunState` MUST distinguish two Effect states:

- `readyEffects` are Effects deterministically produced by the latest committed
  Event but not yet represented by a `*.requested` Event; and
- `pendingEffects` are durably requested Effects without a known outcome Event.

`readyEffects` are not a second queue or source of truth. They MUST be rebuilt
by reducing Events. A matching request Event moves an Effect from ready to
pending. A known outcome Event removes it from pending and MAY produce new ready
Effects.

- **JX-EFF-008.** Recovery after a stop between an outcome Event and the next
  request Event MUST rediscover the same ready Effects from the Event log.
- **JX-EFF-009.** Retrying one logical Effect MUST preserve its Effect ID and
  idempotency key, increment `attempt`, and append another matching request
  Event before dispatch.

## 7. Run lifecycle

### 7.1 Statuses

A Run has exactly one status:

| Status | Meaning |
| --- | --- |
| `created` | The Run exists durably but execution has not begun. |
| `running` | The runtime may reduce Events and dispatch Effects. |
| `waiting` | The Run requires an external input, approval, timer, or intervention before it can continue. |
| `paused` | A user or controlling application intentionally stopped dispatch of new Effects. |
| `completed` | The Run finished successfully. Terminal. |
| `failed` | The Run ended with an unrecoverable error. Terminal. |
| `cancelled` | The controlling application ended the Run. Terminal. |

`waiting` and `paused` are not synonyms. A waiting Run is blocked on a named
condition. A paused Run is administratively stopped even if inputs are
available.

### 7.2 Lifecycle requirements

- **JX-RUN-001.** Every status change MUST be caused by a durable Event.
- **JX-RUN-002.** Terminal Runs MUST reject new execution inputs. They MAY be
  replayed or used as fork parents.
- **JX-RUN-003.** Pausing MUST stop dispatch of new Effects after the current
  atomic append/dispatch boundary. It MUST NOT erase pending Effects.
- **JX-RUN-004.** Resuming MUST rebuild State from the latest valid Checkpoint
  plus later Events, or from all Events when no Checkpoint exists.
- **JX-RUN-005.** Cancellation MUST request cancellation from active Drivers,
  but MUST record outcomes that arrive after cancellation as late outcomes
  without returning the Run to `running`.
- **JX-RUN-006.** A Run MUST expose why it is `waiting` using a stable reason
  code and associated Effect or approval identifier.
- **JX-RUN-007.** `runtime.run()` MUST resolve after `run.created` and the
  initial `input.received` Event commit. Execution MAY continue asynchronously.
  `run.wait()` MUST resolve when the Run becomes terminal, `paused`, or
  `waiting`, and MUST reject when the local execution coordinator stops on an
  infrastructure error.

## 8. Event model

### 8.1 Event envelope

Every durable Event MUST contain:

```ts
interface RunEvent<TType extends string, TPayload> {
  id: string;
  runId: string;
  sequence: number;
  type: TType;
  timestamp: string;
  schemaVersion: number;
  causationId?: string;
  correlationId?: string;
  payload: TPayload;
}
```

- **JX-EVT-001.** `sequence` MUST be contiguous and strictly increasing within
  one Run.
- **JX-EVT-002.** Event IDs MUST be globally unique within one Store.
- **JX-EVT-003.** An Event MUST be immutable after append.
- **JX-EVT-004.** Event appends MUST use expected-revision concurrency control.
- **JX-EVT-005.** Unknown event types or unsupported schema versions MUST fail
  closed with a diagnostic; they MUST NOT be silently ignored.
- **JX-EVT-006.** Durable payloads MUST be serializable without executable
  closures, streams, SDK clients, or secret-bearing runtime objects.

### 8.2 Event families

The v0.1 event vocabulary will include these stable families:

```text
run.*
input.*
model.*
tool.*
approval.*
timer.*
```

Concrete events include request and known outcome pairs such as
`model.requested` / `model.completed` / `model.failed` and
`tool.requested` / `tool.completed` / `tool.failed`.

Event names describe facts in past tense. An imperative such as `tool.execute`
is an Effect type, not an Event type.

M2 adds these Run lifecycle Events:

```text
run.pause_requested
run.paused
run.resumed
run.waiting
run.forked
```

- `run.pause_requested` records durable control intent without discarding
  already requested Effects.
- `run.paused` records that the Runtime reached an append/dispatch boundary and
  will dispatch no new Effect.
- `run.resumed` returns an explicitly paused Run to `running` before dispatch.
- `run.waiting` records a stable reason code and related Effect identity.
- `run.forked` records parent lineage after the copied parent Event prefix.

### 8.3 Signals

- **JX-SIG-001.** Model token deltas, Tool progress, and runtime diagnostics MAY
  be emitted as Signals.
- **JX-SIG-002.** A Reducer MUST NOT require a Signal to reconstruct State.
- **JX-SIG-003.** Losing, duplicating, or reconnecting a Signal stream MUST NOT
  change Run correctness.
- **JX-SIG-004.** Final authoritative model and Tool outputs MUST be Events even
  when their intermediate data was streamed as Signals.
- **JX-SIG-005.** A live Run stream MUST expose committed Events and transient
  Signals as a single discriminated observation stream without making that
  stream a second durable history. Reconnecting MAY replay durable Events;
  Signals missed while disconnected are not recoverable.

## 9. Effects and Drivers

### 9.1 Effect envelope

Every Effect request MUST include:

```ts
interface EffectRequest<TType extends string, TInput> {
  id: string;
  runId: string;
  type: TType;
  input: TInput;
  idempotencyKey: string;
  requestedByEventId: string;
  attempt: number;
}
```

The initial v0.1 Effect types are:

- `model.generate`
- `tool.execute`
- `approval.await`
- `timer.sleep`

### 9.2 Effect requirements

- **JX-EFF-001.** Every Effect MUST be caused by a committed Event.
- **JX-EFF-002.** A Driver MUST receive a stable idempotency key across retries
  of the same logical Effect.
- **JX-EFF-003.** A Driver MUST return a typed success, typed failure, or explicit
  indeterminate outcome.
- **JX-EFF-004.** An indeterminate side-effecting Tool call MUST NOT retry
  automatically unless its Tool declares compatible idempotency semantics.
- **JX-EFF-005.** Driver exceptions MUST be converted into typed outcomes at the
  Driver boundary; they MUST NOT mutate State directly.
- **JX-EFF-006.** Retry Policy MUST be deterministic from recorded data,
  including attempt count, error class, and declared idempotency.
- **JX-EFF-007.** Replay MUST replace all Drivers with a no-dispatch replay
  implementation that consumes recorded outcome Events only.

### 9.3 Delivery guarantee

Jixu guarantees durable intent before dispatch and stable idempotency identity.
It does not claim universal exactly-once execution. When a process stops after
an external system acts but before the outcome Event commits, Jixu can prove
that the outcome is unknown, not whether the external action happened.

## 10. Pause, resume, fork, and replay

### 10.1 Pause and resume

- **JX-CONT-001.** `pause()` MUST durably request a pause and resolve only after
  the Run reaches `paused` or a terminal status.
- **JX-CONT-002.** `resume()` MUST reject non-paused Runs and MUST durably record
  the resumption before new Effect dispatch.
- **JX-CONT-003.** Recovery after process interruption is not called resume
  unless the Run was explicitly paused. A previously `running` Run is recovered.
- **JX-CONT-004.** A pause request MAY arrive while a Driver is active. Its known
  outcome MUST still be recorded. Effects produced by that outcome remain ready
  and MUST NOT be requested until a durable resume.
- **JX-CONT-005.** A selected batch of Effect requests and their Driver
  invocation form one pause boundary. A concurrent pause MAY take effect after
  that selected batch, but MUST prevent selection of the next batch.

### 10.2 Fork

- **JX-FORK-001.** `fork({ at })` MUST create a new Run ID.
- **JX-FORK-002.** The new Run MUST record `parentRunId`, `parentEventId`, and the
  parent sequence at the fork point.
- **JX-FORK-003.** The parent Event prefix MUST remain immutable.
- **JX-FORK-004.** A fork MUST begin from the State reconstructed at the selected
  parent Event, not from the parent's latest State.
- **JX-FORK-005.** New input and configuration overrides MUST be recorded in the
  child Run, never written retroactively into the parent.
- **JX-FORK-006.** Storage MAY share immutable event prefixes internally, but
  the observable semantics MUST match a complete independent history.
- **JX-FORK-007.** v0.1 Stores MUST create a Fork atomically by copying the
  parent prefix through the selected Event into a new Run with new Run, Event,
  Effect, causation, and idempotency identities, then appending `run.forked` and
  the child input. A partial child Run MUST NOT become visible.
- **JX-FORK-008.** Reducing the copied child prefix through the fork point MUST
  produce a State equivalent to the parent State at that point except for
  rebound Run and Effect identities. `run.forked` then clears inherited
  operational Effects and makes the child ready to accept its own recorded
  input.

### 10.3 Replay

- **JX-REPLAY-001.** Replay MUST be read-only.
- **JX-REPLAY-002.** Replay MUST perform zero model, Tool, approval, timer, or
  network Effects.
- **JX-REPLAY-003.** Replaying the same supported Event sequence with the same
  reducer version MUST produce structurally equal State.
- **JX-REPLAY-004.** Replaying MAY emit derived State snapshots for debugging,
  but those snapshots are not Events.
- **JX-REPLAY-005.** Re-executing with a different model is a new forked Run,
  never a replay.
- **JX-REPLAY-006.** `run.replay()` MUST read and reduce supported Events without
  registering or invoking live Drivers and MUST NOT append Events or
  Checkpoints.

## 11. Tools, MCP, Skills, and providers

### 11.1 Tools

- **JX-TOOL-001.** A Tool MUST declare a stable name, description, versioned
  input schema, and versioned output schema.
- **JX-TOOL-002.** Tool inputs and final outputs MUST be validated at the Driver
  boundary.
- **JX-TOOL-003.** Tool execution context MUST expose `runId`, `effectId`,
  `idempotencyKey`, cancellation, and a Signal emitter.
- **JX-TOOL-004.** Side-effecting Tools MUST declare their idempotency behavior.
- **JX-TOOL-005.** Approval Policy is owned by the runtime. A Tool MUST NOT grant
  its own approval.
- **JX-TOOL-006.** The first-party Node Tool package MUST provide opt-in `read`,
  `write`, `edit`, and `bash` Tools using the same canonical Tool interface as
  application and MCP Tools.
- **JX-TOOL-007.** File Tools MUST resolve paths against an explicit workspace
  root and reject resolved paths outside it. `bash` MUST be documented as a
  host-shell capability, not a security sandbox, even when its working directory
  is the workspace root.

### 11.2 MCP

- **JX-MCP-001.** MCP support MUST be an adapter from discovered MCP Tools to
  the canonical Jixu Tool interface.
- **JX-MCP-002.** MCP transport lifecycle and credentials MUST stay outside
  durable Event payloads.
- **JX-MCP-003.** MCP errors MUST use the same typed Tool outcome path as local
  Tools.
- **JX-MCP-004.** Jixu MUST NOT extend the MCP wire protocol to express Run
  lifecycle semantics.

### 11.3 Skills

- **JX-SKILL-001.** A Skill loader MUST treat `SKILL.md` and referenced resources
  as instructional context, not executable code.
- **JX-SKILL-002.** Skill discovery and progressive loading decisions that
  affect model context MUST be represented in durable Events at the level needed
  to reproduce the final model request.
- **JX-SKILL-003.** A Skill MAY refer to Tools, but loading a Skill MUST NOT grant
  Tool permission.
- **JX-SKILL-004.** Jixu MUST consume the existing Agent Skills convention rather
  than inventing a Jixu-only skill format.

### 11.4 Providers

- **JX-PROV-001.** OpenAI and Anthropic adapters MUST implement the same
  canonical model Effect contract.
- **JX-PROV-002.** Provider-specific request and response fields MAY be retained
  in typed metadata but MUST NOT leak into Kernel control flow.
- **JX-PROV-003.** The authoritative final model output MUST be normalized into a
  durable Event.
- **JX-PROV-004.** Provider-side conversation or response IDs MAY be stored as
  correlation metadata; they MUST NOT replace Jixu Run or Event identity.
- **JX-PROV-005.** The first-party OpenAI Driver MUST use the official OpenAI
  SDK, translate canonical Tools and messages at the adapter boundary, emit
  streamed deltas as Signals, and return only canonical typed outcomes to core.
- **JX-PROV-006.** `ModelDriver` is the one canonical provider-neutral LLM
  contract. The `@jixu/llm` package MAY expose a unified adapter facade and
  provider factories, but MUST NOT introduce provider branches into core or a
  second model execution contract.
- **JX-PROV-007.** The first-party OpenRouter factory MUST support its stateless
  Responses API through the same canonical full-history request and outcome
  mapping as OpenAI. OpenRouter compatibility MUST have independent contract
  tests because its Responses surface may differ or evolve independently.
- **JX-PROV-008.** The unified LLM package MUST provide an OpenAI-compatible
  Driver factory that accepts a caller-supplied API format, Base URL, API Key,
  and model ID. The supported API formats are `/v1/responses` and
  `/v1/chat/completions`; format selection MUST be explicit and MUST NOT be
  inferred by dispatching a fallback model request. Both formats MUST translate
  the same canonical full-history messages, Tools, streamed Signals, and typed
  outcomes without adding a provider branch to core.

## 12. Storage and recovery

### 12.1 Store contract

The core Store port MUST support:

- creating a Run;
- appending Events with expected revision;
- reading Events by Run and sequence;
- listing recoverable non-terminal Runs;
- writing and reading optional Checkpoints; and
- preserving fork lineage.

The Store port MUST expose an atomic `createFork` operation for an already
validated, complete child Event history. It MUST also expose optional
Checkpoint read/write operations. Store adapters MAY offer a `close()` method,
but Runtime correctness MUST NOT depend on it.

### 12.2 Requirements

- **JX-STORE-001.** v0.1 MUST ship an in-memory Store for tests, a JSONL Store
  for inspectability, and a SQLite Store for local durability.
- **JX-STORE-002.** A Store MUST reject stale expected revisions.
- **JX-STORE-003.** A Checkpoint MUST identify the exact last Event sequence and
  reducer/schema version used to produce it.
- **JX-STORE-004.** An invalid or incompatible Checkpoint MUST be discarded and
  rebuilt from Events.
- **JX-STORE-005.** Store implementations MUST preserve Event ordering and
  atomic append semantics documented by the Store.
- **JX-STORE-006.** v0.1 assumes one active runtime process for a local Store.
  Distributed leases and active-active execution are out of scope.
- **JX-STORE-007.** Recovery MUST inspect requested Effects without known
  outcomes and resolve them according to idempotency and retry Policy.
- **JX-STORE-008.** A Checkpoint contains `runId`, the exact last Event ID and
  sequence, Event schema version, Reducer version, derived State, and a
  deterministic State digest used to detect accidental corruption.
- **JX-STORE-009.** Runtime MUST validate a Checkpoint against the matching Event
  prefix before using it. Missing, malformed, incompatible, or structurally
  incorrect Checkpoints MUST be ignored and the State rebuilt from Events.
- **JX-STORE-010.** On recovery, a pending `model.generate` MAY retry with the
  same idempotency identity. A pending `tool.execute` MAY retry automatically
  only when its Tool declares `idempotent`; otherwise the Run MUST durably enter
  `waiting` with reason `effect_outcome_unknown` and MUST NOT call the Tool.
- **JX-STORE-011.** JSONL and SQLite Store implementations MUST pass the same
  Store contract suite as the in-memory Store, including stale revision,
  immutable reads, globally unique Event IDs, atomic Fork creation, Checkpoint
  round-trip, and non-terminal listing.

## 13. Public API target

The ergonomic API MUST keep immutable Agent definition separate from live
Runtime configuration, without exposing the Reducer to normal users:

```ts
const runtime = createRuntime({
  store,
  clock,
  ids,
  signals,
});

const agent = defineAgent({
  model,
  instructions,
  tools,
  skills,
  policy,
});

const run = await runtime.run(agent, input);

await run.wait();
await run.state();
await run.pause();
await run.resume();
await run.cancel();
await run.fork({ at: eventId, input, overrides });
await run.replay();

for await (const item of run.stream({ signal })) {
  // item.kind is "event" or "signal"
}
```

- **JX-API-001.** Simple usage MUST provide safe defaults for IDs, time, Store,
  retry Policy, and Signal streaming.
- **JX-API-002.** Advanced ports MUST remain injectable for deterministic tests
  and production adapters.
- **JX-API-003.** Event and Signal stream items MUST be discriminated by `kind`.
- **JX-API-004.** Public errors MUST be typed and include Run and Effect identity
  when applicable.
- **JX-API-005.** The normal user API MUST NOT require writing a Reducer,
  constructing Events, or manually dispatching Effects.
- **JX-API-006.** `runtime.recover(agent, runId)` MUST validate that the supplied
  Agent snapshot matches the durable Run, rebuild State, and continue only
  Effects allowed by recovery Policy.
- **JX-API-007.** `run.fork({ at, input })` MUST require a child input in v0.1.
  Configuration overrides remain planned until a compatibility contract is
  specified.
- **JX-API-008.** `run.stream()` MUST first make the selected durable Event
  prefix observable, then continue with newly committed Events and live Signals
  without duplicating a durable Event. Consumers MUST be able to stop a stream
  with an `AbortSignal`.

### 13.2 Reference TUI

The `jixu` package ships one reference OpenTUI surface for experiential
acceptance. It is an application of the public API, not a new Agent subtype.

- **JX-TUI-001.** The TUI MUST run an ordinary immutable `Agent` and MUST NOT
  define `CodingAgent`, `TuiAgent`, or any other parallel Agent concept.
- **JX-TUI-002.** A developer MUST be able to submit one prompt, observe model
  and Tool activity, inspect current State and Events, and invoke pause, resume,
  replay, and fork controls where the Run status permits them.
- **JX-TUI-002A.** The reference TUI MUST connect to a caller-supplied
  OpenAI-compatible Base URL instead of requiring a bundled provider catalogue.
  The developer MUST explicitly select Responses or Chat Completions format
  without changing the Agent or Run lifecycle. Shell capability copy MUST say
  `Local shell · unsandboxed`; it MUST NOT rely on the ambiguous phrase
  `host shell` as its user-facing safety explanation.
- **JX-TUI-002B.** API format, Base URL, credential, and model configuration
  MUST be completable inside the TUI before the first Run. Environment variables
  and CLI flags MAY prefill that form but MUST NOT be required to enter it.
  Model configuration MUST accept a free-form model ID rather than depend on a
  bundled model catalogue. The Base URL is the API root to which the selected
  format appends `/responses` or `/chat/completions`.
- **JX-TUI-002C.** The reference TUI MUST persist global user configuration
  under `~/.jixu/`: API format, Base URL, and model ID in `settings.json`, and
  the API Key in `auth.json`. A complete saved connection MUST allow a later
  launch to enter the Agent without re-entry, while `/config` MUST allow
  replacement inside the TUI.
- **JX-TUI-002D.** `auth.json` MUST use an explicit versioned schema, reside
  outside the workspace and Run Store, and be atomically replaced. On POSIX,
  its directory and file modes MUST be restricted to `0700` and `0600`.
  Credentials MUST NOT enter Events, State, checkpoints, workspace files,
  activity output, or raw TUI display.
- **JX-TUI-003.** OpenTUI and React dependencies MUST stay in the `jixu` package;
  importing headless core or adapter packages MUST NOT initialize a renderer or
  require Bun.
- **JX-TUI-004.** Source development and TUI tests use the OpenTUI-supported Bun
  runtime. Release builds SHOULD compile target-specific standalone executables
  so end users do not need Bun installed.
- **JX-TUI-005.** The reference theme MUST centralize these tokens: background
  `#141414`, text `#F5F3EF`, secondary `#9C9892`, brand `#D05A6E`, success
  `#6D9F71`, warning `#D8A34A`, and info `#6E93B8`. Brand color is a restrained
  identity accent, not a large-area background or generic status color.
- **JX-TUI-006.** The primary working surface MUST be one chronological
  transcript. User input, model output, Tool activity, and lifecycle feedback
  that matters to the developer MUST appear at their causal position in that
  transcript. The reference TUI MUST NOT reserve a permanent side panel or
  empty pane for activity, State, or Events; durable inspection remains
  available on demand through the controls in JX-TUI-002.
- **JX-TUI-007.** The transcript and composer MUST retain a readable bounded
  measure on wide terminals and remain usable at `80x24`. Narrow layouts MUST
  collapse secondary metadata instead of introducing a horizontal dashboard or
  hiding the prompt. Empty state, active execution, failure, and completed
  execution MUST use the same primary layout.
- **JX-TUI-008.** The composer MUST be a compact persistent surface expressed in
  user language such as `Ask Jixu`; it MUST NOT label every prompt as `New Run`.
  Provider, model, workspace, safety, and control hints MUST be compressed into
  adjacent context or status lines. JIXU identity MUST remain visible, with the
  brand token used for the wordmark and small interaction accents rather than
  full-screen chrome.

The JX-TUI-006 through JX-TUI-008 change is confined to the reference
application. It does not alter Agent, Run, Event, Runtime, provider, Tool, or
configuration semantics and requires no public API migration.

The `0.2.6` reference configuration replaces the pre-release provider-indexed
`settings.json` and `auth.json` version 1 shape with one version 2 compatible
connection. The TUI MUST read a complete version 1 OpenAI or OpenRouter
configuration as Responses format with the corresponding historical Base URL;
the next explicit save writes version 2. Unknown or mixed schema versions fail
closed. This migration changes only reference application configuration and
does not change durable Run Events.

### 13.1 M1 compatibility note

Before M2, `runtime.run()` resolved only after deterministic execution reached a
terminal State. M2 changes it to resolve after durable initial acceptance so a
caller can pause a live Run. Pre-release callers that need the old completion
behavior MUST add `await run.wait()`.

## 14. Security and data handling

- **JX-SEC-001.** Provider keys, MCP credentials, bearer tokens, and raw secrets
  MUST NOT be written to durable Events or Checkpoints.
- **JX-SEC-002.** Adapters MUST support configurable redaction before durable
  append and diagnostic emission.
- **JX-SEC-003.** Tool permission and approval decisions MUST be represented by
  durable Events.
- **JX-SEC-004.** Untrusted Tool outputs and Skill content MUST be treated as
  data, never as authority to change runtime Policy.
- **JX-SEC-005.** Cancellation and timeout MUST be propagated to Drivers using a
  standard cancellation signal.
- **JX-SEC-006.** Large or binary Tool outputs SHOULD be persisted outside the
  Event log and referenced by a typed content-addressed reference.
- **JX-SEC-007.** Enabling a host-shell Tool is an explicit application choice.
  A workspace working directory, path validation in sibling file Tools, or a UI
  warning MUST NOT be represented as process isolation. Strong isolation
  requires an application-supplied sandbox Driver outside core.

## 15. Specification-driven change process

### 15.1 Source of truth

This specification defines behavior and architecture. `AGENTS.md` defines the
repository working rules. Architecture Decision Records MAY explain a choice but
MUST NOT contradict this specification.

### 15.2 Required workflow

Any change to public behavior, lifecycle semantics, canonical terminology,
durability guarantees, package boundaries, or normative types MUST:

1. modify this specification first;
2. add or update stable requirement IDs;
3. state migration and compatibility impact;
4. add tests that cite the affected acceptance criteria; and
5. implement only after the proposed semantics are internally consistent.

Pure refactors that preserve all observable behavior MAY cite existing
requirements without changing this file.

### 15.3 Concept discipline

- One concept MUST have one canonical name.
- A new concept MUST define its authority, lifecycle, serialization boundary,
  and relationship to Run/Event/State/Effect.
- A new abstraction MUST remove more complexity than it adds.
- Application concepts MUST NOT leak into Kernel terminology.
- Examples MUST NOT imply guarantees stronger than normative requirements.

## 16. v0.1 package boundaries

The intended package layout is:

```text
packages/
  jixu/                # Public facade and CLI entry point
  core/                 # Kernel, canonical types, and ports
  llm/                  # Unified ModelDriver facade and provider factories
  tools-node/            # Opt-in read/write/edit/bash Tools for Node hosts
  mcp/                  # MCP Tool adapter
  skills/               # Agent Skills discovery and progressive loading
  store-jsonl/          # Inspectable local Event Store
  store-sqlite/         # Durable local Event Store
  testkit/              # Deterministic ports, fixtures, failure injection
examples/
  research-agent/
  approval-agent/
  recovery-agent/
```

- **JX-PKG-001.** `core` MUST NOT depend on a provider package, MCP SDK, database
  driver, web framework, or CLI framework.
- **JX-PKG-002.** Adapters MUST depend inward on canonical ports and types.
- **JX-PKG-003.** Example applications MUST consume public package APIs only.
- **JX-PKG-004.** The unscoped `jixu` package MAY compose defaults and expose
  CLI commands, but lifecycle logic and canonical types MUST remain in `core`.
- **JX-PKG-005.** Headless packages and the public library API MUST support Node
  `>=22.18.0`. Package manifests MUST remain installable by npm, pnpm, Yarn, and
  Bun without requiring a package-manager-specific runtime path.
- **JX-PKG-006.** OpenTUI's runtime requirement applies only to the reference
  TUI source and its build pipeline. It MUST NOT raise the Node requirement or
  add import-time native initialization for headless packages.

## 17. v0.1 acceptance criteria

Every criterion is release-blocking.

- **JX-AC-001 — Basic loop.** Given a deterministic model response containing a
  Tool call, Jixu validates and executes the Tool, records request and outcome
  Events, returns the Tool result to the model, and completes the Run.
- **JX-AC-002 — Streaming separation.** Model deltas are observable as Signals,
  while deleting every Signal still allows identical State reconstruction from
  Events.
- **JX-AC-003 — Crash recovery.** Inject a process stop after a non-idempotent
  Tool request Event commits. Recovery appends `run.waiting` with
  `effect_outcome_unknown` and invokes the Tool zero additional times.
- **JX-AC-004 — Cooperative idempotency.** With an idempotent Tool Driver, a stop
  after external completion but before outcome append recovers using the same
  idempotency key and produces one externally observable action.
- **JX-AC-005 — Pause/resume.** Pause while a Driver is active, record its known
  outcome, dispatch no newly ready Effect while paused, and reach the same
  result after resume as an uninterrupted deterministic baseline.
- **JX-AC-006 — Fork.** Forking at Event N atomically creates a new Run whose
  copied prefix State matches the parent at N except rebound identities and
  whose later Events cannot mutate the parent.
- **JX-AC-007 — Replay safety.** Replaying a completed Run invokes zero live
  Drivers and reconstructs structurally equal State.
- **JX-AC-008 — Checkpoint disposal.** Recover the same Run from a valid,
  deleted, malformed, incompatible, and structurally incorrect Checkpoint; only
  recovery work changes, never reconstructed State.
- **JX-AC-009 — Provider portability.** The same Agent definition runs through
  OpenAI and Anthropic adapters without provider-specific Kernel branches.
- **JX-AC-010 — MCP parity.** A local Tool and equivalent MCP Tool produce the
  same canonical request/outcome Event shapes.
- **JX-AC-011 — Skills compatibility.** A standard `SKILL.md` can be discovered
  and loaded progressively without granting Tool permissions.
- **JX-AC-012 — Concurrency rejection.** Two writers appending at the same Run
  revision cannot both commit.
- **JX-AC-013 — Secret handling.** Fixture secrets present in adapter credentials
  do not appear in Events, Checkpoints, errors, or Signals.
- **JX-AC-014 — Five-minute start.** A new TypeScript project can install Jixu,
  define one Tool, and complete one Run using documented code in under five
  minutes, excluding model credential acquisition.
- **JX-AC-015 — Runnable Agent.** A developer can launch the reference TUI,
  configure Responses or Chat Completions format, a compatible Base URL, a
  persisted credential, and a free-form model ID without leaving the TUI,
  relaunch without re-entering complete saved configuration, then submit one
  prompt that invokes at least one of `read`, `write`, `edit`, or `bash`, observe
  discriminated Event/Signal activity, and inspect the terminal Run State.
  Fixture credentials never appear outside the restricted global `auth.json`
  credential store.
- **JX-AC-016 — Headless runtime boundary.** On Node `22.18.0` or newer, a clean
  process can import and execute the headless public API without Bun or OpenTUI
  native initialization.
- **JX-AC-017 — Package-manager portability.** Packed release candidates install
  and expose the documented headless entry point in clean npm, pnpm, Yarn, and
  Bun consumer fixtures. Repository development retains one canonical lockfile.
- **JX-AC-018 — TUI lifecycle and harness surface.** OpenTUI renderer ownership
  is released after normal quit, handled failure, and repeated cleanup;
  in-memory renderer tests at `80x24` and a wide terminal verify a bounded
  single transcript, causally inline activity, a compact persistent composer,
  status and command surfaces, and the absence of a permanent activity panel.
- **JX-AC-019 — Unified LLM adapter.** The same Agent and deterministic Tool
  fixtures run through Responses and Chat Completions compatible clients using
  one `ModelDriver` contract, with wire-format request details confined to
  `@jixu/llm`. Contract tests verify both endpoint paths, full-history Tool
  mapping, streamed text Signals, final Tool calls, and credential redaction.

## 18. Implementation sequence

1. **M0 — Specification and repository rules.** Establish this baseline,
   `AGENTS.md`, contribution workflow, and architectural tests.
2. **M1 — Deterministic Kernel.** Implement canonical types, Reducer, in-memory
   Store, mock Drivers, and the basic loop.
3. **M2 — Continuity.** Implement JSONL/SQLite, checkpoints, recovery,
   pause/resume, fork, and replay.
4. **M2.1 — Experiential gate.** Before accepting M2, implement the narrowest
   real vertical slice: live Run observation, the OpenAI Driver, opt-in Node
   Tools, and the reference OpenTUI surface. This dependency advance exists
   because continuity tests alone did not provide a developer-runnable
   acceptance path; it does not mark the full adapter milestone complete.
5. **M3 — Ecosystem adapters.** Complete Anthropic, MCP, and Skills adapters and
   provider portability acceptance.
6. **M4 — Developer release.** Complete release packaging, examples,
   failure-injection suite, API documentation, and v0.1 release checks.

Implementation MUST proceed in this order unless this specification is updated
with the reason and changed dependencies.
