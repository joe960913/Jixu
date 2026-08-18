# 阶段 09：Plan 韧性与实时工作状态

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 |
| 状态 | Completed locally |
| 关联需求 | `JX-EVT-006`、`JX-PLAN-003`、`JX-PLAN-006`、`JX-PLAN-008`～`JX-PLAN-009`、`JX-TUI-018`～`JX-TUI-019` |
| 关联验收 | `JX-AC-021`、`JX-AC-022`、`JX-AC-031` |

## 1. 阶段目标与边界

### 要解决的问题

一次真实 Jixu 任务暴露出三个相互关联的问题：已有 active Plan 时，模型仍能看到并调用
`create`；无效 Plan 元数据会把整个成功模型结果改记为 `model.failed`，连同正常回复与 Tool
调用一起丢弃；所有步骤完成后，Plan 仍保持 active 并要求模型再调用一次 `complete`。
同时，Plan 卡片位于 transcript `scrollbox` 内，会被新增消息推离 Composer。执行期间用户只能
从右侧 Activity 猜测当前动作，缺少紧凑、友好的即时反馈。

### 本阶段完成

- 将模型可见 Plan control 改为 State-derived schema：无 active Plan 时仅暴露 `create`，有
  active Plan 时仅暴露 `revise`、`supersede` 与 `abandon`。
- 当 revision 的步骤全部为 `completed` 或 `skipped` 时，自动投影为 `completed`，不再要求
  额外的仪式性 `complete`。
- 新增 durable `plan.rejected` Event。无效 Plan proposal 只拒绝控制元数据，保留成功的
  `model.completed`、回复内容、accounting 与普通 Tool calls。
- Event schema 升至 current-only v3；v1/v2 在 decode boundary 明确失败，开发期旧 Thread
  删除后重建，不保留隐藏迁移层。
- 将 active Plan 从 transcript 中移到独立、限高的 Composer-column dock；超过容量的步骤
  在 dock 内折叠为剩余数量。
- 增加瞬态 work status，基于已观察 Event/Signal 显示 `Thinking`、`Reading`、`Editing`、
  `Running`、`Responding` 等高层阶段，沿用 Jixu Nippon 色彩 token。
- 将 Event 到 work status 的映射、dock 展示、transcript 和 controller 分离，避免新的 UI
  catch-all。

### 本阶段明确不做

- 不增加 Plan Mode、第二套 Plan lifecycle 或 workflow scheduler。
- 不暴露、保存或推断模型 chain-of-thought。
- 不把 TUI work status 写入 Event、Checkpoint 或第二份执行 State。
- 不增加 UI 坐标、精确高度、颜色快照等低价值自动化测试。
- 不修改 provider、Store 或 Tool 的外部协议，也不增加依赖。

## 2. 为什么这样设计

### 核心判断

Plan 是模型输出中的可选控制数据，不是模型结果本身。模型已正确产生回复或 Tool call 时，
Plan proposal 的语义错误不能抹去这些独立事实。最小而完整的事件语义是先提交去除无效
Plan delta 的 `model.completed`，再提交包含原 proposal 与 typed error 的 `plan.rejected`，
然后才允许既有 Tool Effects 进入 dispatch。这样既保留审计证据，又不把 Plan 变成执行门禁。

Plan control 必须由当前 State 派生。仅靠 prompt 告诉模型“不要 create”仍会把非法选项留在
JSON schema 中；高能力模型通常会遵守，但 Harness 应从接口层消除无意义选择。完成状态同样
应从步骤事实推导，而不是浪费一次模型调用去写同义状态。

### 考虑过的替代方案

- 保持静态 Plan schema，只加强 prompt：无法阻止 provider 选择仍合法的 `create`，拒绝。
- 无效 Plan 继续记为 `model.failed`：会吞掉独立的有效回复、Tool 和 accounting，拒绝。
- 静默丢弃无效 Plan：失去 durable 复盘证据，拒绝。
- 增加单独的 Plan Store 或状态机：制造第二权威，拒绝。
- 把 Plan 卡片设为 transcript 内 sticky child：OpenTUI sticky scroll 作用于整个 scrollbox，
  不能赋予普通 child 独立固定语义，拒绝。
