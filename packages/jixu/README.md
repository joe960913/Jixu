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

## Local Skills

Open `/config` and choose **SKILLS** (F2 cycles tabs; Ctrl+3 jumps directly when supported). Use **NEW** (Ctrl+N) to enter a
name, description, version and multiline instructions. **DONE** (Ctrl+S) keeps
an edit in the draft list; **APPLY** (Ctrl+S from the list) saves all settings and
opens a fresh workspace. Enter edits the selected Skill, Space toggles it and
Ctrl+D removes it. Every action also has a mouse target. Escape cancels an edit
or returns to Connection; Back to chat discards unapplied changes.

Enabled Skills expose their metadata to the Agent; their exact bodies enter
Context only after progressive activation. Disabled entries remain saved but
are omitted from the Agent. Instructions are trusted local configuration and
must not contain secrets. The manager stores explicit records in the same
`~/.jixu/settings.json` (schema 7); it does not scan or install files. Existing
schema 3-6 settings load with no Skills, and their connection and Tool values
are preserved. Limits include disabled entries: 16 Skills, 16 KiB per body and
64 KiB of bodies in total. Names are unique lowercase ASCII slugs.

Changing enabled Skills creates a different Agent configuration. Existing
Threads remain on disk; restore their original enabled names, descriptions,
versions and bodies before reopening them. Apply does not migrate their Events.
Enabled entries are sorted by name when constructing the Agent, so local list
order does not change recovery compatibility. A failed Apply leaves the previous
saved configuration in place. `/inspect`
shows the selected Thread's Event-derived `activatedSkills`; ON in this manager
means available, not already activated.

For applications that use the same settings format, `JixuConfigStore.load()`
returns normalized `skills`. `parseJixuSkills(value)` validates an untrusted
collection; `jixuSkills(settings.skills)` returns the enabled, immutable
`SkillDefinition` values for `defineAgent({ skills })`. `saveConnection` accepts
an optional `skills` array; omitting it saves an empty collection.

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
