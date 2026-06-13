## Outcome

<!-- Describe the user-visible or architectural outcome, not only the files changed. -->

## Behavior contract

- Requirements: `JX-...`
- Acceptance criteria: `JX-AC-...`
- Public behavior change: yes / no

Describe the observable contract, or explain why this change preserves existing
behavior:

## Architecture check

- [ ] The durable Event log remains the only Run authority.
- [ ] No canonical concept gained a second name or competing lifecycle.
- [ ] External work still crosses the Effect/Driver boundary.
- [ ] Replay performs no live Effects, and Fork creates a new Run.
- [ ] Kernel code does not depend on adapters.

## Validation

- [ ] Targeted tests
- [ ] Typecheck
- [ ] Lint
- [ ] `git diff --check`

List the exact commands and results:

```text

```

## Compatibility and migration

<!-- State the compatibility impact and migration path, or write "None". -->
