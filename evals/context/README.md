# Context quality gate

This maintainer gate measures Continuity Handoff fidelity without creating a
second Thread authority. The checked-in corpus is synthetic and contains no
credentials or private Thread data.

Run the deterministic offline gate:

```sh
pnpm run eval:context
```

The command performs no network request. It replays the same recorded Handoff
body through the OpenAI Chat Completions and Anthropic Messages compaction
adapters, then requires:

- 100% expected and critical fact recall;
- 100% valid source citations;
- zero unsupported facts; and
- zero forbidden claims.

Expected-fact matching permits source-grounded paraphrases in the correct
Handoff field. A composite expectation may be split across multiple facts in
that field only when their combined citations cover every required source and
their combined text remains source-grounded. Additional facts are accepted only
when their cited synthetic source has deterministic lexical support for the
statement. A forbidden marker is a failure when asserted, but a fact that
explicitly rejects, negates, or marks that text as untrusted is not misclassified
as the forbidden claim itself. Permission claims additionally preserve the
positive or negative polarity of their closest cited source clause.

It also audits the built-in model-capability catalogue's exact limits, match
examples, primary-source evidence URLs, verification dates, and revision.

## Opt-in live probe

The live path uses one exact OpenAI-origin model and one exact Anthropic-origin
model through OpenRouter's OpenAI Chat Completions and Anthropic Messages
protocols. Its config contains only endpoint metadata and one
environment-variable name; the API Key stays in the environment.

```sh
export OPENROUTER_API_KEY='...'

pnpm run eval:context:live -- \
  --config=evals/context/live-probe.example.json
```

The first invocation prints the exact maximum paid request count and refuses to
read credentials or access the network. Review that preflight, then repeat with
the exact acknowledgement it requests. For the current three-case, two-model
corpus:

```sh
pnpm run eval:context:live -- \
  --config=evals/context/live-probe.example.json \
  --acknowledge-paid-requests=6
```

Live reports are written with user-only permissions below
`.artifacts/context-quality/`. They contain model capability, accounting,
quality observations, the evaluator version, the corpus content SHA-256, and the
canonical Handoff generated from this public synthetic corpus so evaluator
changes can be replayed without another paid request. They never contain Keys,
protocol response envelopes, or private Thread data. Live probes disable hidden
retries and protocol fallback through the ordinary first-party
`ModelDriver.compact` boundary.

Replay a saved schema 3 report against the current corpus and deterministic
evaluator without reading credentials or using the network:

```sh
pnpm run eval:context -- \
  --live-report=.artifacts/context-quality/live-<timestamp>.json
```

Replay rejects a different corpus schema or content SHA-256, an unsupported
report/evaluator version, duplicate or missing protocol cases, and any result
that no longer satisfies the current gate.
