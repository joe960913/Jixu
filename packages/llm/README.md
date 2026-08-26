# jixu-llm

Model Drivers and capability resolution for Jixu.

```bash
npm install jixu-core jixu-llm
```

The package supports OpenAI Chat Completions and Anthropic Messages behind the
same Jixu Model Driver port. Use `resolveLLMModelCapabilities` before Agent
creation and `createLLMModelDriver` to connect the resolved model.

Provider state is never the authority for a Thread.

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)
- [Specification](https://github.com/joe960913/Jixu/blob/main/SPEC.md)

## License

MIT
