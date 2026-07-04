# Jixu Single-Agent Harness Specification

**Version:** 0.4.22
**Status:** normative, pre-release
**Last updated:** 2026-08-20

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
10. Make execution efficiency inspectable through durable token, cost, model,
    and Tool accounting without introducing a billing service.

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
- **JX-EVT-006.** Event schema version 5 is the current Thread schema. During
  pre-release development, every other Event schema version MUST fail closed;
  incompatible local development Threads are deleted and recreated rather than
  hidden behind runtime upcasters.

The v0.4 families are:

- `thread.created`
- `thread.forked`
- `thread.pause_requested`
- `thread.paused`
- `thread.continued`
- `thread.waiting`
- `input.received`
- `plan.updated`
- `plan.rejected`
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
- **JX-SIG-005.** A model Driver MAY expose one reserved progress control in an
  existing model request. A valid control call MUST emit a bounded, single-line
  `model.progress` Signal and MUST NOT become a Tool call, Event, State field, or
  additional model request. Invalid or missing progress output MUST be ignored
  without changing an otherwise usable model outcome or suppressing ordinary
  Tool calls. A provider response that contains a progress-control call but no
  non-whitespace public content, valid Plan change, or ordinary Tool call MUST
  fail closed as a typed, non-retryable model failure. It MUST NOT be recorded as
  an empty successful reply or trigger a hidden follow-up model request.
- **JX-SIG-006.** A Tool MAY emit bounded `tool.output.delta` Signals for
  user-visible live output. Each Signal MUST identify the Effect, Tool, output
  stream, and delta; it MUST NOT change execution correctness or become a
  durable result. The first-party Node `bash` Tool MUST emit only the portion of
  stdout or stderr admitted by its configured output bound. Consumers MUST
  bound retained live output independently because Signals may still arrive in
  bursts, and MUST discard it when the matching terminal Event arrives.

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
- **JX-EFF-007.** A Tool implementation MAY reject a request with a typed,
  deterministic execution error before an external outcome becomes unknown.
  The Tool Driver MUST preserve that error code, message, retryability, and
  `failed` disposition. An untyped exception after Tool dispatch MUST remain
  `indeterminate`; the Driver MUST NOT guess that no side effect occurred.

Jixu provides at-least-once dispatch for Effects declared idempotent. For
non-idempotent Effects whose durable outcome is unknown, recovery MUST enter
`waiting` rather than guess or silently repeat the action.

### 8.1 Durable efficiency accounting

Efficiency data is typed bookkeeping inside Events and derived Thread State. It
is not a new lifecycle, telemetry authority, hosted billing system, or provider
invoice.

- **JX-MET-001.** Every terminal model outcome MUST durably record a canonical
  accounting value. It MUST distinguish provider-reported token usage from an
  unavailable report instead of treating unknown values as zero.
- **JX-MET-002.** Canonical token usage MUST preserve reported input, output,
  total, reasoning, cached-input, and cache-write tokens. A provider field that
  is not reported MUST remain unknown; Jixu MUST NOT fabricate internal token
  counts.
- **JX-MET-003.** A trusted USD cost MAY come from a provider-declared USD
  amount or an explicitly injected versioned calculator. Cost MUST be stored as
  integer nanodollars with source metadata. Unknown or untrusted pricing MUST
  remain unpriced and MUST NOT be rendered as zero.
- **JX-MET-004.** Thread State MUST deterministically project cumulative model
  calls and attempts, model outcomes, Tool calls and attempts, Tool outcomes,
  canonical token usage, known USD cost, and missing usage or pricing counts
  from Events.
- **JX-MET-005.** Logical calls and dispatch attempts MUST remain distinct so a
  retry cannot make one Effect appear to be multiple requested capabilities.
- **JX-MET-006.** `clear` MUST retain efficiency accounting because consumed
  work remains historical fact. Replay and recovery MUST reproduce it; Fork
  MUST inherit the exact accounting projection at its selected Event.
- **JX-MET-007.** Durable accounting MUST contain no credentials, raw pricing
  callbacks, or secret provider metadata. Operational telemetry MAY export the
  same redacted facts but MUST NOT become their authority.

### 8.2 Model provider protocols

The first-party `@jixu/llm` boundary deliberately supports two wire protocols:
OpenAI Chat Completions and Anthropic Messages. A configured endpoint selects
exactly one protocol; provider brands and model catalogs are not a second
routing authority.

- **JX-PROV-001.** The published first-party protocol selector MUST be the
  closed union `openai-chat-completions | anthropic-messages`. OpenAI Responses
  is outside the supported boundary and MUST NOT remain as a public factory,
  configuration value, fallback, or compatibility alias.
- **JX-PROV-002.** Both protocols MUST normalize public text, client-side Tool
  calls and results, Plan control, progress control, streaming deltas, typed
  failures, cancellation, and canonical accounting into the same `ModelDriver`
  contract. Jixu MUST NOT silently omit Tool descriptors to make a model or
  endpoint appear compatible.
- **JX-PROV-003.** A model request MUST dispatch through only its configured
  protocol. First-party provider clients MUST disable SDK retries, perform no
  hidden protocol fallback, and leave every retry attempt to the durable Effect
  path.
- **JX-PROV-004.** Anthropic Messages MUST group consecutive Tool results into
  the required user `tool_result` content blocks and reconstruct streamed
  `tool_use` arguments before publishing a terminal model outcome. OpenAI Chat
  Completions MUST preserve its native assistant/tool message ordering and
  reconstruct streamed function arguments before the same boundary.
- **JX-PROV-005.** Protocol accounting MUST be capability-aware. Reported fields
  map to canonical usage; unavailable cache, reasoning, total, or cost fields
  remain unknown unless they can be deterministically derived from reported
  protocol fields. Untrusted compatible-endpoint cost remains unknown unless an
  explicitly trusted provider declaration or versioned calculator supplies it.
