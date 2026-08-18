# 阶段 13：Cache-stable Agent Contract

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 |
| 状态 | Completed locally |
| 关联需求 | `JX-EVT-006`、`JX-CTX-014`、`JX-CTX-015`、`JX-AGENT-001`、`JX-AGENT-002` |
| 关联验收 | `JX-AC-022`、`JX-AC-028`、`JX-AC-035` |

## 1. 阶段目标与边界

### 要解决的问题

参考 Agent 的 system prompt 只有六行，未描述 Thread、Plan、公开 progress、验证、权限边界和效率原则，
模型无法准确理解当前 Harness。与此同时，Reducer 把每个 active Plan revision 的 JSON 拼进
`instructions`，使本应稳定的 provider prompt prefix 随执行不断改变。

### 本阶段完成

- 建立带显式版本的 Jixu reference Agent contract，覆盖当前真实能力与约束。
- 将 immutable Agent instructions 与动态 active Plan 严格分离。
- active Plan 作为 provider 请求最后一个 runtime context segment，而不是 system prompt 的一部分。
- OpenAI 与 OpenRouter 请求使用稳定的 Thread ID 作为 `prompt_cache_key`。
- 任意 OpenAI-compatible endpoint 默认只在识别为 OpenAI/OpenRouter 时注入 cache key，并允许显式覆盖。
- Event schema 升为 v5，Reducer 升为 v8；不迁移开发期旧 Thread。

### 本阶段明确不做

- 不向模型宣称尚未实现的 Skill 激活、Context Manifest、Handoff 压缩、审批或 sandbox 能力。
- 不启用 response caching，不缓存或重放模型决策。
- 不为跨 provider 缓存引入 `Session`、provider conversation authority 或第二份状态。
- 不用无意义文案填充 prompt 以追求 token 阈值。
- 不增加依赖、配置页面或 UI 测试文件。

## 2. 为什么这样设计

### 核心判断

System prompt 是 Agent 的稳定行为契约，不是运行状态容器。Plan、Thread ID、时间和用户输入属于变化的
context tail。缓存命中要求精确 prefix；把动态 Plan 放进 instructions 既污染职责，也让同一 active Plan
的每次 revision 重新计算静态 prompt 与 Tool schemas。

### 考虑过的替代方案

- 只扩写旧 prompt：模型能力认知会改善，但 Plan 仍持续破坏缓存，拒绝。
- 永久暴露所有 Plan operation：Tool schema 最稳定，但违反 State-derived control 和单 active Plan 约束，拒绝。
- 把 Plan 塞进 Tool description：仍改变更靠前的 capability prefix，且混淆 schema 与 runtime data，拒绝。
- 使用 OpenRouter `session_id` 作为新领域概念：provider 字段不应污染 Jixu 术语；使用现有 Thread identity
  映射到通用 `prompt_cache_key` 即可，拒绝新增概念。
- 启用 response caching：可能复用过时 Tool/Plan 决策，违反一次真实 Model Effect 的语义，拒绝。

### 主要 trade-off

Plan control 仍严格按 State 在 `create` 与 `revise/supersede/abandon` 两组 operation 之间切换，因此 Plan
创建和结束的生命周期边界可能产生一次 cache miss。这个边界有真实语义；换取的是模型不会看到当前
State 不允许的 operation。Plan 内部 revision 不再改变 instructions 或 control schema。

## 3. 架构与概念

### 概念关系

```text
Agent snapshot
  -> immutable reference instructions v1
  -> stable ordinary Tools + state-valid controls
  -> reusable provider prefix

Thread messages / Tool results
  -> current accepted active Plan
  -> dynamic request tail

Thread ID
  -> Driver prompt_cache_key hint
  -> provider cache routing only
```

### 权威与数据边界

Agent snapshot、Thread Events 和 Model Effect 仍是可恢复输入。`prompt_cache_key` 由 Driver 从
`effect.threadId` 派生，不写入 State、不影响 Reducer，也不能使 provider cache 成为 Thread authority。
cache usage 仍只通过 provider-reported accounting 进入 durable metrics。

### 执行时序