- 在固定 Plan dock 内再嵌套 scrollbox：TUI smoke 发现其 viewport 覆盖 header/objective；改为
  固定容量与明确折叠。
- 展示 reasoning 文本：不可验证、可能泄露私有推理，也会误导用户，拒绝。

### 主要 trade-off

`plan.rejected` 增加一个 Event type 与 schema v3，但它避免把模型、Plan 和 Tool
错误混成一个失败语义。work status 只承诺“当前已观察阶段”，因此比完整 reasoning 更克制；
它提供执行感和情绪价值，但不会假装解释模型内部思考。

## 3. 架构与概念

### 概念关系

```text
State.activePlan
    -> createPlanControl(State)
    -> model.generate
          |
          +-- valid Plan proposal -> model.completed -> plan.updated -> Tool Effects
          |
          +-- invalid proposal ---> model.completed -> plan.rejected -> Tool Effects

Events + output Signals -> work-status projection -> fixed ExecutionDock
```

### 权威与数据边界

- `model.completed` 保留真实模型 outcome、content、Tool calls 和 accounting。
- `plan.updated` 是 accepted Plan projection 的唯一事实。
- `plan.rejected` 保存被拒绝的 proposal 和 typed error，但不改变 active Plan。
- `ThreadState.activePlan` 仍只由 Event Reducer 推导。
- TUI `workStatus` 只存在于 controller snapshot，可丢失、可覆盖、不可决定执行。
- Checkpoint 在 Reducer/Event schema 变化后失效并从 Event log 重建。

### 执行时序

1. Reducer 根据 `activePlan` 构造本次模型请求的 Plan control。
2. Driver 返回 content、Tool calls 和可选 Plan proposal。
3. coordinator 在 append 前 materialize/validate 完整 proposal。
4. 有效时提交 `model.completed`，随后依次提交 `plan.updated`，最后 dispatch Tool。
5. 无效时提交去除 Plan delta 的 `model.completed`，再提交 `plan.rejected`，最后照常 dispatch
   有效 Tool。
6. controller 从 live Events 与 output delta 更新瞬态 work status；稳定后清空。
7. Workspace 在 transcript 外渲染 ExecutionDock，消息增长只改变 transcript viewport。

## 4. 实现方式

### 关键模块

- `packages/core/src/plan.ts`：State-derived descriptor、Plan materialization 与自动完成。
- `packages/core/src/thread-execution.ts`：无效 Plan outcome 拆分与 durable 顺序。
- `packages/core/src/events.ts`、`codec.ts`：`plan.rejected` 与 current-only schema v3。
- `packages/core/src/reducer.ts`：动态 control、rejected no-op projection 与 Reducer v6。
- `packages/jixu/src/work-status.ts`：observable Event 到高层工作文案的纯映射。
- `packages/jixu/src/tui-dock.tsx`：固定 Plan dock 与 Nippon-color work pulse。
- `packages/jixu/src/thread-controller.ts`：live Event/Signal 接线与瞬态 snapshot。
- `packages/jixu/src/tui-workspace.tsx`、`tui-transcript.tsx`：dock/transcript 所有权分离。

### 关键算法或状态转换

`materializePlanUpdates` 先校验 operation 与当前 active Plan 的关系。`revise` 的步骤全部终止时
直接生成 `completed` snapshot，并强制 `nextAction: null`。`create` 若已经全部完成则拒绝，避免
创建礼仪性 Plan。

`ThreadExecution.#commitProposal` 对 Plan semantic error 不再生成 `model.failed`：它先提交
sanitized `model.completed`，再用该 Event ID 作为 causation 提交 `plan.rejected`。Reducer 对
`plan.rejected` 只推进 revision，保留此前由 `model.completed` 派生的 ready Tool Effects。

### Failure path

- 重复 `create`、无 active Plan 的 revise、目标被静默改变、非法 status 等都进入
  `plan.rejected`。
- proposal shape 在 Driver boundary 无法解析时仍属于 typed model failure；本阶段只隔离已通过
  schema、但违反当前 Plan State 的 semantic error。