- **JX-PROV-006.** A custom Base URL MUST be normalized without credentials,
  query, or fragment. The OpenAI protocol addresses `chat/completions` below
  that API root; the Anthropic protocol addresses `messages` below a supplied
  `/v1` root or `/v1/messages` below an origin-style root. Standard Anthropic
  authentication uses `x-api-key`; a recognized OpenRouter Messages endpoint
  uses its required Bearer authorization without exposing either credential.

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
  `pending`, `in_progress`, `completed`, `blocked`, or `skipped`. A revision
  whose steps are all `completed` or `skipped` MUST project `completed`
  without requiring a second ceremonial completion operation.
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
- **JX-PLAN-008.** The model-facing Plan control MUST be derived from current
  State. It MUST offer `create` only when no active Plan exists, and MUST NOT
  offer `create` while a Plan is active. Revising, superseding, or abandoning
  an active Plan updates that Plan's history; Plan control MUST NOT create a
  second active Plan.
- **JX-PLAN-009.** An invalid model-proposed Plan change MUST be durably recorded
  as `plan.rejected` before any ordinary Effects from the same model output are
  dispatched. Rejection MUST preserve the last valid Plan and MUST NOT convert
  an otherwise successful model outcome into `model.failed`, suppress its
  user-visible response, or discard its valid Tool calls.

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
- **JX-CTX-014.** Provider requests MUST place immutable Agent instructions and
  stable capability descriptors before request-varying context. Active Plan
  content, Thread identifiers, timestamps, user input, and other changing data
  MUST NOT be interpolated into Agent instructions. New conversational and
  runtime context MUST extend the reusable prefix instead of rewriting earlier
  content. The State-derived Plan control required by `JX-PLAN-008` MAY change
  only when its allowed operation set changes; dynamic Plan data MUST NOT be
  smuggled into an otherwise stable Tool descriptor.
- **JX-CTX-015.** Provider prompt-cache keys, breakpoints, retention hints, and
  routing affinity are optional Driver optimizations. They MUST be derived from
  stable Jixu identities or immutable content, MUST NOT create a Session concept
  or provider-owned Thread authority, and MUST NOT affect Event reduction,
  replay, recovery, or model semantics. Unsupported providers MUST be able to
  omit them. Reported cache reads and writes remain durable accounting facts.

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
- **JX-TOOL-006.** First-party Node file Tools MUST use one explicit filesystem
  scope. `workspace` is the library default and accepts only canonical paths
  contained by the configured root. `process` accepts absolute paths available
  to the Jixu process while continuing to resolve relative paths from the
  configured root. The reference TUI MAY select `process` only because it also
  exposes the explicitly disclosed unsandboxed local shell; its file and shell
  capabilities MUST describe the same effective access boundary to the model
  and user.
- **JX-TOOL-007.** Every bounded file scope MUST resolve lexical paths,
  existing targets, ancestors, and symbolic links before access. A known scope
  rejection MUST be a typed deterministic Tool failure rather than an
  indeterminate Driver exception.

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

### 11.4 Reference Agent instructions

- **JX-AGENT-001.** The reference Jixu Agent instructions MUST describe only
  capabilities available in the current executable Harness. Planned Context,
  Skill, Handoff, approval, sandbox, or provider features MUST NOT be presented
  to the model as usable capabilities before their ordinary public path exists.
- **JX-AGENT-002.** The reference instructions MUST define the single-Agent
  mission, Tool boundary, adaptive Plan and public-progress policies, evidence
  and validation expectations, destructive-action constraints, secret handling,
  scope discipline, efficiency expectations, and final-response contract. They
  MUST distinguish observable progress from hidden reasoning and MUST NOT ask
  the model to manage provider caching itself.

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
  paused Thread. The picker MUST reserve a viewport of at least three Thread
  rows even when fewer Threads exist, show up to six rows without paging, and
  scroll the native selection list internally beyond that bound.
- **JX-TUI-010.** `/continue` MUST continue only a paused Thread.
- **JX-TUI-011.** `/fork` MUST create and select a distinct child Thread with
  explicit lineage.
- **JX-TUI-012.** `/events`, `/state`, and `/replay` MUST inspect durable data
  through Thread APIs.
- **JX-TUI-013.** TUI orchestration, command metadata, transcript projection,
  screen layout, and configuration MUST remain separate modules; no catch-all
  UI source file may own all of them.
- **JX-TUI-014.** The composer footer MUST show the selected Thread's cumulative
  known model cost in USD. A Thread with missing trusted pricing MUST display an
  explicit unavailable or partial value rather than `$0.00`. When the Attention
  Rail is visible, this footer belongs to the composer column and MUST NOT span
  beneath the rail.
- **JX-TUI-015.** Every interactive configuration control MUST expose the same
  selection and focus transition to keyboard and primary-button mouse input.
  Pointer support MUST supplement, not replace, visible keyboard operation.
- **JX-TUI-016.** Full-screen page chrome MUST place its header and footer on
  the first and last rendered rows. The outer canvas MUST inherit the terminal
  background so pixels outside the terminal cell grid cannot appear as a
  distinct application-colored band.
- **JX-TUI-017.** The composer MUST submit on Enter and insert a newline on
  Shift+Enter when the terminal reports that modifier. It MUST grow with visual
  content only to a bounded maximum height, then scroll internally instead of
  displacing the surrounding workspace without limit. The composer MUST NOT
  repeat a `YOU` role label beside the active editor; the accent rule and input
  position already communicate authorship.
- **JX-TUI-018.** The active Plan MUST render in a bounded horizontal strip owned
  by the composer column and outside the transcript scrollbox. Transcript growth
  MUST NOT move the strip away from the composer; an oversized Plan MUST
  condense inside its own bound. When no active Plan exists, the strip MUST be
  absent without reserving empty rows; the Attention Rail still states that the
  Thread is using direct execution.
