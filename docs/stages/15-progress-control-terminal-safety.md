# 阶段 15：Progress Control Terminal Safety

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 |
| 状态 | Completed locally |
| 关联需求 | `JX-SIG-005` |
| 关联验收 | `JX-AC-034` |

## 1. 阶段目标与边界

### 要解决的问题

真实 provider 在完成 Tool 后可能只返回一次 `jixu_progress_update`，没有公开内容、Plan 变更或普通 Tool call。
旧 adapter 会过滤 control，再把剩余空结果记录为成功的 `model.completed`，Reducer 随即把 Thread 收口为
`idle`。用户看到的是任务无错误地结束，却没有最终回复。

### 本阶段完成

- 明确 progress control 只能与至少一个普通 Tool call 同次返回，不能作为唯一输出或最终回复。
- Responses 与 Chat Completions adapter 都识别 progress-only 结果。
- progress-only 保留 provider 已报告的 usage/cost，并返回 typed、non-retryable model failure。
- 普通 Harness/Thread 路径把该 outcome 持久化为 `model.failed`，不会产生空 `model.completed`。
- 非法或缺失 progress 在同一响应仍有可用内容、有效 Plan 变更或普通 Tool call 时继续保持 cosmetic failure。

### 本阶段明确不做

- 不为 progress 自动补发隐藏的模型请求。
- 不改变 Event schema version 5、Store 或 Reducer 状态机。
- 不安装 Pi，不修改 retry、accounting 或 Node compatibility policy。
- 不修改配置或持久化真实验收 Thread。

## 2. 为什么这样设计

### 核心判断

Progress 是 transient Signal，不是完成工作的证据。只要它成为一次模型请求的唯一结果，Jixu 就无法证明用户请求
已完成，因此必须 fail closed。failure 仍携带 accounting，因为 provider 已经执行了请求，费用与 token 事实不能因
语义失败而丢失。

### 考虑过的替代方案

- Adapter 收到 progress-only 后自动再请求一次模型：会产生没有对应 durable Effect 的外部工作，违反
  `Event -> Reducer -> Effect -> Driver -> Event`，拒绝。
- Reducer 把空成功改成继续运行：Reducer 无法区分普通空响应与已过滤的 control，也会让纯领域层承担 provider
  协议细节，拒绝。
- 继续把 progress-only 当成功，由 UI 显示占位文案：会掩盖任务没有完成的事实，拒绝。

### 主要 trade-off

不合作的 provider 现在会给用户一个明确失败，而不是看似平静地结束。它不会自动恢复，但失败可观测、可审计，
并把是否重试留给 durable Jixu Effect policy。

## 3. 架构与概念

### 概念关系

```text
provider response
  -> parse public content / Plan / ordinary Tool calls
  -> emit valid progress as transient Signal
  -> if progress exists and usable result is empty
       -> typed ModelOutcome failure
       -> durable model.failed Event
       -> idle Thread with explicit error
```

### 权威与数据边界

Signal 仍然可以丢失，Event log 仍是 Thread 的唯一 durable authority。Adapter 只把 provider wire format 映射到
core port；它不写 Event，也不决定 Thread 状态。EffectDispatcher 将 typed failure 转成 `model.failed`，Reducer
按既有规则结算 turn。

### 执行时序

1. `model.requested` 在 dispatch 前持久化。
2. Driver 消费流并累计 provider accounting。
3. progress control 通过 `model.progress` Signal 发布，不进入 response Tool calls。
4. 流完成后检查剩余公开内容、Plan 变更和普通 Tool calls。
5. 若三者都为空且出现过 progress control，返回 non-retryable failure。
6. EffectDispatcher 提交 `model.failed`，不创建 continuation Effect。

## 4. 实现方式

### 关键模块

- `packages/core/src/progress.ts`：收紧 control descriptor 的调用条件。
- `packages/llm/src/index.ts`：在两种 API format 中记录 control presence，并统一判定 progress-only。
- `packages/llm/test/adapter.test.ts`：覆盖 Responses、Chat Completions 与 durable Harness/Thread 路径。
- `SPEC.md`、`ARCHITECTURE.md`：先更新规范语义和架构说明。

