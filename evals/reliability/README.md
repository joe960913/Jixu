# Reliability acceptance

Run the deterministic release gate for `JX-AC-061` through `JX-AC-065`:

```sh
pnpm run check:release
git diff --check
```

It covers partial and final unknown-outcome resolution, recovery boundaries,
parallel Search/Reader execution, bounded Plan-control recovery, historical
Event compatibility, and Bash process-tree termination. It also builds real
package artifacts and installs them in clean npm, pnpm, Yarn, and Bun consumers.
Native executable checks apply to the host target; release publication still
requires the complete supported-target matrix.

## Optional paid provider check

```sh
node scripts/probe-reliability.ts \
  --acknowledge-paid-requests=24 \
  --acknowledge-jina-requests=3
```

Review and explicitly authorize the paid request ceilings before running this
command. With missing or incorrect acknowledgements it exits before credential
access, package installation, or network access. The ceilings are enforced at
HTTP dispatch; they are not a USD price limit. Requests are sequential between
cases, without automatic retries. Each model HTTP request has a 60-second
timeout. Provider billing may include a timed-out request even if no usage is
returned, so unpriced outcomes must not be interpreted as free requests.

The command reads the existing `~/.jixu/settings.json` only after acknowledgement.
It currently requires an OpenRouter Chat Completions connection, a model Key,
and a Jina Key. It uses the saved model for Chat Completions and
`anthropic/claude-haiku-4.5` through OpenRouter Messages. Model capacity is resolved
through the ordinary public resolver. It does not modify configuration, existing
Threads, global installations, or published packages.

The same `buildPackageArtifacts` pipeline used by packaging creates the library
tarballs. The command installs their exact paths into a separate npm consumer
and resolves only public package exports. Synthetic inputs use the ordinary
`defineAgent`, `createHarness`, `Thread.send`, `resolveToolOutcome`, Replay, and
Jsonl Store paths. No reducer or Event is constructed by the probe.

The checks are:

- Both model protocols call one read-only fixture Tool whose response is
  deliberately indeterminate, explain the uncertainty, and wait. Explicit
  `abandoned_unknown` resolution produces exactly one continuation without
  repeating the Tool. Replay and reopening with checkpoints disabled must match
  State and dispatch no model work.
- The outcome decision must be acknowledged in the final text. Anthropic
  receives the same bounded operator receipt after the existing native Tool
  results, with no extra user message and no modified Tool result. This follows
  the documented [client Tool-result format](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).
- Both protocols create a Plan, revise only pending work with a sparse payload,
  retain the completed and in-progress facts and omitted fields, and finish a
  control-only continuation without another control loop.
- The saved model searches once, then reads two known public documentation URLs
  together and cites them. Search contains metadata only. This checks protocol
  and Tool integration; it does not evaluate autonomous source selection or
  general research quality.
- The installed Bash Tool times out a foreground command, preserves partial
  output, and settles within the bounded allowance. Stubborn descendants,
  cancellation, escaped pipe holders, and unknown outcomes are covered by the
  deterministic release tests rather than paid model requests.

Each invocation writes a unique directory under `.artifacts/reliability/` with
the package manifest, consumer, isolated JSONL Threads, and `report.json`.
The report records model identities and capacities, provider usage/cost when
available, request counts, checks, final text, Event types, and Event digests.
These are local evidence and are ignored by Git. The probe uses synthetic
fixtures and public pages only; credentials remain inside Driver closures.

For a focused follow-up on accepted Plan and outcome-resolution continuations:

```sh
node scripts/probe-reliability.ts --scope=continuations \
  --acknowledge-paid-requests=16 \
  --acknowledge-jina-requests=0
```

This skips the research case and makes no Jina requests. It retains both model
protocols and the installed Bash check. Request ceilings apply per invocation;
add the reports when accounting for a multi-attempt acceptance.

To isolate the Messages protocol, use `--scope=messages` with
`--acknowledge-paid-requests=7 --acknowledge-jina-requests=0`.

A failed live case stops subsequent cases and writes its available evidence.
Reports explicitly require manual semantic review. The bounded English reply
checks reject observed stale-wait and refused-Plan regressions, but a mechanical
pass cannot establish arbitrary natural-language correctness. Inspect final
text against the recorded decisions: accepting uncertainty must not be reported
as external success, and an accepted Plan must not be described as refused.
Inspect the report and Event log before deciding whether to change runtime code,
adjust a fixture, or authorize another bounded attempt. A green probe is a
specific provider observation, not a guarantee of deterministic model behavior.


## Progressive Skills

The deterministic gate also covers progressive activation, mixed/invalid
controls, schema compatibility, recovery after an append failure, exact Skill
bodies through compaction, Fork provenance and clear/reactivation. Every package
manager's clean consumer now exercises Skill activation and JSONL recovery using
the same tarballs that publication uses.

For paid acceptance of only the new Skill path:

```sh
node scripts/probe-reliability.ts --scope=skills \
  --acknowledge-paid-requests=6 \
  --acknowledge-jina-requests=0
```

This uses both model protocols, no Jina or Bash requests, and requires no Jina
credential. Each protocol should make exactly two model requests: catalogue-only
selection, then a body-dependent answer. The fixture asks for a synthetic receipt;
only the Skill body contains `ORCHID / COBALT / VERIFIED`. The probe checks exact
output, durable activation, no Tool dispatch, Replay and recovery with Checkpoints
disabled. Six HTTP requests is the hard total ceiling (not a USD cap); there are
no hidden retries. Review the report's output and usage before accepting the
stage. This verifies the protocol path, not general Skill selection quality.


To repeat only the Messages Skill case after reviewing a failure, add
`--protocol=messages` and change the paid ceiling to `2` (keeping `--scope=skills`
and the Jina ceiling at `0`). Each invocation records a separate report; add all
attempts when accounting for total acceptance cost. Do not count a body-dependent
answer with extra activation narration as passing the exact-format fixture.