- **JX-TUI-019.** While work is live, the TUI SHOULD present observable Agent
  progress as one ephemeral `JIXU` row inside the transcript flow, using the
  existing Nippon-color tokens. It is a presentation of the current transient
  controller snapshot, not a transcript entry, Event, model message, or source
  of execution authority. Model progress MUST describe only the next observable
  action, remain concise, and never expose hidden chain-of-thought. The row MUST
  fall back to factual Event-derived status when no public progress Signal
  exists.

  The ephemeral row is present only while the Thread is busy in a Thinking or
  planning phase and no public model text is currently streaming. The first
  text delta replaces it with the streaming `JIXU` response in the same
  transcript surface. A `tool.requested` Event replaces it with the causal Tool
  receipt rather than rendering both states at once. After the matching Tool
  outcome, a subsequent Thinking phase MAY render a new ephemeral `JIXU` row
  after that receipt. Completion, failure, waiting, cancellation, and idle
  boundaries remove the row unless a new live phase begins.

  The transcript MUST derive durable receipt groups from `tool.requested` and
  matching outcome Events, place them in causal order with surrounding model
  messages, and retain them after the final response and later input.
  Every Tool receipt group MUST retain a visible `JIXU` role anchor in the same
  compact role gutter as ordinary Agent messages. Its `TOOLS` heading MUST NOT
  appear beneath or visually attach to the preceding `YOU` row when an empty
  Tool-calling model response produces no public Agent text.
  Historical groups MAY be collapsed or bounded for presentation, but MUST
  keep the Tool name, factual target or command summary, and terminal status
  discoverable. Neither transient status nor receipt projection may replace
  durable Event inspection.

  Optional motion MUST use fixed-width text for the ephemeral Agent role and
  canonical `Thinking ...` label, update only their color treatment on the same
  bounded cadence, stop at stable boundaries, and provide intentional static
  text rather than a frozen animation frame. Arbitrary public progress prose
  remains static. The fixed two-row Composer footer MUST remain stable before,
  during, and after live work: it exposes only the selected model on its first
  row, while endpoint host and API format remain in configuration; its second
  row exposes local I/O, cost, and quit context. Live work MUST NOT replace those
  fields or increase the Composer footprint.
- **JX-TUI-020.** Rich transcript content, including Markdown tables, MUST stay
  inside the transcript viewport after padding and scrollbar space are applied;
  it MUST NOT hide or draw its right boundary outside the composer column.
  Ordinary `YOU` and `JIXU` message rows MUST share one compact role gutter so
  the role remains visibly attached to its content rather than separated by a
  broad empty column.
- **JX-TUI-021.** High-frequency model output deltas MUST preserve exact text
  order while being coalesced into bounded presentation frames. A committed
  model Event remains authoritative and MUST replace the transient stream in
  the same surface publication at the stable boundary. Non-empty public model
  content MUST remain visible when the same response also requests Tools; it
  MUST NOT appear transiently and then vanish merely because Tool execution
  follows. Promotion MUST NOT render both transient and committed copies of the
  same content in an intermediate frame. The ephemeral Agent status row defined
  by `JX-TUI-019` MUST be mutually exclusive with the transient model stream and
  MUST NOT enter the committed transcript or a future model request.
- **JX-TUI-022.** An ordinary wide workspace MUST keep one user-centered
  Attention Rail visible for empty Threads, direct execution, active Plans,
  live work, completed turns, and failure or waiting states. Its stable
  sections are `NOW`, `PLAN`, `VERIFIED`, and `NEEDS YOU`. They are read-only
  projections of durable Events and State plus transient Signals; they MUST NOT
  become a second history, status machine, scheduler, or execution authority.
  Raw Event identity and chronology remain available through `/events` rather
  than occupying the default rail.
- **JX-TUI-023.** The `PLAN` section of the Attention Rail MUST remain present
  when no active Plan exists and explicitly identify direct execution. With an
  active Plan it MUST show the objective and current or next meaningful step.
  `NOW` MUST communicate only observable public work, `VERIFIED` MUST summarize
  factual completed outcomes, and `NEEDS YOU` MUST distinguish a real decision
  or failure from the normal no-intervention state. None of these sections may
  expose hidden chain-of-thought, invent completion percentages, or fabricate
  elapsed-time estimates.
- **JX-TUI-024.** The reference TUI SHOULD use one coherent set of portable
  terminal glyphs for Tool categories, Plan, verification, and user-attention
  states. In ordinary rail and Tool-receipt rows each marker MUST occupy one
  terminal cell inside a two-column text gutter and remain paired with a
  meaningful label and semantic color. It MUST be rendered through the normal
  text path and MUST NOT depend on a custom drawing surface, encoded image,
  `ImageRenderable`, Kitty Graphics, Sixel, Nerd Font, terminal pixel geometry,
  DPI, or image scaling. One-row headers, footers, status strips, and compact
  summaries MAY omit the marker when typography is clearer. Compact terminals
  MUST fold the four Attention meanings into a bounded strip instead of
  silently removing them.
