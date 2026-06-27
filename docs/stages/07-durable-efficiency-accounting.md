# 阶段 07：Thread 级持久化效率账本

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | Architecture Stage 3.1 |
| 状态 | Completed |
| 关联需求 | `JX-EVT-003`; `JX-EVT-006`; `JX-MET-001`–`JX-MET-007`; `JX-TUI-014` |
| 关联验收 | `JX-AC-011`; `JX-AC-017`; `JX-AC-028` |

## 1. 阶段目标与边界

### 要解决的问题

Agent Harness 的质量不能只用任务是否完成来评价，还必须能回答完成这项工作用了多少模型调用、多少 Tool 调用、是否发生重试、消耗多少 provider-reported token，以及可信的 USD 成本是多少。这些数据要能随 Thread 恢复、Replay、clear 和 Fork，而不是只存在于 TUI 内存或遥测平台。

### 本阶段完成

- terminal model Event 持久化 canonical token usage 与可信 USD cost。
- Thread State 从 Events 累计模型和 Tool 的 logical calls、dispatch attempts 与 terminal outcomes。
- token 投影区分 input、output、total、reasoning、cached input 和 cache write，并记录缺失报告。
- USD 使用整数 nanodollars，保留 `provider_reported` 或 `calculator` source 与 pricing version。
- Responses 与 Chat Completions adapter 提取 usage；Chat 请求显式开启 streamed usage。
- OpenRouter endpoint 的 provider-reported cost 可被信任；其他 compatible endpoint 默认不信任 cost 字段。
- developer 可为不报告成本的 provider 注入 versioned `costCalculator`。
- TUI composer 下方显示 selected Thread 的已知 USD 总额；未知显示 `USD —`，部分已知显示尾随 `+`。
- schema v2 覆盖 Plan input 与 accounting；schema v1 Thread Events 在 core boundary 确定性 upcast。

### 本阶段明确不做

- 不增加 hosted billing、网络价格服务、全局 dashboard 或第二套 telemetry authority。
- 不估算 Tool 的外部货币费用，只统计调用与执行结果。
- 不捏造 provider 未报告的 reasoning、cache 或其他内部 token。
- 不把未知价格显示成 `$0.00`，不宣称该账本替代 provider invoice。
- 不新增依赖或独立测试文件。

## 2. 为什么这样设计

### 核心判断

效率数据是执行事实的一部分，但不是新的 lifecycle。请求 Event 已经能证明 logical call 与 attempt，terminal model Event 只需补充该次 outcome 的 canonical accounting；Reducer 再形成一个 `ThreadState.metrics` 投影。这样 Event log 仍是唯一权威，TUI、复盘工具和未来可观测性 exporter 都消费同一个结果。

### 考虑过的替代方案

- TUI 本地计数：重启、Replay、Fork 后不可靠，拒绝。
- 只发 OpenTelemetry metrics：Signal/telemetry 可丢失且不是 durable authority，拒绝。
- core 内置最新模型价格表：价格会变化并迫使 core 依赖外部知识，拒绝。
- 用浮点 USD 累加：长期累积会引入舍入漂移，改用 nanodollars。
- 把 retry 计为新的模型或 Tool call：会夸大 logical work，calls 与 attempts 分开。
- 旧 Event 直接失败：会破坏已有 Thread；改为显式 v1 -> v2 upcaster，未知历史值保持未知。

### 主要 trade-off

未提供 trusted provider cost 或 calculator 时，TUI 只能诚实显示未知。相比用可能过期的静态价格表给出一个看似精确的数字，这更符合 durable audit 的语义。调用方若需要精确估算，可以注入带 `pricingVersion` 的纯 calculator；calculator 本身不进入 Event，只有计算结果和版本进入。

## 3. 架构与概念

### 概念关系

`ModelAccounting` 描述一次 terminal model outcome；`ThreadMetrics` 是全部 Events 的累计投影。前者进入 `model.completed` 或 `model.failed`，后者只存在于 State/Checkpoint cache，可从 Event log 重建。

### 权威与数据边界

- `model.requested` 和 `tool.requested` 决定 calls/attempts。
- terminal model Event 决定 outcome、token 与 cost。
- terminal Tool Event 决定 Tool outcome。
- `ThreadState.metrics` 是 deterministic projection，不是第二份账本。
- Checkpoint 只缓存 metrics，版本不匹配时丢弃并 Replay。
- adapter 只输出 canonical、redacted JSON data；credential、callback 和原始 provider metadata 不进入 Event。

### 执行时序

1. Model Driver 完成或失败，并将 provider usage 规范化。
2. trusted provider cost 优先；否则调用可选的 versioned calculator；两者都没有时 cost 为 null。
3. dispatcher 校验 accounting；非法值转成 typed `model_accounting_invalid` failure。
4. terminal model Event 先 durable append。
5. Reducer 同时累计 outcome、token、cost；Tool 计数由已有 request/outcome Event 同步投影。
6. controller 读取 `ThreadState.metrics`，TUI 只格式化 USD，不维护 counter。

## 4. 实现方式

### 关键模块

- `packages/core/src/metrics.ts`：canonical schema、runtime parser、初始值和纯累计函数。
- `packages/core/src/events.ts`：terminal model accounting 与 current Event schema version。
- `packages/core/src/reducer.ts`：call/attempt/outcome/token/cost projection。
- `packages/core/src/codec.ts`：Event/Checkpoint 校验与 v1 deterministic upcast。
- `packages/llm/src/accounting.ts`：provider usage/cost normalization 与 calculator contract。
- `packages/llm/src/index.ts`：Responses/Chat terminal outcome 接线。
- `packages/jixu/src/thread-controller.ts` 与 `tui-workspace.tsx`：State passthrough 和 footer rendering。

