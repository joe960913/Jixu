# 阶段 06：自适应、Event-backed 的执行 Plan

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | Architecture Stage 3 |
| 状态 | Completed |
| 关联需求 | `JX-PLAN-001`–`JX-PLAN-007` |
| 关联验收 | `JX-AC-021`; `JX-AC-022` 的 Plan safety、recovery 与 model context 部分 |

## 1. 阶段目标与边界

### 要解决的问题

非平凡任务需要显式的中间意图，才能在多轮 Tool 调用、验证边界和进程恢复后继续正确工作；但为每条 prompt 强制生成 Plan 会浪费上下文，也会把简单任务变差。Plan 还不能成为第二套 workflow、权限系统或 Effect scheduler。

### 本阶段完成

- 定义一个有界、revisioned 的 Plan snapshot，以及 `create`、`revise`、`complete`、`supersede`、`abandon` 五种模型提议。
- 简单任务允许零 Plan；复杂任务可由同一个 Agent 自发维护一个 active Plan。
- `plan.updated` 成为唯一 durable Plan 事实，Thread State 只投影一个 active Plan。
- 同一模型输出中的 Plan change 必须先 durable commit，随后才能 dispatch Tool Effect。
- active Plan 进入下一次 Model Effect；inactive Plan 只保留在历史 Event。
- clear 清除 active Plan，Fork 继承 fork point 的精确 Plan State，恢复会补写尚未提交的 Plan change。
- Responses 与 Chat Completions adapter 都把保留 control 与普通 Tool call 分离。
- 第一方 TUI 用现有 Nippon color tokens 展示 objective、steps、status 与 next action。
- README 同步说明 adaptive Plan 的公共语义。

### 本阶段明确不做

- 不增加 Plan Mode、用户手动 planning 开关、workflow 或第二套执行 identity。
- 不让 Plan 授权、调度或执行任何外部动作。
- 不实现 Context Compiler、budget、Continuity Handoff 或自动压缩。
- 不新增依赖、测试文件、TUI 页面或交互状态机。

## 2. 为什么这样设计

### 核心判断

Plan 是模型提出、Kernel 校验、Event log 持久化的 coordination data。它的价值是让下一次模型调用看到已接受的中间意图，而不是替代现有 `Event -> Reducer -> Effect -> Driver -> Event` 执行路径。

### 考虑过的替代方案

- 每轮自动生成 Plan：会产生 ceremonial planning，违反 `JX-PLAN-002`。
- 把 Plan 做成 Tool：Tool 会产生 Effect，混淆“协调数据”和“外部动作”，拒绝。
- 只保存在 provider conversation 或内存：无法恢复、Replay 或审计，拒绝。
- `model.completed` 直接修改 active Plan：surface 可能在 `plan.updated` durable 前看到新状态，拒绝。
- 为 Plan 增加独立 store/state machine：形成第二权威，拒绝。

### 主要 trade-off

Model response 携带完整 Plan proposal，而不是 JSON Patch。重复字段略多，但 lifecycle validation、schema evolution、恢复和审计都更直接，也避免 patch path 成为新的隐式语言。Plan ID 在 Thread 内以创建 Event sequence 派生，因此 Fork 可以继承完全相同的 Plan identity；Plan identity 不承诺跨无关 Thread 全局唯一。

## 3. 架构与概念

### 概念关系

`PLAN_CONTROL` 是 Model Driver 可见的 typed control descriptor；它不是 Agent Tool。模型成功输出中的 `planUpdates` 先由 Kernel materialize 为 snapshot，再由 coordinator 逐个 append `plan.updated`。Reducer 只从这些 Event 维护 `activePlan`。

### 权威与数据边界

- `model.completed` 中的 proposal 是尚未接受的输入。
- `plan.updated` 是 Plan revision 的 durable fact。
- `ThreadState.activePlan` 是 Event projection，不是第二权威。
- `pendingPlanUpdates` 只表示 crash-recoverable 的 commit obligation，不进入默认模型上下文或 TUI projection。
- completed、superseded、abandoned revisions 可从 Events 检查，但不进入后续默认 context。

