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

An active Plan protects completed and in-progress facts while allowing pending
steps to change with new evidence. Reserved Plan and progress controls never
perform work: after a control-only outcome, the Kernel can create at most one
durable execution-only model continuation, and provider Drivers expose only the
ordinary Tools on that request.

When a dispatched Tool has an indeterminate outcome, the Thread retains that
exact Effect and waits. Applications resume it explicitly with
`thread.resolveToolOutcome({ effectId, resolution })`, where `resolution` is
`occurred`, `not_occurred`, or `abandoned_unknown`. The durable decision informs
one ordinary model continuation; it never fabricates Tool output or
automatically redispatches the original Effect.

## Progressive Skills

Available in Jixu 0.5.0:

```ts
import { defineAgent, defineSkill } from "jixu-core";

const designReview = defineSkill({
  name: "design-review",
  description: "Use when reviewing a proposed software design.",
  version: "1",
  instructions: "Identify the main failure boundary, explain its consequence, and propose one concrete verification step. Separate observed evidence from assumptions.",
});

const agent = defineAgent({
  instructions: "Be precise and use relevant Skills.",
  model: { provider: "model", model: connection.model },
  modelCapabilities,
  skills: [designReview],
});
```

Here `connection` and `modelCapabilities` are the same resolved values as in the
[root framework example](https://github.com/joe960913/Jixu#use-jixu-as-a-framework).
Pass this Agent to the ordinary Harness with your Store and Model Drivers.
Applications do not construct Events or invoke activation controls themselves.
A custom Model Driver requests activation with
`{ content: "", toolCalls: [], skillActivation: "design-review" }` when that name
is available in `effect.input.skills.control`. The next request supplies the
accepted exact body in `effect.input.skills.active`.

An Agent holds at most 16 Skills, each with a 1-64 character lowercase ASCII slug,
a 1-512 character description, a 1-64 character version and 1-16,384 UTF-8 bytes
of instructions. Total body size is capped at 65,536 bytes; the model's smaller
Context budget can still reject an activation continuation before dispatch.
Instructions are trusted application configuration and must not contain secrets:
activated bodies are persisted and sent to the configured model.

Only catalogue metadata is disclosed initially. The reserved
`jixu_activate_skill` name is reserved only for Agents with a non-empty Skill
catalogue; Agents without Skills retain historical ordinary Tools with that name.
The control activates one inactive entry per response, without
ordinary Tool calls or Plan changes in that response. Invalid, repeated or
unavailable activation fails explicitly; it does not retry or dispatch sibling
Tools. Prose accompanying activation stays in the Event and public transcript,
but is omitted from model-message history so continuation never relies on an
assistant prefill. Accepted Skills remain active until `thread.clear()`. Their bodies remain
exact through compaction; they are not replaced by a generated summary. Recovery
rejects a changed catalogue or body. To adopt changed Skills, create a new Agent
and Thread. The reference TUI manages explicit local Skills through
`/config` → **SKILLS**. There is no filesystem scanning or hot reload.

The body digest uses the existing canonical JSON drift detector, not a security
signature. Skills do not grant Tool permissions. The same application owns the
trust boundary as for its Agent instructions.

## Links

- [Documentation](https://jixu.dev/docs)
- [GitHub](https://github.com/joe960913/Jixu)
- [Specification](https://github.com/joe960913/Jixu/blob/main/SPEC.md)

## License

MIT
