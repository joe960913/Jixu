# jixu-llm

Model Drivers and capability resolution for Jixu.

```bash
npm install jixu-core jixu-llm
```

The package supports OpenAI Chat Completions and Anthropic Messages behind the
same Jixu Model Driver port. Use `resolveLLMModelCapabilities` before Agent
creation and `createLLMModelDriver` to connect the resolved model.

Provider state is never the authority for a Thread.

Current source and locally packed artifacts also support progressive Skills
(available since 0.5.0). Both protocols expose the reserved
`jixu_activate_skill` control from the Context Compiler's available catalogue,
parse it into a model activation request, and render accepted Skill bodies in
instructional context. The control never dispatches a Tool. See the
[core configuration and limits](../core/README.md#progressive-skills).

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)
- [Specification](https://github.com/joe960913/Jixu/blob/main/SPEC.md)

## License

MIT
