# 阶段 05：单 Agent Harness 与持续 Thread 闭环

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | Architecture Stage 1–2 |
| 状态 | Completed |
| 关联需求 | `JX-PROD-001`–`JX-PROD-004`, `JX-THREAD-001`–`JX-THREAD-013`, `JX-API-001`–`JX-API-005`, `JX-TUI-006`–`JX-TUI-013` |
| 关联验收 | `JX-AC-001`–`JX-AC-015`, `JX-AC-017`–`JX-AC-020` |

## 1. 阶段目标与边界

### 要解决的问题

旧实现仍以“一条 prompt 对应一个终态 Run”为中心，再由 TUI 的 Session 尝试拼接连续体验。这形成了两套生命周期：核心每轮结束，TUI 每次输入又创建新 Run；同时 `harness.ts` 和 UI controller 分别膨胀到难以解释的单体文件。

### 本阶段完成

- 公共入口收敛为一个不可变 Agent 对应一个 Harness。
- 实现 `createThread`、`openThread`、`listThreads` 与持续 Thread 的 `send`。
- Thread 在每轮结束后回到 `idle`，后续输入继续同一 ID 和上下文。
- `running` 期间的新输入先持久化排队，当前轮结束后按 Event 顺序自动启动。
- `clear` 只清空当前 Thread 的模型上下文，不替换 ID，不删除历史 Event。
- 恢复、pause/continue、Fork、Replay、Checkpoint 与非幂等等待继续使用同一执行模型。
- TUI 删除 Session/Conversation/Run 编排，普通输入直接调用选中 Thread 的 `send`。
- `/new`、`/clear`、`/resume`、`/continue` 采用互不重叠的产品语义；Thread 选择使用 OpenTUI 原生 Select。
- README、Store schema、包可移植性脚本和第一方 TUI 同步到新的公共路径。

### 本阶段明确不做

- 不实现自发 Plan、上下文压缩、Continuity Handoff 或 Artifact。
- 不新增 MCP、Skills 或 hosted service。
- 不新增依赖，不改 provider 请求协议，不重做 TUI 主题和整体布局。
- 不提供旧 Runtime、Run、Session 或 Conversation 的兼容别名。

## 2. 为什么这样设计

### 核心判断

连续对话不是 TUI 的展示技巧，而是 Harness 的基础语义。模型上下文、排队输入、恢复状态和外部 Effect 必须全部从同一 Thread Event log 派生，UI 只负责投影和操作入口。

### 考虑过的替代方案

- 保留旧 `runtime.run(agent, input)`，在外层增加 Thread/Session：会保留第二套权威和终态 Run，拒绝。
- 在 1000 行 `harness.ts` 上继续改名和补条件：状态名虽然变化，职责仍耦合，拒绝。
- 为 TUI 单独维护 conversation index：会重复 Store 的 Thread 索引，拒绝。
- 运行中拒绝用户输入：不符合现代 Agent 交互，也会丢失用户已表达的下一步，改为 durable queue。
- `listThreads` 时自动恢复所有 Thread：浏览列表会隐藏地产生外部 Effect，改为只读打开；只有显式 `openThread` 才启动恢复。

### 主要 trade-off

`send` 返回稳定 State，而不是仅返回“已入队”回执，因此调用方可以直接得到本轮结果；并发调用仍会在 Event append 后共享当前执行闭环。未来若需要显式的即时 acknowledgement，可在不改变 Event 权威的前提下增加独立观察接口，不能改变 `send` 的 durable acceptance 语义。

## 3. 架构与概念

### 概念关系

`Harness` 绑定一个 Agent、Stores 和 Drivers；`ThreadExecution` 协调一个 Thread；`EffectDispatcher` 只执行模型或 Tool Effect；`ObservationBroker` 只分发 Event 和 Signal；TUI `ThreadController` 只持有当前 Thread 选择与投影状态。

### 权威与数据边界

Event log 仍是唯一权威。Thread State、TUI transcript、activity 和 Thread 列表标题都由 Event 投影得到。Signal 不进入 State；Checkpoint 失败会回退到完整 Replay。TUI 不构造 Event、不调 Store transaction，也不决定 Thread 生命周期。

### 执行时序

1. `createThread` 创建 Store 记录并首先 append `thread.created`。
2. `send` append `input.received`；Reducer 在 `idle` 创建 Model Effect，在 `running` 写入输入队列。
3. 执行协调器先 append `model.requested` 或 `tool.requested`，再交给 Driver。
4. Driver outcome append 为 durable Event，Reducer 生成下一批 Effect。
5. 最终回复若有 queued input，立即激活下一条；否则 Thread 回到 `idle`。
6. 重启后 `openThread` 从 Event/Checkpoint 恢复并只重试 delivery contract 允许的 Effect。

## 4. 实现方式

### 关键模块

- `packages/core/src/harness.ts`：单 Agent 公共 facade、Thread registry、Fork 创建。
- `packages/core/src/thread-execution.ts`：串行 append、调度、恢复、pause/continue 和 Checkpoint。
- `packages/core/src/effect-dispatcher.ts`：模型与 Tool Driver 边界。
- `packages/core/src/observation.ts`：无 UI 依赖的 Event/Signal 观察流。
- `packages/core/src/reducer.ts`：纯状态转换和 durable input queue。
- `packages/jixu/src/thread-controller.ts`：第一方 TUI 对公共 Thread API 的薄编排。
- `packages/jixu/src/thread-projection.ts`：Event 到 transcript/activity 的确定性投影。
- `packages/jixu/src/commands.ts`：help、completion 与 dispatch 共用的 typed command metadata。

