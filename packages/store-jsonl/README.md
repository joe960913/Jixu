# jixu-store-jsonl

An inspectable local JSONL Event Store for Jixu.

```bash
npm install jixu-core jixu-store-jsonl
```

```ts
import { JsonlEventStore } from "jixu-store-jsonl";

const store = new JsonlEventStore("./.jixu");
```

Events, Checkpoints, and immutable Artifacts are stored on disk. Events remain
the durable authority; Checkpoints are disposable acceleration data.

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)

## License

MIT
