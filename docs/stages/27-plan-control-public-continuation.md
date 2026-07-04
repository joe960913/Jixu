# 阶段 27：Plan control 的公开回复与拒绝续接

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | Adaptive Event-backed Plan |
| 状态 | Completed |
| 关联需求 | `JX-PLAN-008`、`JX-PLAN-009`、`JX-PLAN-010`、`JX-STORE-009` |
| 关联验收 | `JX-AC-031` |

## 1. 阶段目标与边界

### 要解决的问题

模型可以只返回 reserved Plan control，不附带公开文本或普通 Tool call。旧 Reducer 会把结果
当成已经完成的回复：Plan 或拒绝事实虽然进入 Event log，但 Thread 立即结束，TUI 只能显示
硬编码的 `(reply without text)`，用户也无法知道 Plan 已创建或被拒绝。

真实 provider 还暴露了两个 failure path：semantically invalid 的 Plan control 被记录后没有
反馈给模型；structurally malformed 的 Plan control 会把整个成功响应降级成
`model.failed`。取消 Plan 时复制完整 steps 也给模型制造了不必要的失败面。

### 本阶段完成

- Plan-only outcome 先提交 `plan.updated`，再通过普通 Agent loop 请求模型继续。
- structurally malformed 或 semantically invalid 的 Plan-only control 先以 `model.completed`
  持久化 rejection metadata，再提交 `plan.rejected`，最后把有界错误反馈给下一次 model
  Effect。
- control-only outcome 不向 model context 或 transcript 注入空 assistant message；公开回复
  由模型自然生成，不由 TUI 硬编码。
- active Plan 的 `abandon` 只要求 operation；terminal revision 从已接受的 Plan 推导。
- 旧 reserved-control descriptor 按 Effect 逻辑身份和 canonical work input 重放，schema
  演进不再使旧 Thread 报 `Effect is not ready`。
- TUI 将 Plan strip 与 Composer 相邻，隐藏内部 revision 编号并移除空回复占位文案。

### 本阶段明确不做

- 不为用户生成硬编码的“Plan 已创建”或“Plan 已取消”回复。
- 不把 Plan 变成 Effect scheduler、权限系统或第二套 Thread 状态机。
- 不改写既有 JSONL，不改变 Plan revision、Replay 权威边界或 provider protocol。
- Event schema version 5 只增加向后兼容的 optional payload，不做存储迁移。
- 不为普通 UI 间距和内部编号隐藏单独增加规范或 stage；它们是本阶段伴随的展示修正。

## 2. 为什么这样设计

Plan control 是模型决策的一部分，但不是公开回复。正确的恢复点不是 TUI fallback，而是
Reducer：只有先持久化 Plan 事实，再发起新的 `model.generate`，后续模型才能基于真实
active Plan 自然回应，同时保持 `Event -> Reducer -> Effect -> Driver -> Event`。

Plan rejection metadata 必须先随 `model.completed` 持久化，再由 State 驱动
`plan.rejected`。如果只在两个 append 之间保存在内存里，进程恰好崩溃会永久丢失修正路径。

首次 `model.requested` 仍严格校验 Effect ID、causation、attempt、Agent、messages、model、
active Plan 和普通 Tool descriptors；只把 reserved-control 的 description/input schema 当作
已持久化的历史请求事实。pending Effect retry 仍要求完整 input 完全一致，因此兼容旧
descriptor 不会放宽真实重试身份。

### 考虑过的替代方案

- TUI 根据 Plan 状态硬编码回复：无法代表模型意图，其他 surface 仍会得到空结果。
- 在同一个 `model.completed` transition 直接 dispatch：外部 Effect 没有先被 durable
  request，破坏执行不变量。
- 继续让 `abandon` 复制完整 Plan：会信任本应由 State 决定的数据，并扩大 provider 出错面。
- 对 ready Effect 只校验 ID：虽然能重放旧 Event，但会放弃 canonical work input 的
  fail-closed 校验，范围过宽。