1. Reducer 从 immutable Agent snapshot 原样复制 `instructions`。
2. Reducer 继续从 State 产生 state-valid Plan control，并在 Effect 中保留 active Plan snapshot。
3. Driver 先映射 durable messages，再把 active Plan 作为最后一个 system runtime segment。
4. OpenAI/OpenRouter-capable Driver 附加 Thread-derived `prompt_cache_key`。
5. Provider 按自己的 implicit/explicit caching 能力处理请求，并通过 usage 回报 read/write tokens。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/agent-instructions.ts`：reference Agent contract v1。
- `packages/jixu/src/cli.tsx`：reference Agent 使用唯一的静态 instructions 常量。
- `packages/core/src/reducer.ts`、`plan.ts`：移除 `compilePlanInstructions`，保持 Effect instructions 原样。
- `packages/llm/src/index.ts`：active Plan tail 与 provider cache-key policy。
- `packages/core/test/runtime.test.ts`、`packages/llm/test/adapter.test.ts`：复用现有合同测试文件。

### 关键算法或状态转换

`activePlanContext` 只在 active Plan 存在时序列化一个明确标注“coordination only、not permission”的
runtime segment，并追加在完整 message sequence 之后。Plan revision N 与 N+1 只改变这一末尾 segment。

`supportsPromptCacheKey` 解析 Base URL，只为 `api.openai.com`、regional OpenAI endpoint 和 OpenRouter
自动打开 key；其它兼容端点默认不发送未知字段。公共 Driver config 可以显式启用或关闭。

### Failure path

- provider 不支持 `prompt_cache_key`：任意 compatible endpoint 默认省略；调用者可关闭识别端点的提示。
- cache miss 或过期：只增加 provider 计算/费用，不改变逻辑结果或恢复路径。
- incompatible pre-release Thread：schema v5 与 Agent snapshot compatibility fail closed，删除后重建。
- active Plan 不存在：不增加空 runtime segment，普通请求保持原有 message shape。

## 5. 使用的技术

Versioned TypeScript constant、immutable Agent snapshot、provider-neutral Model Effect、OpenAI Responses /
Chat Completions request mapping、URL capability detection、prefix-stable JSON serialization、durable cache-token accounting。

## 6. 验证证据

### Tests

- targeted core/LLM contracts：20/20 通过。
- `pnpm run check`：45/45 Node tests 通过，TUI smoke 通过。

### Static checks

- package build、`tsc --noEmit`、architecture lint 全部通过。
- `git diff --check` 通过。

### 关键断言

- 同一 active Plan 的 revision 1 与 2 使用 byte-identical instructions、Tool/control descriptors 和 cache key。
- 两次请求只在最后一个 active Plan runtime segment 出现 revision 差异。
- Responses 和 Chat Completions 都把 active Plan 放在 message tail。
- OpenAI/OpenRouter key 等于 Thread ID；普通未知 compatible Base URL 不自动注入。
- Core lifecycle 中所有 Effect instructions 始终等于 Agent snapshot instructions。

## 7. 遇到的问题与经验

Prompt engineering 与 context engineering 不能分开：文案再准确，如果把变化状态写在最前面，成本和
延迟仍会随每个 revision 重复。相反，单纯追求不变 schema 又可能弱化 State 约束。最优边界是让静态
契约长期稳定，只在真正改变可用 operation 的生命周期边界接受一次失效。

## 8. 已知限制与风险

- cache hit 是 provider best-effort；本阶段验证了 request shape，没有消耗真实 provider 费用做 live probe。
- provider 的最小 cacheable prefix、TTL 和读写价格不同，必须以 durable `cachedInputTokens`、
  `cacheWriteTokens` 与 USD 指标评价实际收益。
- late system runtime segment 符合当前 OpenAI-compatible request types；特殊 gateway 若限制 role 顺序，
  后续应在该 Driver 内做 capability-specific mapping，不能改回动态 instructions。
- 自动 Handoff、Context Manifest 和跨 context-window compaction 仍按后续 Context Engine 阶段实现。

## 9. 下一阶段入口

用真实 configured provider 连续完成至少三个同 Thread turn，对比 cache read/write、总输入成本、TTFT 和
任务成功率；同时为 reference Agent contract 建立少量高价值行为 eval，而不是字符串 snapshot 测试。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `packages/jixu/src/agent-instructions.ts`
- `packages/jixu/src/cli.tsx`
- `packages/core/src/events.ts`
- `packages/core/src/reducer.ts`
- `packages/core/src/plan.ts`
- `packages/llm/src/index.ts`
- `packages/core/test/runtime.test.ts`
- `packages/core/test/continuity.test.ts`
- `packages/llm/test/adapter.test.ts`