### 执行时序

1. Model Effect 总是暴露 Plan control；已有 active Plan 时，Effect 同时携带该 snapshot 和编译后的 instructions。
2. Adapter 将保留 control call 解析为 `planUpdates`，普通 function call 仍解析为 `toolCalls`。
3. Kernel 校验有界字段、step 状态、单一 in-progress step、objective identity 和 lifecycle。
4. `model.completed` durable 后，Reducer 产生待提交 proposal obligation 与普通 ready Effects；此时 active projection 尚未改变。
5. coordinator 逐项 materialize 并优先 append 全部 `plan.updated`，然后才处理 pause、Tool dispatch 或 stable return。
6. 恢复从 Events 重新派生相同 obligation；即使 Thread 已是 idle，也会先完成 Plan commit。

## 4. 实现方式

### 关键模块

- `packages/core/src/plan.ts`：Plan schema、typed control、parser、lifecycle materialization 与 context instructions。
- `packages/core/src/domain.ts`：`ModelResponse.planUpdates`、`ThreadState.activePlan` 与 pending commit obligation。
- `packages/core/src/reducer.ts`：Plan proposal 派生、`plan.updated` projection、clear/Fork 语义。
- `packages/core/src/thread-execution.ts`：Plan-first commit 顺序、invalid proposal typed failure、idle recovery。
- `packages/core/src/codec.ts`：Event、Effect 和 Checkpoint 的 Plan schema validation。
- `packages/llm/src/index.ts`：Responses/Chat typed control translation。
- `packages/jixu/src/thread-projection.ts` 与 `tui-transcript.tsx`：active Plan 的纯 Event projection 和薄渲染。

### 关键算法或状态转换

一次 model output 最多包含两个 Plan change；只有 `supersede` 后紧接 `create` 可以成对出现。`revise` 和 terminal change 必须保留 objective 与 Plan ID，revision 严格递增；`create` 只能发生在没有 active Plan 时。active snapshot 必须有 next safe action，terminal snapshot 不能保留 `in_progress` step，completed snapshot 的 steps 必须全部 completed 或 skipped。

Plan-first ordering 不依赖内存 callback：Reducer 从 durable `model.completed` 重新生成 pending proposal obligations，coordinator 再以稳定 identity materialize snapshot。若 append `plan.updated` 时进程停止，恢复后仍会得到同样的 snapshot，并在任何 ready Effect 前重试 commit。

### Failure path

- malformed provider control 作为 provider response failure 处理。
- lifecycle-invalid proposal 转成不可重试的 `plan_update_invalid` model failure，不产生 `plan.updated` 或 Tool Effect。
- 未知 Plan schema version、非法 status、重复 step ID、过大字段或两个 active steps fail closed。
- `plan.updated` 不匹配当前 pending proposal 时 Reducer 拒绝 transition。
- Plan commit append 失败时，ready Tool 不会 dispatch；重启后先恢复 commit obligation。

## 5. 使用的技术

- TypeScript discriminated unions、readonly JSON domain model 与 exhaustive lifecycle switch。
- 有界 JSON Schema、运行时 parser、schema version 和 deterministic Event projection。
- OpenAI Responses function call 与 Chat Completions streamed tool call adapter。
- OpenTUI 原生 `box`、`text`、normal flow 和现有 Nippon theme tokens。
- Node test runner、crash-injection EventStore 与真实 package tarball consumer。

## 6. 验证证据

### Tests

- `pnpm run check`：42/42 headless tests 通过，OpenTUI smoke 通过。
- `JX-AC-021` 场景同时证明零 Plan 路径，以及 create、revise、complete、supersede、replacement create。
- `JX-AC-022` 场景在 `plan.updated` append 注入进程停止，证明 Tool 尚未执行；恢复后 idle Thread 先补写 Plan，active Plan 进入模型 context，同轮 revision 在 Tool dispatch 前落盘。
- 现有 Fork 场景扩展为继承 active Plan identity 和 model context。
- Responses 与 Chat Completions 现有 adapter tests 验证 control descriptor 下发，以及 Plan/Tool calls 正确分流。
- controller 与 TUI smoke 验证 active Plan projection、clear reset 和 80×24/宽屏渲染。

