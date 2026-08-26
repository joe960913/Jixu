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

> [!WARNING]
> The Bash Tool is not OS-sandboxed and runs with the permissions of the current
> process. Keep it behind an explicit `ASK` policy unless you accept that risk.

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)

## License

MIT
