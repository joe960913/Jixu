# jixu-tools-node

Opt-in local file and shell Tools for Jixu.

```bash
npm install jixu-core jixu-tools-node
```

```ts
import { createNodeTools } from "jixu-tools-node";

const tools = createNodeTools({ root: process.cwd() });
```

The package provides `read`, `write`, `edit`, and `bash`. File access can
be limited to a workspace root.

`bash` runs one foreground command with a 30-second default timeout. A call can
request up to the configured maximum through `timeoutMs` (five minutes by
default). Timeout and cancellation terminate the managed foreground process
group or tree, preserve the bounded stdout/stderr already received, and stop
waiting for inherited output pipes after a fixed drain budget. They never
silently convert a command into a background task. A failure to issue
process-tree termination or confirm pipe closure before that drain deadline
remains an indeterminate Tool outcome rather than a completed timeout. POSIX
process groups contain ordinary descendants; they are lifecycle management,
not an OS sandbox or a claim that a process which deliberately creates a new
session remains contained.

> [!WARNING]
> The Bash Tool is not OS-sandboxed and runs with the permissions of the current
> process. Keep it behind an explicit `ASK` policy unless you accept that risk.

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)

## License

MIT