- **JX-TUI-025.** An empty workspace with sufficient room SHOULD place one
  original terminal-native Jixu creation mark above the \`JIXU\` wordmark. The
  mark depicts two reaching hands whose index fingers remain separated by one
  intentional creation spark. It MUST use fixed logical pixels rendered through
  ordinary OpenTUI text and normal layout flow; it MUST NOT use an encoded
  image, \`ImageRenderable\`, Kitty Graphics, Sixel, Nerd Font, terminal pixel
  geometry, DPI, or a custom drawing surface. This multi-row brand illustration
  is limited to the empty workspace and MUST NOT enlarge ordinary Attention or
  Tool markers. Short viewports MAY omit it to preserve the Composer and command
  discovery path. The empty workspace MUST replace its static slash-command
  inventory with one concise prompt to type \`/\`; the filtered keyboard-operable
  menu required by \`JX-TUI-003\` remains the command authority.
- **JX-TUI-026.** Tool receipts MUST form a compact `JIXU` action stream rather
  than a generic execution log. Requests produced by the same model decision
  MUST share one receipt group by their durable `requestedByEventId`; a later
  Tool-only model decision MUST start a new group even when no public Agent text
  separates it from the previous group. Operations inside a group MUST retain
  model source order while their running and terminal state updates in place.

  By default, each visible Tool occupies one line containing its category,
  name, factual target or command summary, and current or terminal result.
  Terminal results SHOULD use the Tool's typed output, such as bytes written,
  replacements made, lines read, or shell exit status, instead of the generic
  word `Completed`. A non-zero shell exit remains a successful Tool Driver
  outcome but MUST use warning presentation; failed and indeterminate outcomes
  MUST remain visibly distinct.

  A live group MUST remain fully visible. A running `bash` receipt MAY render a
  bounded output tail from `tool.output.delta` Signals beneath its compact row;
  the tail is transient, MUST NOT enter transcript history, and MUST disappear
  at the matching terminal Event. Historical terminal groups larger than four
  operations SHOULD collapse to a factual aggregate rather than an arbitrary
  last-N slice. Failed and indeterminate operations MUST remain visible while
  collapsed, and the complete operation list plus bounded durable output
  previews MUST be discoverable through a visible keyboard affordance. Every
  visible operation row MUST also be an independent disclosure target with a
  distinct open or closed marker; primary-button input toggles only that row.
  Expanded content MUST identify the relevant request input and terminal output
  without pretending to contain unavailable evidence. In particular, `edit`
  renders its requested old/new fragments as a replacement diff rather than a
  fabricated whole-file diff. Each expanded detail surface MUST use its natural
  content height through eight rows, MUST NOT reserve the full eight rows for
  shorter content, and MUST scroll internally only after its content exceeds
  that bound instead of displacing the transcript without limit.

  The reference TUI uses `Ctrl+O` to expand or collapse every Tool row without
  moving focus away from the Composer. Disclosure state is non-authoritative
  presentation state keyed by Thread and Effect: switching away from and back
  to a Thread in the same process SHOULD preserve it, while a new process MAY
  begin with every row closed. The detail content itself MUST remain
  reconstructible from durable request and outcome Events; disclosure state
  MUST NOT enter Events, State, Replay, or model context.
- **JX-TUI-027.** Entering Configuration from the workspace MUST be reversible
  through both visible primary-button UI and the `Escape` key. Leaving
  Configuration MUST return to the same workspace without discarding its active
  model connection or selected Thread; incomplete form edits are not saved.
  Navigation MUST be disabled only while a new connection attempt is in flight,
  so a late connection result cannot replace a workspace after the user leaves.
- **JX-TUI-028.** Configuration MUST offer a small protocol-specific set of
  maintained endpoint presets plus `Custom` before the editable Base URL. A
  preset MUST only populate the ordinary Base URL field: it MUST NOT introduce
  provider routing state, a model catalog, a second configuration authority, or
  a new persisted schema field. Preset selection and the following edit focus
  MUST be equivalent for keyboard and primary-button mouse input; arbitrary
  normalized Base URLs remain supported.
- **JX-TUI-029.** Configuration chrome MUST identify the non-secret settings
  file and API-key file as separate labeled layout groups, and MUST label the
  workspace path rather than presenting an unexplained raw path. Keyboard help
  MUST render as distinct key/action groups instead of one punctuation-delimited
  status sentence. A compact viewport MAY omit paths and secondary shortcuts,
  but MUST preserve visible Back and Quit actions.
- **JX-TUI-030.** After the interactive CLI restores terminal ownership for a
  user-requested quit or `SIGINT`, it SHOULD print one bounded terminal-native
  `JIXU` exit wordmark before returning control to the shell. It MUST NOT print
  the wordmark for help output, non-TTY stdout, `SIGTERM`, startup failure, or an
  unhandled crash. The wordmark MAY use ANSI color when stdout is a color-capable
  TTY, MUST honor `NO_COLOR`, and MUST always reset terminal styling.
- **JX-TUI-031.** Assistant transcript and streaming Markdown MUST render fenced
  code blocks as code surfaces rather than flattening them into ordinary prose.
  Stable, syntactically complete Markdown blocks MUST render semantic document
  structure instead of exposing source delimiters: headings omit hash markers,
  block quotes use a visual rail, thematic breaks use a real rule, task items
  distinguish checked and unchecked state without `[x]` or `[ ]`, tables use
  aligned cells without pipe or delimiter rows, and inline emphasis, code, and
  links omit their formatting punctuation. Incomplete trailing streaming input
  MAY remain literal until the parser can identify a complete construct.

  A recognized fence language MUST use the maintained parser available through
  the current OpenTUI runtime; an unknown or unavailable language MUST retain
  readable fenced-code layout with a stable raw-code fallback. HTML and HTM
  fences MUST use the bundled TypeScript-React parser as an explicitly bounded
  compatibility highlighter for markup, attributes, strings, and embedded
  JavaScript tokens; JSON and JSONC fences MUST similarly use the bundled
  JavaScript parser. These mappings MUST NOT be advertised as complete HTML,
  CSS, or script injection support. Every fenced block MUST sit inside a visible
  code frame whose border identifies the normalized fence language. The frame
  MUST use its natural content height through twelve content rows and become
  internally vertically scrollable only above that bound.
  Syntax colors MUST be derived from the existing Jixu theme: brand for
  keywords, information blue for callable symbols, success green for strings,
  warning gold for numbers and types, secondary text for comments, and the
  elevated surface for code background. Highlighting and scroll position MUST
  NOT change transcript content, durable Events, model context, or streaming
  order.

  The reference TUI MUST additionally register pinned, local Tree-sitter assets
  for Bash and Python before initializing the renderer. `bash`, `sh`, and
  `shell` MUST resolve to the Bash parser; `python` and `py` MUST resolve to the
  Python parser. Parser WASM and highlight queries MUST be generated from one
  checked-in, immutable-source configuration, travel with the local package
  artifact, and require no runtime network access. A missing or unloadable
  parser MUST preserve readable raw code rather than prevent the Thread from
  rendering.
- **JX-TUI-032.** When the user submits ordinary input from the Composer while
  inspecting older transcript content, the TUI MUST reveal the newly accepted
  `YOU` entry and restore bottom-following for the resulting live turn. Ordinary
  model, Tool, or Signal-driven transcript growth MUST continue to respect a
  deliberate historical scroll position until the user submits new input or
  returns to the bottom. This is transient viewport behavior and MUST NOT enter
  Events, State, Replay, Checkpoints, or model context.

Configuration stores credentials separately from non-secret settings, uses
restrictive POSIX permissions, and never records secrets in Thread data.

## 15. Security

- **JX-SEC-001.** Secrets MUST remain behind configuration and Driver
  boundaries.
- **JX-SEC-002.** Errors MUST be sanitized before durable append.
- **JX-SEC-003.** Unknown Tools are rejected before dispatch.
- **JX-SEC-004.** Local file Tools MUST enforce their documented configured
  filesystem scope. A process-wide scope MUST never be implied by a Tool name
  or silently enabled in a workspace-bounded library configuration.
- **JX-SEC-005.** Unsandboxed shell execution and any matching process-wide file
  scope MUST be opt-in at the application boundary and visibly disclosed.
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
- **JX-AC-016 — Provider boundary.** OpenAI-compatible Chat Completions and
  Anthropic Messages each pass streaming text, client-side Tool round trips,
  progress and Plan controls, usage normalization, typed HTTP/stream failure,
  cancellation, and secret-redaction tests through the same model Driver
  contract. One logical request produces one provider dispatch, with zero SDK
  retries and no protocol fallback.
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
- **JX-AC-028 — Durable efficiency accounting.** A deterministic Thread with
  model retries, reported reasoning/cache usage, priced and unpriced model
  outcomes, and repeated Tool dispatch projects exact logical-call, attempt,
  outcome, token, missing-report, and USD totals after Replay and recovery. The
  TUI renders its USD value below the composer without using UI-local counters.
- **JX-AC-029 — Config viewport and input parity.** At ordinary wide and compact
  terminal sizes, the Config header and footer occupy the viewport boundary
  rows; API format and field focus can be selected by mouse; and the same form
  remains fully operable by Tab, arrows, numbers, and Enter.
- **JX-AC-030 — Composer column and multiline input.** On a wide workspace, the
  model, shell, cost, and quit status remain left of the Attention Rail while the
  rail reaches its own bottom row. The composer preserves Shift+Enter newlines,
  Enter submits, omits a redundant `YOU` label beside the editor, and its
  rendered height never exceeds the documented bound.
- **JX-AC-031 — Plan control resilience and live presentation.** With no active
  Plan the model can create one; with an active Plan the exposed control omits
  `create`; a revision with only terminal steps completes automatically. If a
  provider nevertheless proposes an invalid Plan change alongside response
  content or valid Tool calls, Replay observes `model.completed` followed by
  `plan.rejected`, the previous Plan remains active, and the Tool path proceeds
  normally. The reference TUI keeps the active Plan outside transcript
  scrolling and reports only observable high-level work phases.
- **JX-AC-032 — Transcript rendering stability.** A wide Markdown table renders
  complete left and right boundaries inside the transcript viewport. A burst of
  ordered output deltas is presented as coalesced text rather than one surface
  publication per delta, and the committed response remains exact. Ordinary
  user and Agent rows use the same compact role gutter without visually
  detaching names from messages.
- **JX-AC-033 — Branded execution motion.** A live Thinking or planning phase
  renders one ephemeral transcript row with a fixed-width `JIXU` role marker
  whose emphasis travels through existing Nippon semantic colors without
  changing durable State. In the canonical Thinking state, the `Thinking ...`
  label uses the same cadence and emphasis treatment while preserving every
  character cell. Response streaming and disabled motion use intentional static
  text, not a frozen progress track. Tool phases render their causal receipts
  instead of a second Agent status row. The Composer and its two footer rows
  occupy the same rows before, during, and after transient work status is
  present.
- **JX-AC-034 — Model-generated public progress.** OpenAI Chat Completions and
  Anthropic Messages requests expose one reserved progress control in the existing
  model call. A valid concise update is emitted as `model.progress`, excluded
  from model Tool calls and durable Events, and carried by the TUI through the
  following observable Tool action. A malformed or absent update falls back to
  Event-derived status without failing otherwise valid content, Plan changes, or
  Tool calls and without dispatching another model request. A response containing
  only progress control output records a typed, non-retryable `model.failed`
  outcome instead of an empty `model.completed`, and dispatches no continuation
  request.
- **JX-AC-035 — Accurate Agent contract and cache-stable context.** The
  reference Agent receives one versioned, immutable instruction prefix that
  accurately describes its current Harness, Tools, Plan, progress, safety,
  validation, and efficiency contract. Consecutive requests in the same Thread
  preserve byte-identical instructions, ordinary Tool order, and control
  descriptors while their State-valid operation set is unchanged. Revising an
  active Plan changes only request-tail runtime context, not instructions. An
  compatible Driver MAY supply a stable Thread-derived provider cache key when
  the selected protocol supports one; omitting provider cache metadata MUST NOT
  change logical input.
- **JX-AC-036 — Live turn presentation continuity.** Public model text emitted
  before Tool calls remains in the transcript. While awaiting public output, an
  ephemeral `JIXU` status row appears in transcript flow; the first text delta
  or Tool request removes it before rendering the corresponding stream or
  receipt. Each requested Tool and its terminal outcome project one causal
  transcript receipt that remains after the final model boundary and the
  following user input. If model work continues after a Tool outcome, the next
  ephemeral Agent row appears after that receipt. At a final model boundary, the
  transient stream is atomically replaced by the exact committed response, with
  no duplicate or empty intermediate frame; presentation-only updates preserve
  unchanged committed transcript identities. A receipt group remains visibly
  anchored to `JIXU` even when the preceding model result contains only Tool
  calls and therefore produces no public Agent message. The Composer footer
  remains stable model, local-I/O, cost, and quit context throughout the turn.
- **JX-AC-037 — Premium attention workspace.** Before a Thread exists and after
  a simple no-Plan turn, a wide TUI renders the same `NOW`, `PLAN`, `VERIFIED`,
  and `NEEDS YOU` rail with an explicit direct-execution Plan state. During a
  non-trivial turn it renders observable Thinking, Tool, responding, active-Plan,
  verified-result, and intervention states without raw Event IDs, hidden
  reasoning, invented percentages, or ETA. The active Plan alone adds the
  bounded horizontal strip above the Composer. At compact width the physical
  rail disappears, but a bounded attention strip preserves current, Plan,
  verification, and intervention meaning. Rail and Tool markers remain
  one-cell text glyphs inside two-column gutters whether or not image protocols
  are available; no frame requires image capability or custom cell drawing.
- **JX-AC-038 — Empty-workspace creation mark.** At a roomy wide viewport, an
  empty configured or unconfigured workspace renders the two-hand Jixu creation
  mark above the wordmark through normal text nodes and contains no image
  renderable. The page shows one \`Type / to view commands.\` discovery prompt
  instead of enumerating slash commands. At 80x24 the Composer and the same
  discovery prompt remain visible even when the decorative mark is omitted;
  typing \`/\` still opens the canonical filtered command menu.
- **JX-AC-039 — Coherent local Tool scope.** With the default `workspace`
  scope, lexical and symbolic-link escapes fail with the typed deterministic
  code `tool_path_outside_scope`. With the reference TUI's explicitly disclosed
  `process` scope, the same absolute path outside the launch directory can be
  read, written, and edited by file Tools instead of succeeding only through
  the unsandboxed shell. Unknown Tool exceptions remain indeterminate.
- **JX-AC-040 — Durable Tool receipts.** A turn that emits public model text,
  completes a Tool, and commits a final response renders one Tool receipt in
  causal transcript order. The receipt retains its command or target and final
  status after the turn becomes idle, after the next input, and after reopening
  the Thread; `/clear` removes it only from the visible transcript projection
  while preserving the underlying Events.
- **JX-AC-041 — Tool action stream.** Two consecutive Tool-only model decisions
  render two `JIXU` receipt groups, while concurrent Tool calls from one model
  response retain source order inside one group. Every visible operation uses
  one compact row and transitions in place from running to a Tool-specific
  terminal result. A running Node `bash` call exposes only a bounded transient
  output tail; its committed receipt is reconstructed from request and outcome
  Events after reopen. A terminal group larger than four operations collapses
  to status counts without hiding failed or indeterminate operations, advertises
  `Ctrl+O`, and expands back to the complete ordered list and any bounded durable
  previews. Primary-button input independently opens and closes every visible
  operation, with a separate disclosure marker that does not overload the Tool
  category glyph. An expanded `edit` operation shows its old/new replacement
  fragments as a colored diff. An expanded detail shorter than eight rows uses
  only its natural height; a longer detail stays inside an eight-row vertically
  scrollable surface. Switching Threads and back in one process preserves the
  open rows; reopening after process restart may close them but reconstructs
  the same detail content from Events. Dropping every Tool Signal changes
  neither the final receipt nor Thread State.
- **JX-AC-042 — Reversible Configuration and endpoint presets.** From an active
  workspace, `/config` followed by `Escape` returns to the same selected Thread
  and usable model connection without reconnecting. The visible Back control
  performs the same transition. For each supported protocol, arrows move preset
  focus; numbered shortcuts, Enter, and primary-button selection apply a
  documented endpoint preset and move to the still-editable Base URL; `Custom`
  accepts an arbitrary valid URL. Connecting persists only the resulting
  protocol and normalized Base URL through the existing configuration schema.
- **JX-AC-043 — Configuration chrome semantics.** A wide Configuration frame
  names `~/.jixu/settings.json` and `~/.jixu/auth.json` independently, labels
  the workspace path, and presents Back, focus movement, selection, and Quit as
  separately laid-out key/action groups with no punctuation separator standing
  in for hierarchy. At 80x24 the same frame identifies `settings.json` and
  `auth.json`, remains fully operable, and retains visible Back and Quit.
- **JX-AC-044 — CLI exit wordmark.** Both the TUI Quit action and `SIGINT`
  resolve the ordinary CLI shutdown, unmount and destroy the renderer, then
  write exactly one bounded `JIXU` wordmark to TTY stdout. `SIGTERM`, help,
  non-TTY output, and failures write none. Colored output ends with an ANSI
  reset; `NO_COLOR` emits the same rows without escape sequences.
- **JX-AC-045 — Themed code blocks.** A committed and a streaming assistant
  response containing a JavaScript or TypeScript fence creates an OpenTUI code
  renderable with concealed fence markers and language-aware token styles. The
  registered syntax palette maps keywords, functions, strings, numbers, types,
  comments, punctuation, and raw-code fallback to existing Jixu colors and an
  elevated code background. An HTML fence uses the documented bundled
  TypeScript-React compatibility parser and produces styled markup tokens; a
  JSON fence uses the JavaScript compatibility parser. A short fenced block
  uses a labeled, bordered natural-height surface; a block longer than twelve
  content rows uses a bordered twelve-row viewport whose vertical scroll
  position changes under pointer-wheel input. An unsupported fence remains
  readable as code and preserves its exact textual content. A stable fixture
  containing headings, a quote, thematic break, checked and unchecked tasks,
  inline emphasis and code, a table, and a fenced shell block renders without
  the corresponding Markdown delimiters while retaining their semantic visual
  distinctions. Bash, `sh`, and `shell` samples plus Python and `py` samples
  each resolve to their registered local parser and produce non-empty highlight
  ranges with networking unavailable.
- **JX-AC-046 — Thread picker density and submit reveal.** With one previous
  Thread, `/resume` renders a three-row native selection viewport instead of a
  one-row strip; additional Threads remain directly visible through six rows
  and then scroll inside the picker. After the transcript has enough content to
  scroll, moving to historical content and submitting ordinary input through
  the Composer makes the new `YOU` entry visible, moves the transcript to its
  bottom edge, and lets the following live response continue from there.

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
Persisted pre-release drafts using any non-current Event schema MUST fail closed;
no automatic migration is provided before the first stable release.

Within the Thread model, Event schema version 5 derives the exposed Plan control
from State, adds `plan.rejected`, records the reserved progress-control
descriptor inside each requested Model Effect, and keeps immutable Agent
instructions separate from dynamic active-Plan context. Earlier Event schemas
were pre-release drafts: the core decoder rejects them, and incompatible local
development Threads are removed instead of migrated. No Store is rewritten in
place.

Pre-release Plan control no longer asks the model for a separate `complete`
operation. New revisions derive completion from their step statuses. Proposals
that still use `complete` are invalid; semantic Plan errors are retained as
`plan.rejected` facts without invalidating the surrounding model result.

Version 0.4.1 clarifies that progress control is presentation-only and cannot be
the sole successful result of a model request. Progress-only provider output now
fails closed without changing Event schema version 5 or requiring Store
migration.

Version 0.4.2 replaces the pre-release Responses/Chat-Completions selector with
the closed `openai-chat-completions | anthropic-messages` protocol boundary.
Responses factories and configuration values are removed without an alias. The
reference configuration uses schema version 3 with a single `api` field; schema
versions 1 and 2 fail closed and are recreated through `/config`. This changes
no Event schema and does not rewrite any Thread. All workspace and published
packages now require Node.js `>=22.19.0`; compatibility with Node 22.18.x is not
promised.

Version 0.4.3 replaces the raw default Activity rail with a non-authoritative
Attention Rail derived from the same Event, State, and Signal sources. This is a
presentation-only migration: `/events` continues to expose the durable ordered
history, no Event or configuration schema changes, and no stored Thread is
rewritten. Wide workspaces retain the rail even for empty and direct-execution
Threads; compact workspaces retain its meanings in a bounded strip.

Version 0.4.4 corrects the icon presentation after a real high-DPI terminal
showed that 24-pixel assets compressed into one terminal row became narrow and
blurred despite image fitting. Raster icons now require a two-row,
cell-aspect-aware slot and higher-resolution source; one-row surfaces use
typography instead. The misleading model/brain icon and text-glyph icon fallback
are removed. This changes no Event, State, configuration, or Thread data.

Version 0.4.5 withdraws the raster-image direction after real-terminal review
showed that larger source assets still produced an alien, oversized visual
language and retained protocol-dependent rendering. Feature icons are now fixed
logical pixel matrices drawn directly into terminal cells with block and ASCII-
compatible characters. The reference TUI no longer creates `ImageRenderable`
nodes or depends on Kitty, Sixel, terminal pixel geometry, or bundled image
assets. This is presentation-only and changes no Event, State, configuration,
or Thread data.

Version 0.4.6 withdraws the custom cell-art direction after placement review
showed that an eight-column by three-row block icon dominated its section label,
while smaller packed matrices lost recognizable meaning. OpenTUI and current
ecosystem practice use normal one-row text glyphs for status and Tool markers.
The reference TUI now follows that boundary: one portable glyph inside a
two-column gutter, with the adjacent label as semantic authority. This is
presentation-only and changes no Event, State, configuration, or Thread data.

Version 0.4.7 separates compact semantic markers from the empty workspace's
brand illustration. Attention and Tool markers remain one-cell text glyphs;
only the roomy empty workspace gains an original multi-row logical-pixel mark
of two reaching hands and a creation spark, rendered through normal text flow.
The static command inventory is replaced by one slash-discovery hint while the
existing command menu remains authoritative. This is presentation-only and
changes no Event, State, configuration, or Thread data.

Version 0.4.8 aligns local file access with the reference TUI's already
disclosed unsandboxed shell. `@jixu/tools-node` keeps `workspace` as its secure
default and adds an explicit `process` scope; the reference TUI selects that
scope so an absolute user-requested path does not succeed through `bash` and
then fail through `edit`. Known path-policy rejection is now a typed failed Tool
outcome, while unknown post-dispatch exceptions remain indeterminate. The TUI
also separates transient current-work Tool status from Event-derived transcript
receipts, which remain visible across final responses, later inputs, and Thread
reopen. These changes require no Event or configuration migration and do not
rewrite stored Threads. The pre-release exported `TranscriptEntry` presentation
type is now a discriminated union of message and Tool-receipt entries; consumers
that render controller snapshots must branch on `kind`. The reference Agent
contract advances from version 1 to version 2 because its declared file
capabilities changed. Its immutable Agent snapshot is intentionally incompatible
with pre-release Threads created under version 1; create a new Thread after the
upgrade. Existing Events remain untouched and inspectable by their original
compatible Harness.

Version 0.4.9 moves transient Thinking and planning presentation from the fixed
Composer footer into one ephemeral `JIXU` row in transcript flow. Streaming
text and Tool receipts take precedence so the UI shows only the current causal
surface; subsequent model work may create a new ephemeral row after a Tool
outcome. The row is derived from the existing transient controller snapshot and
never enters Events, committed transcript history, State, Replay, or model
context. The Composer footer now remains stable during live work. This is a
presentation-only change and requires no Event, configuration, or stored Thread
migration.

Version 0.4.10 applies the existing bounded per-character motion treatment to
the canonical `Thinking ...` label as well as the `JIXU` role marker. Both remain
normal fixed-width text nodes; arbitrary public progress prose stays static.
This is presentation-only and requires no Event, configuration, or stored
Thread migration.

Version 0.4.11 tightens ordinary transcript role spacing and removes the
redundant `YOU` label from the Composer. The editor keeps its accent rule and
normal focus behavior, while committed user messages retain their `YOU` role in
transcript history. This is presentation-only and requires no Event,
configuration, or stored Thread migration.

Version 0.4.12 corrects Tool receipt authorship in the transcript. A receipt
group now retains the `JIXU` role anchor even when the model emits no public text
before requesting a Tool, so it cannot appear to belong to the preceding user
message. Receipt ordering and durable projection remain unchanged. This is
presentation-only and requires no Event, configuration, or stored Thread
migration.

Version 0.4.13 turns durable Tool receipts into a compact Agent action stream.
Receipt grouping now follows the model Event that requested the Effects instead
of merging adjacent Tool-only decisions, terminal rows derive concise outcomes
from typed Tool results, and large historical groups collapse to factual counts
with a keyboard expansion path. The Node `bash` Tool emits bounded transient
`tool.output.delta` Signals for a live tail; those Signals remain optional and
non-authoritative, while completed previews are reconstructed from durable Tool
outcomes. This changes the pre-release exported receipt projection types and
adds an observable Signal type, but requires no Event, configuration, or stored
Thread migration.

Version 0.4.14 makes Configuration a reversible workspace view and adds
protocol-specific Base URL presets. Opening the form no longer clears the
active connection, while `Escape` and the visible Back control abandon
incomplete edits and return to the same selected Thread. Presets populate the
existing Base URL field and persist no provider identity, so settings schema
version 3, Events, State, Replay, and stored Threads require no migration.

Version 0.4.15 replaces ambiguous Configuration chrome with separately laid-out
file, keyboard-action, workspace, and quit groups. The wide frame names the
settings and API-key files explicitly; compact frames retain the filenames and
essential actions without punctuation-delimited status prose. This is a
presentation-only correction and requires no Event, configuration, or stored
Thread migration.

Version 0.4.16 adds a bounded terminal-native `JIXU` wordmark after ordinary
interactive CLI shutdown. It is emitted only after the OpenTUI renderer returns
terminal ownership, distinguishes user/SIGINT exit from termination or failure,
and respects TTY and `NO_COLOR` boundaries. This changes no Harness, Thread,
Event, configuration, or package API semantics and requires no migration.

Version 0.4.17 turns each visible Tool operation into an independent disclosure
row and bounds expanded details to an internally scrollable eight-row surface.
The `edit` disclosure presents the durable requested old/new fragments as a
replacement diff, while other first-party Tools expose bounded request and
outcome detail reconstructed from their existing Events. Disclosure state is
remembered per Thread only for the current TUI process and never enters durable
State. The pre-release exported `ToolOperation` projection gains typed request
detail, but Event schema version 5, configuration, Replay, and stored Threads
require no migration.

Version 0.4.18 gives transcript Markdown a Jixu-native syntax palette for fenced
code. JavaScript and TypeScript fences use the parsers bundled with the current
OpenTUI runtime; other fences remain readable through the themed raw-code
fallback unless a maintained parser is available. This is a presentation-only
change and requires no Event, State, configuration, Replay, or stored Thread
migration.

Version 0.4.19 corrects bounded detail and code layout after real-terminal
review showed that a maximum height alone caused short Tool details to reserve
the full viewport and that long code blocks could dominate the transcript.
Tool detail and framed code surfaces now use natural height before their eight-
and twelve-row bounds, respectively, and only overflowing content scrolls.
HTML and HTM fences use the already bundled TypeScript-React parser as a
documented compatibility highlighter instead of silently falling through as an
unknown language. This changes no dependency, Event, State, configuration,
Replay, or stored Thread data.

Version 0.4.20 replaces source-like Markdown presentation with compact semantic
document surfaces. Stable headings, quotes, rules, task lists, tables, inline
styles, and fenced code no longer expose their Markdown delimiters; code frames
also label their normalized language. JSON and JSONC join HTML and HTM as
zero-dependency compatibility mappings to parsers already bundled by OpenTUI.
The change is presentation-only and adds no dependency, Event, State,
configuration, Replay, or stored Thread migration.

Version 0.4.21 adds pinned, local Bash and Python Tree-sitter assets to the
reference TUI. Bash covers the `bash`, `sh`, and `shell` fence labels; Python
covers `python` and `py`. The generated runtime descriptors and copied package
assets are derived from one immutable-source configuration and perform no
runtime download. This is a presentation and package-artifact change only; it
changes no Event, State, configuration, Replay, or stored Thread data.

Version 0.4.22 gives `/resume` a three-to-six-row native selection viewport and
restores transcript bottom-following when the user explicitly submits new input
from a historical scroll position. Model and Tool growth alone still does not
steal the user's reading position. Both changes are presentation-only and
require no Event, State, configuration, Replay, or stored Thread migration.

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