### 关键算法或状态转换

解析结果同时返回 `ModelResponse` 和 `sawProgressControl`。终止检查要求公开内容经 `trim()` 后为空、没有 Plan
proposal、没有普通 Tool call，且确实出现过保留 control。命中后使用 provider-scoped error code
`<provider>_progress_only`，`retryable` 固定为 `false`。

### Failure path

- progress-only：保留 accounting，提交 `model.failed`，Thread 回到 `idle` 并保留显式 `state.error`。
- progress 参数非法但还有可用输出：忽略 progress，不改变有效结果。
- 非 progress Tool 参数非法：沿用既有 provider response invalid failure。
- provider stream 中断：沿用既有 indeterminate 语义，不与 progress-only 混淆。

## 5. 使用的技术

TypeScript discriminated unions、provider-neutral `ModelOutcome`、durable Event projection、Responses/Chat
Completions streaming adapters、Node test runner、临时 JSONL Store 与真实 configured provider probe。

## 6. 验证证据

### Tests

- 定向 adapter suite：9/9 通过。
- `pnpm run check`：46/46 Node tests 通过，TUI smoke 通过。
- 新回归断言同时验证两种 API format、accounting 保留、progress Signal、typed failure、durable
  `model.failed` 与零个空 `model.completed`。

### Static checks

- package build、`tsc --noEmit`、architecture lint 全部通过。
- `git diff --check` 通过。

### 真实 provider 验收

通过 Jixu 的 configured Chat Completions provider、`ThreadController`、Node Tools 和临时 JSONL Store 读取
`SPEC.md`、`ARCHITECTURE.md`、`README.md`：

- 2 次模型 Effect 全部成功，3 次 read Tool 全部成功；
- 最终产生 986 字 assistant reply，Thread 为 `idle`，`busy=false`；
- 空 `model.completed` 为 0，`model.failed` 为 0；
- provider-reported cost 为 2,423,682 USD nanodollars；
- 临时 Store 在验收后删除，API Key 未输出，仓库与配置内容未修改。

## 7. 遇到的问题与经验

真实证据说明 control descriptor 不是强制协议：模型仍可能把 presentation control 当成阶段终点。因此必须在
adapter 的完成边界验证语义，不能只依赖 prompt。

实现中 `ModelResponse.planUpdates` 在 port type 上可选，首次 build 暴露了直接访问 `.length` 的错误；终止检查
改为兼容缺省字段。Harness 的失败 turn 按设计回到 `idle` 并把错误放在 `state.error`，测试据此验证 Event 和
error，而不错误引入新的 `failed` Thread status。

真实 probe 从 workspace root 直接运行时无法解析 pnpm package link；改从 CLI 所在的 `packages/jixu` 执行
Bun workspace 路径后才真正发出 provider 请求。前两次启动失败发生在本地 module resolution 阶段，没有网络调用。

## 8. 已知限制与风险

- Provider 仍可能违反 control descriptor；当前行为是明确失败，不是自动恢复。
- 真实验收证明了合作路径，progress-only failure 的确定性证据来自双 format adapter 与 durable Harness 测试。
- 当前 error message 是 developer-facing 英文，surface 仍使用通用错误展示。
- 窄屏视觉观感未在真实交互终端中人工验收，本阶段只处理终止语义。

## 9. 下一阶段入口

维护者接受本阶段后，再进入 Pi provider adapter 设计。该阶段需要先统一用户指定的 Pi `Usage.cost`、未报告
usage 归零、Node `>=22.19.0` 与 Jixu durable retry authority，并按 behavior/architecture change 先更新 SPEC。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `packages/core/src/progress.ts`
- `packages/llm/src/index.ts`
- `packages/llm/test/adapter.test.ts`
- `docs/stages/15-progress-control-terminal-safety.md`
