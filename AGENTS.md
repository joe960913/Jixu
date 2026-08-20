# Jixu Repository Instructions

These instructions apply to every human or AI agent changing this repository.

## 1. Read order

Before proposing or making a change, read:

1. `SPEC.md` — normative product behavior and architecture;
2. this file — repository working rules;
3. the relevant implementation and tests; and
4. any directly relevant ADR or package documentation.

Do not infer architecture from filenames, examples, or provider SDKs when the
specification already defines it.

## 2. Sources of truth

- The ordered durable Event log is the sole authority for a Thread.
- State is derived from Events.
- A Checkpoint is a disposable performance cache.
- A Signal is transient and non-authoritative.
- Provider conversation state, UI state, traces, and in-memory objects are not
  runtime authority.
- `SPEC.md` is the authority for public semantics and package boundaries at the
  current commit. It is a living specification, not an immutable artifact.

Never introduce a second Thread state machine, a second Event history, or a
second component that can independently decide canonical Thread status.

## 3. Canonical concepts

Use the terminology in `SPEC.md` exactly:

- `Harness` owns exactly one immutable Agent and binds Stores and Drivers to the
  Kernel, but is not durable authority.
- `Agent` is immutable configuration and never hands work to another Agent.
- `Thread` is one durable, multi-turn history for that Agent.
- `Kernel` is I/O-free domain logic.
- `Event` is an immutable durable fact.
- `Signal` is a transient observation.
- `State` is the deterministic Event projection.
- `Reducer` is pure.
- `Effect` requests external work.
- `Driver` performs an Effect.
- `Tool` acts.
- `Skill` supplies instructional context.
- `Checkpoint` accelerates recovery but is not authority.
- `Fork` creates a new Thread.
- `Replay` performs no Effects.

Do not introduce `session`, `conversation`, `run`, `workflow`, `job`, or `task`
as a synonym or wrapper for Thread. Multi-Agent orchestration, handoff,
supervisors, swarms, Agent graphs, and Agent-as-Tool are outside the Jixu core
model. If an application needs a different Agent, it creates a different
Harness rather than adding Agent routing to one Harness.

If a proposed concept overlaps an existing term, stop and simplify instead of
adding another noun.

## 4. Architecture invariants

All implementation must preserve these invariants:

1. Externally observable work follows
   `Event -> Reducer -> Effect -> Driver -> Event`.
2. An external Effect is durably requested before dispatch.
3. Reducers do not perform I/O, read clocks, generate random IDs, or call SDKs.
4. Adapters depend on core ports; core never imports adapters.
5. Replay is read-only and never dispatches a live Driver.
6. Fork creates a new Thread with explicit parent lineage.
7. Unknown event types and schema versions fail closed.
8. Secrets never enter Events, Checkpoints, errors, or Signals.
9. Exactly-once behavior is never claimed without an enforceable idempotency
   contract.
10. Normal users do not write Reducers or manually construct Events.

## 5. Spec-driven workflow

`SPEC.md` records the best current understanding of Jixu. Development is
expected to expose incorrect assumptions, missing failure modes, or simpler
designs. Treat that evidence as input to the specification instead of forcing
the implementation to preserve a stale idea.

Spec-driven means the specification and implementation evolve together in a
controlled order. It does not mean the first specification is permanently
correct.

### When implementation evidence disagrees with the spec

1. Reproduce or otherwise verify the mismatch with code, tests, upstream
   behavior, or a concrete constraint.
2. Decide whether the mismatch is an implementation bug, an adapter detail, or
   a wrong/incomplete product assumption.
3. Record the evidence and the affected `JX-*` requirements.
4. Update `SPEC.md` to the smallest coherent design that explains the evidence.
5. Preserve stable requirement IDs where their meaning remains intact. Deprecate
   or replace an ID explicitly; never silently reuse it for different semantics.
6. Update acceptance criteria and compatibility or migration notes.
7. Then change the implementation and tests to match the revised spec.

Do not contort code around a disproven requirement. Do not silently make the
code authoritative either.

An evidence-backed spec correction that stays within the accepted goals,
non-goals, public promise, and task scope MAY be made in the same change as its
implementation. A change to project goals, non-goals, the public promise,
security guarantees, compatibility policy, or milestone scope requires explicit
maintainer direction before implementation.

Significant decisions SHOULD receive an ADR explaining the evidence and rejected
alternatives. Minor clarifications do not need an ADR. Avoid speculative spec
churn without implementation evidence or a concrete user requirement.

Before implementation, classify the change:

### Scoped UI change

A localized UI bug fix, interaction correction, copy/spacing/color polish, or
component-level presentation change does not require a `SPEC.md` update or new
stable `JX-*` requirement when it preserves public semantics, canonical
concepts, architecture, persisted data, package APIs, and milestone scope.
Treat these changes as implementation work even when the visible behavior is
intentionally corrected.

