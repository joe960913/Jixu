# Contributing to Jixu

Jixu uses acceptance-driven development. Contributions are welcome, but public
behavior must be explicit before its implementation is merged.

## Before opening a change

1. Read the README, relevant implementation, and load-bearing tests.
2. Identify the affected behavior and existing `JX-*` or `JX-AC-*` IDs.
3. Confirm whether the proposal changes behavior or only implementation.
4. Keep the proposal scoped to one coherent outcome.

## Behavior changes

A behavior or architecture proposal must explain:

- the problem and user-visible outcome;
- the canonical concepts involved;
- which component owns authoritative state;
- serialization and compatibility impact;
- failure and recovery behavior;
- affected stable requirement IDs; and
- acceptance tests that would prove the change.

Implementation should not be merged before the proposed behavior is internally
consistent and testable.

## Pull request checklist

- [ ] The PR identifies the affected behavior and relevant requirement IDs.
- [ ] Public documentation is updated when observable behavior changes.
- [ ] No new synonym or competing state authority was introduced.
- [ ] The Kernel/adapter dependency direction remains intact.
- [ ] Load-bearing tests cite affected `JX-AC-*` IDs.
- [ ] Failure, cancellation, recovery, and replay paths were considered.
- [ ] Targeted tests, typecheck, lint, and `git diff --check` pass.
- [ ] Documentation and examples match the actual public API.

## Scope

Small, reviewable changes are preferred. A pull request should solve one
coherent problem and avoid unrelated formatting, dependency, or API changes.

## License

By contributing, you agree that your contributions are licensed under the MIT
License.
