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

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)
- [Specification](https://github.com/joe960913/Jixu/blob/main/SPEC.md)

## License

MIT