Update `SPEC.md` first only when UI work is a redesign or refactor-level change,
changes the UI architecture or cross-screen interaction model, or materially
changes a public promise or acceptance boundary. Do not create normative spec
churn for routine UI iteration.

### Behavior or architecture change

1. Update `SPEC.md` first.
2. Add or modify stable `JX-*` requirement IDs.
3. State the affected packages, compatibility impact, and migration path.
4. Define or update release-blocking acceptance criteria.
5. Only then implement the narrowest design that satisfies the spec.

### Behavior-preserving implementation change

1. Cite the existing `JX-*` requirements it preserves.
2. Confirm that no public semantics or canonical terms change.
3. Keep the diff scoped to the implementation problem.

Do not implement unspecified behavior and document it afterward.

## 6. Planning expectations

At the start of substantive work, state:

- intended outcome;
- affected requirement and acceptance IDs;
- files or packages expected to change;
- important non-goals; and
- validation commands.

For a scoped UI change exempted by §5, requirement and acceptance IDs are
optional when no existing ID directly governs the behavior.

If evidence contradicts the spec, follow the evolution process in §5. Continue
through the spec update and implementation when the correction stays within the
authorized scope; stop for maintainer direction only when it materially changes
the product or scope.

## 7. Release-quality standard

Every accepted development request MUST be implemented to a publishable standard
within its stated milestone boundary. A working demo, toy implementation, happy-path
prototype, or repository-only shortcut is evidence for exploration, not a completed
deliverable.

- Prefer current, maintained, ecosystem-native primitives and official extension
  points. "Modern" means supported, interoperable, well-understood, and simpler to
  operate; it does not mean adopting the newest dependency without evidence.
- Design the public API, package boundary, configuration, errors, types, security,
  compatibility, documentation, and upgrade path as parts of the implementation,
  not as cleanup deferred until publication.
- Exercise the real public entry point and ordinary consumer path. Build, test,
  package, and publish MUST use the same artifact pipeline and the same authoritative
  metadata; a synthetic test artifact cannot stand in for the artifact that will be
  released.
- Keep one source of truth for release metadata and runtime semantics. Generated or
  transformed output MUST be mechanically derived from that source and verified for
  drift.
- Use realistic failure paths and clean-environment acceptance checks. A milestone is
  not complete when it works only inside the monorepo, through private imports, with
  undeclared dependencies, or via a demo-only bypass.
- Optimize for clarity and long-term maintenance before cleverness. Avoid both
  speculative abstraction and expedient duplication that makes the release path
  harder to explain.
- A spike or prototype MAY be used to reduce uncertainty, but it MUST be explicitly
  labeled, isolated from the release path, and given an exit decision. It cannot
  satisfy a milestone acceptance criterion or be presented as finished product code.
- Any deliberate release-quality gap MUST be named before implementation with its
  reason, risk, owner, removal milestone, and release impact. Do not silently defer a
  known release blocker to a later milestone.

When choosing between a shortcut and a release-quality design inside the accepted
scope, choose the release-quality design. If that choice would materially expand the
milestone, surface the conflict and revise the scope or specification explicitly
instead of silently shipping the shortcut.

## 8. Implementation rules

- Prefer plain TypeScript and explicit data flow over decorators, reflection,
  registries, or hidden global state.
- Keep `core` free of provider SDKs, MCP SDKs, database drivers, web frameworks,
  and CLI frameworks.
- Keep durable data JSON-serializable and schema-versioned.
- Inject clocks, ID generation, Drivers, Stores, and Signal sinks.
- Preserve provider-native metadata only behind typed adapter boundaries.
- Use exhaustive discriminated unions for lifecycle, Event, Effect, and outcome
  handling.
- Fail closed when persisted data is unknown or incompatible.
- Avoid generic abstractions until at least two concrete use cases require the
  same behavior.
- Do not add a dependency when a small local implementation is clearer, but do
  not recreate an ecosystem protocol that Jixu should adapt to.

### UI architecture and iteration discipline

- Prefer the framework's maintained native component and focus model when they
  directly implement the required interaction. Reject a native primitive only
  for a verified behavioral or compatibility constraint, not an assumed one.
- A UI source file MUST NOT become a catch-all for application orchestration,
  screen-specific state, forms, transcript rendering, command metadata, and
  keyboard interaction. Split these responsibilities before adding behavior;
  a thousand-line UI module is an architecture failure, not an acceptable
  intermediate state.
- Keep command metadata and other reusable behavior in one typed source of
  truth. Views render that model; they do not duplicate command lists or grow a
  second interaction state machine.
- Use normal layout flow for ordinary page structure and reserve overlays,
  absolute positioning, negative margins, opacity stacking, and forced remount
  keys for requirements that demonstrably need them.
