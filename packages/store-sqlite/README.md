# jixu-store-sqlite

A local SQLite Event Store for Jixu.

```bash
npm install jixu-core jixu-store-sqlite
```

```ts
import { SqliteEventStore } from "jixu-store-sqlite";

const store = new SqliteEventStore("./.jixu/jixu.db");
```

The Store persists Events, Checkpoints, and immutable Artifacts in one local
database. Events remain the durable authority.

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)

## License

MIT