- 未知 Event schema/type 继续 fail closed。
- 非 current Event schema 在 decode 时直接 fail closed；开发期不维护旧草稿迁移层。
- TUI Signal 丢失时只少一次即时文案，不影响 Event、State、恢复或最终回复。

## 5. 使用的技术

- TypeScript discriminated unions、readonly JSON schema 与 pure projection。
- Current-only Event schema v3、Reducer versioned Checkpoint invalidation。
- OpenTUI normal-flow flex layout、bounded dock 和现有 theme token。
- React external-store snapshot 与 Event/Signal live stream。
- Node test runner和 OpenTUI in-memory smoke renderer。

## 6. 验证证据

### Tests

- `pnpm run check`：46/46 Node tests 通过，OpenTUI smoke 通过。
- `JX-AC-031`：重复 `create` 产生 `model.completed -> plan.rejected -> tool.requested`，Tool
  执行一次，无 `model.failed`，active Plan ID 不变，最终回复正常。
- schema regression：v1/v2 Event 均 fail closed，不进入 Reducer。
- 现有 recovery test 改为以 terminal `revise` 自动完成，恢复、Tool dispatch 顺序与 Replay
  继续通过。
- 现有 TUI smoke 验证 Plan header、步骤、最终回复与 Activity；未新增纯视觉测试文件。

### Static checks

- `pnpm run build:packages`：通过。
- `tsc --noEmit`：通过。
- `pnpm run lint`：通过，输出 `core architecture lint passed`。
- `git diff --check`：通过。

### 关键断言

- TUI smoke 首次发现 nested Plan scrollbox 覆盖 header/objective；改用 bounded condensation
  后再次通过，证明修复来自真实 renderer 而非静态布局猜测。

## 7. 遇到的问题与经验

最初为 v1/v2 Event 增加了 deterministic upcaster，但项目仍处于开发期，这使核心边界背负了
尚未发布的兼容复杂度。维护者确认旧 Thread 可以删除后，改为 current-only schema：旧数据明确
失败并重建，避免隐藏转换，也让 Decoder、Plan parser 和测试保持更短、更严格。

Plan dock 初版为了“限高”嵌套了 scrollbox。OpenTUI smoke 的实际 frame 显示 Plan header 消失、
objective 错位。Plan 最多 12 步，没有必要为少量内容增加第二滚动上下文；固定显示容量并折叠
剩余数量更稳定、更容易解释。

实时状态没有塞回 `thread-controller.ts` 的长 switch。Event-to-copy 映射单独放在
`work-status.ts`，视觉结构放在 `tui-dock.tsx`，controller 只负责 observation 接线。新增功能后
架构仍能用“事实 -> 瞬态投影 -> surface”解释。

## 8. 已知限制与风险

- work status 目前只识别 first-party `read`、`write`、`edit`、`bash`，其他 Tool 使用通用
  `Using tool` 文案。
- Tool 没有 progress Signal 时，只能显示 requested/completed 边界，不能展示内部百分比。
- Plan dock 折叠后不提供单独展开交互；完整 Plan 仍可通过 `/state` 和 Event inspection 查看。
- 历史已经写成 `model.failed(plan_update_invalid)` 的 Event 是不可变事实，不会被 retroactively
  改写；新的执行不会再产生这种错误归类。

## 9. 下一阶段入口

由 maintainer 在真实终端体验 Plan dock 的位置、长 Plan 折叠和 Thinking/Tool/Responding 文案。
通过后进入 Context foundation：Context Manifest 与 Continuity Handoff 应复用 accepted Plan、
rejected control evidence 和现有 accounting，而不新增另一套进度或恢复状态。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `packages/core/src/plan.ts`
- `packages/core/src/events.ts`
- `packages/core/src/codec.ts`
- `packages/core/src/reducer.ts`
- `packages/core/src/thread-execution.ts`
- `packages/core/test/runtime.test.ts`
- `packages/core/test/continuity.test.ts`
- `packages/core/test/store.test.ts`
- `packages/jixu/src/tui-model.ts`
- `packages/jixu/src/work-status.ts`
- `packages/jixu/src/thread-controller.ts`
- `packages/jixu/src/thread-projection.ts`
- `packages/jixu/src/tui-dock.tsx`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/src/tui-workspace.tsx`