### Static checks

- `pnpm run build:packages`：通过。
- `tsc --noEmit`：通过。
- `pnpm run lint`：通过，输出 `core architecture lint passed`。
- `git diff --check`：通过。

### 关键断言

- 简单 Tool、多轮和 Signal 场景没有 `plan.updated`，`activePlan` 为 null。
- 任意 snapshot 最多一个 `in_progress` step；State 只有一个 `activePlan` 字段。
- Plan change 本身不创建任何 Effect；唯一 Tool request 来自普通 model Tool call。
- Plan create/revision Event 先于同轮 `tool.requested`。
- inactive Plan 从 default model context 消失，但完整 snapshot 仍可从 Event history 读取。

### Package acceptance

- `pnpm run test:packages`：同一套真实 tarball 在 npm、pnpm、Yarn 和 Bun 的隔离 consumer 中完成 TypeScript 与 Node 22.18.0 smoke，`JX-AC-017` 通过。

## 7. 遇到的问题与经验

第一个恢复实现只在 Thread status 为 running 时启动。Failure injection 暴露了一个更隐蔽的边界：最终 model response 会先把 Thread settle 为 idle，但它的 Plan proposal 仍可能尚未 commit。恢复条件因此不能只看生命周期 status，还必须检查 durable Event projection 中是否存在 pending Plan commit obligation。

Fork 也揭示了 Plan identity 的作用域问题。用原始 Event ID 派生 Plan ID 会在复制 Event prefix 时改变 identity，使 copied `plan.updated` 与重新派生结果不一致。改为 Thread-local、sequence-derived identity 后，Fork point 的 State 能精确继承，而无须在 Fork adapter 中理解或重写 Plan 内部字段。

测试继续复用 runtime、continuity、adapter、controller 与 smoke 文件，没有为同一能力创建新的测试结构。TUI 只增加一个 60 行左右的纯渲染组件，没有把 Plan lifecycle 搬进 controller。

## 8. 已知限制与风险

- 当前只把 Agent instructions、messages 和 active Plan 组装成模型输入；完整的 versioned Context Compiler、budget 与 Context Manifest 尚未实现。
- `JX-AC-022` 中“进入 Continuity Handoff”的断言依赖下一阶段 Handoff schema，本阶段只完成并验证 recovery 与 model context 部分。
- Provider 是否自发选择 Plan 仍受模型能力影响；Kernel 保序和校验，但不宣称 deterministic model behavior。
- TUI 目前只展示 active Plan；历史 Plan 通过 `/events` 检查，不增加独立历史页面。
- Plan ID 只保证 Thread 内 identity；调用方应以 `(threadId, planId)` 标识一个 Plan。

## 9. 下一阶段入口

下一阶段进入 Context foundation：定义 versioned context sources 和 deterministic compiler，生成可审计 Context Manifest；在 safe boundary 上自适应压缩为 immutable Continuity Handoff，并确保 active Plan、权限、pending Effects、Artifact references、validation evidence 与 next action 不丢失。第一方 TUI 同步提供必要的 context/compaction inspection，不创建第二套上下文状态。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `README.md`
- `packages/core/src/plan.ts`
- `packages/core/src/domain.ts`
- `packages/core/src/effects.ts`
- `packages/core/src/events.ts`
- `packages/core/src/reducer.ts`
- `packages/core/src/thread-execution.ts`
- `packages/core/src/codec.ts`
- `packages/core/test/runtime.test.ts`
- `packages/core/test/continuity.test.ts`
- `packages/llm/src/index.ts`
- `packages/llm/test/adapter.test.ts`
- `packages/jixu/src/thread-projection.ts`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/test/session.test.ts`
- `packages/jixu/test/tui-smoke.tsx`