### 主要 trade-off

一次 control-only 输出会增加一次模型调用和相应成本，但这是让模型自己产生用户可见回应
或修正控制参数的必要代价。Agent instructions 要求模型尽量在同一结果里附带公开文本或
普通 Tool，正常情况下不会产生额外 round trip。

## 3. 架构与概念

### 接受路径

```text
model.completed (Plan only)
        │
        ├── no empty assistant message
        └── pending Plan proposal
                  │
                  v
             plan.updated
                  │
                  v
        model.requested (accepted Plan)
                  │
                  v
       model.completed (public text / Tool)
```

### 拒绝路径

```text
model.completed (Plan rejection metadata)
        │
        v
   plan.rejected
        │
        v
model.requested (bounded correction feedback)
```

Event log 仍是 Thread 的唯一权威。Plan revision 存在于 `plan.updated` 和 projected State；
TUI 布局、transcript filter 和 provider descriptor 都不是 runtime authority。

## 4. 实现方式

### 关键模块

- `packages/core/src/reducer.ts`：识别 control-only outcome，在最终控制事实后创建 follow-up
  model Effect，投影 pending rejection，并兼容历史 control descriptor。
- `packages/core/src/effect-dispatcher.ts`、`effects.ts`、`events.ts`、`codec.ts`：把 adapter
  rejection metadata 纳入成功的 `model.completed` Event 和 fail-closed schema validation。
- `packages/core/src/thread-execution.ts`：从 State 依次提交 `plan.rejected` / `plan.updated`，
  消除 outcome append 与 rejection append 之间的 crash gap。
- `packages/core/src/plan.ts`、`packages/jixu/src/agent-instructions.ts`：提供最小 `abandon`
  control、从 active Plan 推导 terminal snapshot，并声明 Plan control 不是公开回复。
- `packages/llm/src/index.ts`：OpenAI Chat Completions 与 Anthropic Messages 都把 malformed
  reserved Plan call 归一化为 rejection metadata，同时保留公开文本和普通 Tool calls。
- `packages/jixu/src/thread-projection.ts`：忽略空 model content，不合成 assistant prose。

### 关键状态转换

`planOnlyControl` 同时要求 content trim 后为空、普通 Tool calls 为零，并至少存在一个有效
pending Plan update 或 rejection。只有控制事实全部提交、没有 pending/ready Effect 且
Thread 仍为 running 时，Reducer 才创建 follow-up model Effect。多次控制事实因此只产生
一次续接。

`abandon` parser 只读取 operation，忽略 provider 附带的冗余 body，并从 active Plan 构造
terminal proposal；原 `in_progress` step 转为 `skipped`，Plan status 投影为 `abandoned`。

### Failure path

- 仅有 invalid Plan control 时触发带错误反馈的续接。
- invalid Plan 与公开文本或普通 Tool 同时出现时，保留原响应和 Tool 路径，不额外抢占执行。
- 同时存在 valid Plan 与普通 Tool 时保持既有 Tool loop，Plan 仍先于 Tool dispatch 提交。
- pause 可在 ready model Effect dispatch 前拦截；continue 后恢复同一 durable request。
- 恢复从 Event replay 推导 ready Effect 和 pending rejection，不依赖 Checkpoint 权威。

## 5. 使用的技术

- TypeScript exhaustive Event reducer 与 immutable State projection。
- durable ready Effect、pending rejection 和现有 Thread execution drive loop。
- provider reserved-control normalization 与 bounded redacted error feedback。
- OpenTUI React nested flex layout 与 renderable position inspection。
- `node:test`、Bun OpenTUI renderer、JSONL read-only Replay probe。

## 6. 验证证据

### Tests

- targeted core / LLM tests：33 个通过。
- `pnpm --filter jixu test:tui`：TUI smoke 通过。
- `pnpm run check`：61 个 Node tests、typecheck、lint 与 TUI smoke 全部通过。