### 关键算法或状态转换

运行中 `input.received` 保存 `{ content, eventId }`，不会提前创建 Effect。当前轮的最终 model/tool outcome 调用统一的 `settleTurn`：队列为空则进入 `idle`；队列非空则 append 下一条 user message，并用原始 queued Event ID 派生稳定 Effect identity。

Thread 调度使用一个 execution promise 加 rerun 标记，避免 append 与 dispatch 交错时把 ready work 遗留在 `running`。同一 Thread 的 commit 使用 promise tail 串行化，Store 的 expected revision 继续阻止竞争 writer 同时提交下一序号。

### Failure path

- Model/Tool typed failure 保留历史上下文，并让当前轮回到 `idle`。
- 未知非幂等 Tool outcome 进入 `waiting`，恢复时不自动重复执行。
- Agent snapshot 不一致时 `openThread` fail closed。
- 未知 Event/schema fail closed。
- clear、continue、pause 和 send 在不兼容 status 下抛 typed transition error。
- 无效 Checkpoint 被丢弃并从 Event 完整恢复。

## 5. 使用的技术

- TypeScript exhaustive discriminated unions、readonly JSON domain model 与 private fields。
- Event sourcing、纯 Reducer、optimistic revision 和 idempotency identity。
- AsyncIterable observation stream、AbortSignal 和 promise-tail serialization。
- OpenTUI React Input/Select、原生焦点模型与 in-memory renderer。
- Node 内建 test runner、SQLite、JSONL 和 package-manager isolated consumers。

## 6. 验证证据

### Tests

- `pnpm run check`：40/40 headless tests 通过，OpenTUI smoke 通过。
- 覆盖单轮 Tool loop、同 Thread 多轮、运行中输入排队、clear、Signal stream、恢复、非幂等 waiting、pause/continue、Fork、Replay、Agent mismatch 和全部 Store contracts。
- TUI controller 覆盖真实公共 Harness/Thread 路径、Node Tool、live Signal、`/clear`、`/new`、`/resume` 和 Fork。

### Static checks

- `pnpm run build:packages`：通过。
- `tsc --noEmit`：通过。
- `pnpm run lint`：通过，输出 `core architecture lint passed`。
- `git diff --check`：通过。

### 关键断言

- 两次顺序 `send` 使用同一 Thread ID，第二次 Model Effect 包含第一轮完整上下文。
- `running` 期间两条 input Event 在 Driver outcome 前已经 durable，恢复后各激活一次。
- clear 前 Event 保留，但 clear 后 Model Effect 不再收到旧 messages。
- `listThreads` 不启动恢复；选中并 `openThread` 后才恢复。
- TUI 不再创建 Session 或为每条 prompt 创建新 Thread。

### Package acceptance

- `pnpm run test:packages`：同一组真实 tarball 在 npm、pnpm、Yarn 和 Bun 的隔离 consumer 中完成 TypeScript 与 Node 22.18.0 smoke，`JX-AC-017` 通过。

## 7. 遇到的问题与经验

中断状态里的旧实现主要做了词汇替换，没有先改生命周期：`completed/failed` 和 `idle/running` 同时存在，旧 `run/recover/resume` 入口也残留。这说明架构迁移不能从批量 rename 开始，必须先固定公共语义和唯一权威，再让类型错误暴露所有旧路径。

测试没有继续沿用大量旧断言，而是收敛到承重 failure boundaries，并复用现有 runtime、continuity、controller 和 TUI smoke 文件。这样既验证了发布路径，也没有为同一个行为增加多份测试结构。

OpenTUI skill 约束了 Thread picker 和 Slash menu 继续使用原生 Select 与焦点模型；本阶段没有引入自绘键盘状态机，也没有回退到单体 UI 文件。

## 8. 已知限制与风险

- `.jixu/runs` 与旧 SQLite `runs/run_id` 属于 pre-release 数据；本阶段改为 `threads/thread_id`，按 SPEC 不提供自动迁移。
- Plan、Continuity Handoff 和自动上下文压缩尚未进入 State 或模型上下文。
- `waiting` 的人工决策/结果确认 API 尚未实现。
- JSONL Store 仍只支持一个活跃本地进程；不宣称分布式 exactly-once。

## 9. 下一阶段入口

下一阶段实现 adaptive Plan：简单任务保持零 Plan，复杂任务由 Agent 自发创建、修订、完成或 supersede 一个 active Plan；Plan 只通过 durable Event 更新，不授予权限、不直接 dispatch Effect。第一方 TUI 同步展示 active Plan 和对应 activity，但不增加“用户手动进入 Plan mode”的概念。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `README.md`
- `packages/core/src/harness.ts`
- `packages/core/src/thread.ts`
- `packages/core/src/thread-execution.ts`
- `packages/core/src/effect-dispatcher.ts`
- `packages/core/src/observation.ts`
- `packages/core/src/domain.ts`
- `packages/core/src/reducer.ts`
- `packages/core/test/runtime.test.ts`
- `packages/core/test/continuity.test.ts`
- `packages/jixu/src/thread-controller.ts`
- `packages/jixu/src/thread-projection.ts`
- `packages/jixu/src/commands.ts`
- `packages/jixu/src/slash-command-menu.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/test/session.test.ts`
- `packages/jixu/test/tui-smoke.tsx`
- `packages/store-jsonl/src/index.ts`
- `packages/store-sqlite/src/index.ts`
- `scripts/verify-package-portability.mjs`
