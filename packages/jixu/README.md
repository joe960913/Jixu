# Jixu

Jixu is a durable single-Agent Harness for TypeScript. Install the native TUI,
run `jixu`, and continue work in a durable Thread.

> Jixu is pre-1.0. The public API may change before 1.0.

![Jixu terminal interface](https://raw.githubusercontent.com/joe960913/Jixu/main/assets/jixu-tui.webp)

## Install

```bash
npm install -g jixu-ai
jixu
```

Global installation also works with `pnpm add -g jixu-ai` and
`bun add -g jixu-ai`. To run without installing:

```bash
npx jixu-ai
# pnpm dlx jixu-ai
# yarn dlx jixu-ai
# bunx jixu-ai
```

The launcher requires Node.js 22.19.0 or newer. Native targets are macOS arm64
and Linux x64 with glibc.

## Framework

`jixu-ai` is also the framework entry point. The TUI uses the same public
Agent, Harness, Thread, Store, and Driver APIs as any other Jixu application.

```bash
npm install jixu-core jixu-llm jixu-store-sqlite
```

The ordered Event log is the source of truth. State is derived from Events, and
external work follows one path:

```text
Event -> Reducer -> Effect -> Driver -> Event
```

> [!WARNING]
> Jixu's Bash Tool is not OS-sandboxed and runs with the permissions of the Jixu
> process. Permission controls approve Tool calls, not individual shell
> operations. Keep Bash on `ASK` and use a backed-up or disposable workspace.

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)
- [Specification](https://github.com/joe960913/Jixu/blob/main/SPEC.md)
- [Discussions](https://github.com/joe960913/Jixu/discussions)

## License

MIT