### Static checks

- `pnpm run typecheck`：通过。
- `pnpm run lint`：architecture lint 通过。
- `git diff --check`：通过。

### 真实 Event 验证

对截图对应的
`.jixu/threads/thread_e1d51ca6-d6e6-4856-ad40-9c508d8c7679.jsonl` 执行只读 decode 与
Replay：50 条 Event 全部通过，最终 revision 50，未改写 JSONL。

### 关键断言

- valid Plan-only 顺序为 `model.completed -> plan.updated -> model.requested`。
- invalid Plan-only 顺序为 `model.completed -> plan.rejected -> model.requested`，新 Effect 的
  request-varying runtime context 含有有界 correction feedback，Plan descriptor 保持稳定。
- malformed Plan control 不产生 `model.failed`；公开文本、read Tool 和既有 active Plan 都被
  保留。
- `{"operation":"abandon"}` 足以产生 abandoned revision；malformed 冗余 steps 不被信任。
- follow-up Effect 的 `activePlan` 是已接受的 Plan，messages 不含空 assistant message。
- 旧 required 全字段 Plan schema 与当前最小 abandon schema 不同，仍可完整重放。
- TUI frame 不包含 `(reply without text)` 或 `PLAN rN`，Plan 与 Composer 坐标相邻。

## 7. 遇到的问题与经验

真实 Event 检查显示三个现象来自两条链路：前两次创建 Plan 都因为 active Plan 缺少
`nextAction` 被拒绝，但旧 Reducer 把空 response 直接 settle，所以用户看不到任何结果；
取消时 provider 又把 `steps[0]` 输出成 string，adapter 将整个响应转为
`configured-model_response_invalid`。只修 TUI 占位文案无法解决这些问题，拒绝必须进入
durable Agent loop。

首次用新 Reducer 重放该 Thread 时出现 `Effect is not ready`。历史 `model.requested`
持久化的是旧 Plan Tool schema，而新 Reducer 用最小 abandon schema 重新生成 ready Effect
后做了整对象比较。最终只忽略 reserved-control descriptor 的可演进正文，canonical work
input 和 retry input 仍严格校验；真实 50 条 Event 随后完整重放。

TUI assertion 另有一次把窄 attention rail 中自动换行的 objective 当成连续字符串；断言改
为稳定可见片段，并继续用 renderable 坐标验证真正的布局 contract。

## 8. 已知限制与风险

- 如果模型持续只返回 Plan control，Agent loop 会像持续 Tool loop 一样继续；当前没有为
  Plan 单独设置 round limit。
- rejection feedback 最长 500 characters；它提供修正事实，不包含未脱敏 provider error。
- control-only 续接会产生额外 provider 调用，usage 与 cost 按既有 accounting 正常累计。
- revision 仍可通过 `/events` 和 `/state` 检查，只是不占用主聊天 UI。

## 9. 下一阶段入口

继续观察真实 provider 是否频繁忽略“同轮附带公开文本”的 instruction。若出现可复现的
无限 Plan control loop，再统一评估 Agent loop 的全局 step budget，而不是为 Plan 建立独立
scheduler。

## 10. 文件索引

- `SPEC.md`
- `packages/core/src/domain.ts`
- `packages/core/src/effects.ts`
- `packages/core/src/events.ts`
- `packages/core/src/codec.ts`
- `packages/core/src/effect-dispatcher.ts`
- `packages/core/src/thread-execution.ts`
- `packages/core/src/reducer.ts`
- `packages/core/src/plan.ts`
- `packages/core/test/reducer.test.ts`
- `packages/core/test/runtime.test.ts`
- `packages/core/test/continuity.test.ts`
- `packages/llm/src/index.ts`
- `packages/llm/test/adapter.test.ts`
- `packages/jixu/src/agent-instructions.ts`
- `packages/jixu/src/thread-projection.ts`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/test/tui-smoke.tsx`
