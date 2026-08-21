# Jixu

Jixu is a durable single-Agent Harness for TypeScript. Install the TUI, run
`jixu`, and continue work in a durable Thread.

> Jixu is pre-1.0. The public API may change before 1.0.

![Jixu terminal interface](https://raw.githubusercontent.com/joe960913/Jixu/main/assets/jixu-tui.webp)

## Install

```bash
npm install -g jixu-ai
# pnpm add -g jixu-ai
# bun add -g jixu-ai
```

Then start Jixu from any terminal:

```bash
jixu
```

Ephemeral execution is also supported:

```bash
npx jixu-ai
# pnpm dlx jixu-ai
# yarn dlx jixu-ai
# bunx jixu-ai
```

Supported native targets are macOS arm64, macOS x64, and Linux x64 with glibc.
Node.js 22.19.0 or newer is required. Bun is not required at runtime.

## Agent Framework

The Framework packages remain independently installable:

```bash
npm install jixu-core jixu-llm jixu-store-sqlite
```

The ordered Event log is the source of truth. State is derived from Events, and
external work follows one path:

```text
Event -> Reducer -> Effect -> Driver -> Event
```

See the [repository](https://github.com/joe960913/Jixu) for the specification,
documentation, and source code.

## License

MIT