### 关键算法或状态转换

首次出现的 Effect ID 增加 logical call 与 attempt；同一 pending Effect ID 的重试只增加 attempt。每个 terminal outcome 恰好增加一种 succeeded、failed 或 indeterminate。model outcome 还必须恰好进入 priced/unpriced 和 usage-reported/missing 之一，因此 codec 可以验证聚合内部一致性。

旧 schema v1 `model.requested` 在 decode 时补入 `activePlan: null` 与 Plan control descriptor；旧 terminal model Event 补入 unknown accounting。upcast 只影响内存中的 canonical Event，不重写 durable Store。未知 schema version 和 v1 `plan.updated` 仍然 fail closed。

### Failure path

- provider usage 缺少基本 input/output/total 任一字段时，整份 usage 为 unknown。
- 不可信 compatible endpoint 即使返回 `usage.cost` 也不会被接受。
- calculator throw 时只把 cost 留为 unknown，不破坏模型结果。
- calculator 返回非法 schema 时，dispatcher 记录 typed model failure，禁止污染 Event log。
- invalid/cancelled/incomplete provider response 若已经报告 usage，仍保留该次 accounting。
- overflow、负数、非整数 token、非法 source/currency 或 inconsistent aggregate 在 schema boundary fail closed。

## 5. 使用的技术

- TypeScript readonly domain types 与纯 Reducer projection。
- schema-versioned JSON Event、deterministic upcaster 与 disposable Checkpoint。
- integer nanodollar fixed-point accounting。
- OpenAI Responses usage 与 Chat Completions `stream_options.include_usage`。
- OpenTUI normal-flow footer 和现有 Nippon color tokens。
- Node test runner、crash recovery fixture、真实 package tarball consumer。

## 6. 验证证据

### Tests

- `pnpm run check`：44/44 headless tests 通过，OpenTUI smoke 通过。
- `JX-AC-028` 覆盖 priced/unpriced outcomes、reasoning/cache token、模型与 Tool totals、clear retain 和 Replay equality。
- recovery fixture 证明两个 logical model calls 在 crash retry 后是三个 attempts，而不是三个 calls。
- schema v1 fixture 证明旧 Thread 可 Replay，历史 call count 精确，缺失 token/cost 显式 unknown。
- provider adapter tests 覆盖 injected calculator、trusted OpenRouter cost、untrusted compatible cost 和 streamed Chat usage。
- controller/TUI tests 覆盖 State passthrough、`USD —`、`USD $0.0132`、clear retain，以及宽屏和 80×24 footer。

### Static checks

- `pnpm run build:packages`：通过。
- `tsc --noEmit`：通过。
- `pnpm run lint`：通过，输出 `core architecture lint passed`。
- `git diff --check`：通过。

### Package acceptance

- `pnpm run test:packages`：同一套真实 tarball 在 npm、pnpm、Yarn 和 Bun 隔离 consumer 中完成 TypeScript 与 Node 22.18.0 smoke，`JX-AC-017` 通过。

## 7. 遇到的问题与经验

最初只给新 terminal Event 增加 required accounting 会让已有 schema v1 Thread 无法 decode。审计旧 payload 后，确认 Plan 阶段也改变了 model request input，因此把两项变化一起纳入 schema v2，并提供一个显式、确定性的 v1 upcaster。这样既不静默复用旧 schema，也不为了新指标丢掉已有 Thread。

另一个边界是“有 token 不代表有可信价格”。OpenAI-compatible endpoint 可以返回任意扩展字段，不能只因为字段名叫 `cost` 就纳入审计。实现只自动信任已识别的 OpenRouter host，其他 endpoint 必须显式声明或注入 calculator。

LLM adapter 一度接近 1000 行。最终把 usage/cost normalization 拆到 130 行的 cohesive module，主 adapter 回到约 877 行；TUI workspace 和 controller 仍分别约 405 与 486 行，没有形成新的 UI catch-all。

## 8. 已知限制与风险

- generic compatible endpoint 默认可能只有 token 而没有 USD；需要 trusted provider declaration 或 calculator。
- provider 不报告 reasoning/cache 时无法恢复内部 token 明细；unknown 是设计结果。
- 当前账本只累计模型 USD 与 Tool execution count，不包含搜索、MCP、云存储等外部服务费用。
- TUI footer 只展示 USD；完整 token、call、attempt 和 outcome 可从 `/state` 或公共 API 检查。
- 这是可审计成本估算，不是结算或发票系统。

## 9. 下一阶段入口

下一阶段回到 Context foundation：定义 versioned context sources、deterministic compiler 和 Context Manifest；在 safe boundary 上自动创建 immutable Continuity Handoff。新的 Context 机制应直接消费本阶段的 token/call/cost projection，用实际效率与 context pressure 驱动压缩决策和复盘，而不是建立另一套计数。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `README.md`
- `packages/core/src/metrics.ts`
- `packages/core/src/events.ts`
- `packages/core/src/domain.ts`
- `packages/core/src/effects.ts`
- `packages/core/src/effect-dispatcher.ts`
- `packages/core/src/reducer.ts`
- `packages/core/src/codec.ts`
- `packages/core/src/thread-execution.ts`
- `packages/core/test/runtime.test.ts`
- `packages/core/test/continuity.test.ts`
- `packages/core/test/store.test.ts`
- `packages/llm/src/accounting.ts`
- `packages/llm/src/index.ts`
- `packages/llm/test/adapter.test.ts`
- `packages/jixu/src/thread-controller.ts`
- `packages/jixu/src/tui-model.ts`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/test/session.test.ts`
- `packages/jixu/test/tui-smoke.tsx`