- After two failed attempts at the same UI interaction, stop editing production
  code. Re-check the current framework API and reduce the problem to one
  isolated proof before choosing the final implementation. Remove exploratory
  code before resuming the release path.
- Choose and explain the smallest release-quality design before implementation.
  Do not make the maintainer pay for repeated speculative production patches or
  for avoidable architectural churn.

## 9. Testing rules

Tests must focus on load-bearing behavior, failure paths, and regressions.

- Every behavior test cites one or more `JX-AC-*` acceptance IDs in its name or
  adjacent comment.
- Reducer tests are deterministic and perform no I/O.
- Driver contract tests cover success, typed failure, cancellation,
  indeterminate outcomes, and idempotency identity.
- Recovery tests inject failures at append/dispatch/outcome boundaries.
- Replay tests assert that no live Driver was called.
- Fork tests assert parent immutability and exact State at the fork point.
- Store contract tests run against every Store adapter.
- Provider tests distinguish mocked contract tests from explicitly enabled live
  probes.
- Do not add low-value tests that only repeat TypeScript or library behavior.
- UI changes do not require an automated test by default. Add or update one
  only when it protects a core user path, durable state or data safety, a
  high-risk failure boundary, or a regression that has actually recurred. Do
  not freeze ordinary spacing, colors, wording, exact row or column positions,
  or incidental pointer and focus styling in tests; review those visually.
- Add the minimum test surface that proves the user-visible contract. Extend an
  existing acceptance or smoke test when the behavior belongs to that same
  public path; create a new test file only for an independent unit or contract
  with a distinct failure boundary.
- One user-visible behavior MUST NOT be scattered across multiple new test
  files. Temporary harnesses and spike tests MUST be removed once the behavior
  is covered through the ordinary public path.
- In OpenTUI React tests, an input or mouse interaction that schedules React
  state and the renderer pass that verifies it MUST use separate `act()` calls.
  State commits when the interaction `act()` exits; rendering inside that same
  `act()` observes the old frame and is a test-ordering bug, not evidence that
  production interaction failed.

A milestone with a developer-facing surface is not complete until its documented
acceptance path can be run by a maintainer. Internal tests alone cannot close
that milestone. The runnable path MUST exercise the ordinary public concepts;
do not invent a demo-only Agent subtype, state machine, or bypass around the
Harness.

The minimum validation for a code change is targeted tests, typecheck, lint, and
`git diff --check`. Release work also runs the full acceptance suite.

## 10. Documentation rules

- Use one canonical term for one concept.
- Separate normative guarantees from illustrative examples.
- Mark planned APIs as planned until they are published.
- Do not advertise exactly-once execution, deterministic model behavior, or
  distributed durability beyond what `SPEC.md` guarantees.
- Update README examples when a public API changes.

### Stage records

After each implementation stage passes its required validation, create one
Chinese retrospective in `docs/stages/` before reporting the stage complete.
Use the local template in that directory and record:

- the stage goal, requirement IDs, and boundary;
- why the architecture and trade-offs were chosen;
- how the implementation works through the canonical execution model;
- technologies and language/runtime features used;
- validation evidence, failures encountered, and lessons learned;
- known limitations, deferred work, and the next stage boundary.

Routine UI bug fixes, interaction details, and visual polish do not require a
stage record. Create one for UI work only when it is a redesign or
refactor-level change, or when it is part of a broader implementation milestone
that independently requires a retrospective.

These records are repository documentation and MAY be tracked, committed, and
published with the rest of the project. They are explanatory rather than
normative; `SPEC.md` remains authoritative. Do not exclude `/docs/` through
`.gitignore` or `.git/info/exclude` unless the maintainer explicitly changes
that policy.

## 11. Change discipline

- Branch names MUST NOT use the `codex/` prefix. Use a concise milestone or
  intent name such as `m2-continuity` or `fix/revision-conflict`.
- Complete and validate each milestone locally, then stop for maintainer
  acceptance. Commit, push, and merge only after the maintainer explicitly
  accepts that milestone.
- This repository currently has one maintainer. After acceptance, routine and
  milestone-sized changes SHOULD be pushed and merged directly without a pull
  request. Use a pull request only when the maintainer explicitly asks for one
  or when a change is exceptionally large or high-risk and benefits materially
  from a separate review surface.
- Preserve unrelated user changes.
- Do not make drive-by refactors or repository-wide formatting changes.
- Do not update generated files, snapshots, dependencies, or lockfiles unless
  they are part of the stated scope.
- Do not add hosted services, telemetry, or network writes by default.
- Use terse commits that describe the intent of the complete diff.

The architecture should become easier to explain after every change. If a
change requires more concepts to describe the same lifecycle, reconsider it.
