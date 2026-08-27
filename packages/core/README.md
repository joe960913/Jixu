# jixu-core

The public Harness, Thread API, deterministic Kernel, and extension ports for
Jixu.

```bash
npm install jixu-core
```

`jixu-core` owns the durable execution model:

```text
Event -> Reducer -> Effect -> Driver -> Event
```

The Kernel derives State and Effects without performing I/O. Model providers,
Tools, and Stores connect through public ports and do not own Thread state.

An active Plan protects completed and in-progress facts while allowing pending
steps to change with new evidence. Reserved Plan and progress controls never
perform work: after a control-only outcome, the Kernel can create at most one
durable execution-only model continuation, and provider Drivers expose only the
ordinary Tools on that request.

When a dispatched Tool has an indeterminate outcome, the Thread retains that
exact Effect and waits. Applications resume it explicitly with
`thread.resolveToolOutcome({ effectId, resolution })`, where `resolution` is
`occurred`, `not_occurred`, or `abandoned_unknown`. The durable decision informs
one ordinary model continuation; it never fabricates Tool output or
automatically redispatches the original Effect.

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)
- [Specification](https://github.com/joe960913/Jixu/blob/main/SPEC.md)

## License

MIT
