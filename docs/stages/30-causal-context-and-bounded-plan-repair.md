# 阶段 30：因果 Context 与有界 Plan 修复

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | Causally complete Agent continuation |
| 状态 | Completed |
| 关联需求 | `JX-PLAN-008`、`JX-PLAN-009`、`JX-PLAN-010`、`JX-CTX-016` |
| 关联验收 | `JX-AC-004`、`JX-AC-006`、`JX-AC-031`、`JX-AC-049` |

## 1. 阶段目标与边界

### 要解决的问题

Plan-only 模型结果提交 `plan.updated` 后，下一轮模型只收到原 user message 和 active Plan，
没有收到“刚才的 Plan 已被接受”这一因果事实。模型因此可能把同一个 user message 当成尚未处理，
再次发送 Plan control。旧的 `supersede` 又要求模型先终止旧 Plan、再创建新 Plan；如果模型直接在
`supersede` 中给出新 objective，Kernel 会拒绝，随后无限执行
`model.completed -> plan.rejected -> model.requested`。

真实 Event log 已观察到 17 次相同 repair 循环，Thread 最后停在 pending `model.requested`。
TUI 同时把无 public text 的 control-only completion 显示为 `Response committed`，掩盖了真实状态。

### 本阶段完成

- 增加 pure Context Compiler，为每个新 `model.generate` Effect 生成 typed Model Runtime Context：
  continuation reason、accepted causal receipt、remaining obligations、do-not-repeat constraints 和
  Plan repair budget。
- 将 Runtime Context 和 redacted Context Manifest 持久化在 `model.requested` input，并校验 logical
  request digest；Agent、messages、active Plan、Tools 和 runtime source 均有稳定 digest。
- OpenAI Chat Completions 与 Anthropic Messages 只负责格式化同一份 Runtime Context，不自行推断
  continuation 语义，也不改写 immutable Agent instructions。
- Plan-only acceptance 后明确告诉模型 Plan 已提交，要求其继续 public response 或 ordinary Tool，
  并禁止无新证据重复同一 Plan change。
- Plan rejection 带回具体 validation message，只允许一次自动修复；第二次 control-only rejection
  以 `plan_repair_exhausted` 收敛到 idle，不再发起第三个 model request。
- `supersede` 改为一个原子 model control：其 body 描述 replacement，Kernel 先生成旧 Plan 的
  terminal superseded revision，再创建 replacement revision 1；历史双 proposal Event 仍可 Replay。
- 恢复旧版无限 repair 产生的 pending model Effect 时，在 redispatch 前提交 typed `model.failed`，
  避免重启后继续消耗模型请求。
- Fork 会映射 Runtime Context 内的 Event identity，并重新计算 runtime/source/request digest；Replay
  仍按 child Thread 的 logical identity 验证。
- 无 public text 的 completion 在 activity 中显示为 `Model action committed`，不再伪装成响应正文。

### 本阶段明确不做

- 不实现 adaptive compaction、Continuity Handoff、token budget、raw-tail selection 或 provider cache。
- 不增加 Skills、Artifacts 或外部知识的新 Context source；现有 Tool output 继续通过 messages 进入。
- 不新增 Event schema version，不迁移或重写现有 Event log；兼容逻辑只在 Replay/recovery 时生效。
- 不修改 provider API、模型配置、Tool 权限、settings 或依赖。
- 不启动本地 TUI，也不直接改写用户当前卡住的 Thread；修复由下次正常 reopen 的 recovery path 生效。

## 2. 为什么这样设计

### 核心判断

问题不是“历史消息数量少”，而是 model loop 缺少 Event-derived causal receipt。把更多旧文本重复塞进
prompt，仍无法告诉模型刚才的 control 是否被 Kernel 接受。正确边界是 Reducer 根据已接受 Event
编译 provider-neutral runtime semantics，再由 Driver 做协议格式化。

repair 上限必须是 durable State，而不是 adapter 内计数或 TUI timeout。只有 Event projection
知道同一 accepted input 已经失败几次，也只有它能在 Replay、crash recovery 和不同 provider 下
保持相同行为。

### 考虑过的替代方案

- 把 `Plan created` 硬编码成 Jixu 回复：会伪造并非模型生成的 public text，且无法表达不同 control。
- 把 `plan.updated` 追加成 assistant message：会把 control fact 混成对话正文，并形成第二种历史语义。
- 无限 retry 直到模型格式正确：对格式持续错误或不兼容模型没有上界，真实 Thread 已证明会卡死。
- 在 LLM adapter 根据 active Plan 猜测 continuation：两个 provider 可能产生不同语义，Replay 也无法验证。
- 删除旧 pending Effect：丢失 durable outcome，Thread 状态不可审计。
- 保留双调用 supersede/create：要求模型维护 Kernel 已掌握的旧 Plan，增加 schema 错误面和循环概率。

### 主要 trade-off

本阶段仍把全部 accepted messages 直接交给模型，没有解决长 Thread 的预算压力。它先补齐每轮 loop
必须具备的最小因果闭环，并用版本化 Manifest 为后续 compaction 留下稳定接入点；不把未实现的
Handoff 或 token selection 假装成已完成的 Context Engine。

`planRepairAttempts` 按 accepted input 重置，因此同一轮最多一次自动 correction。模型在第二次仍
输出错误 control 时，用户会看到 typed failure，需要发新消息继续；这是有限成本与自动容错之间的
保守边界。

## 3. 架构与概念

### 概念关系

```text
accepted Event + projected Thread State
                 |
                 v
          Context Compiler
            |          |
            |          +-> Context Manifest + logical digest
            v
     Model Runtime Context
            |
            v
 model.requested -> provider Driver formatting -> model outcome Event
```

Runtime Context 是一个 Model Effect 的输入，不是新 Event history、Session、Workflow 或第二个 State。

### 权威与数据边界

- Event log 仍是 Thread 的唯一 durable authority。
- Reducer 从 State 和 causing Event 生成 Runtime Context；Driver 只能格式化。
- Context Manifest 是可验证的请求说明，不决定 Thread status。
- repair count 是 Event-derived State；Checkpoint 只是可丢弃缓存。
- Fork 复制 Event prefix 时映射 child Event identity，但 Plan history 和 logical content 不被改写。
- rejection feedback 来自已持久化的 typed DriverError，压平空白并限制为 500 字符。

### 执行时序

```text
model.completed(control only)
  -> plan.updated
  -> model.requested(reason=plan_updated,
                     receipt=accepted Plan,
                     obligation=respond_or_act,
                     prohibit=repeat_accepted_plan_change)

model.completed(invalid control only)
  -> plan.rejected(repairAttempt=1)
  -> model.requested(reason=plan_rejected,
                     receipt=validation error,
                     obligation=repair_plan_control + respond_or_act,
                     repair=1/1)
  -> second invalid model.completed
  -> plan.rejected(repairAttempt=2)
  -> idle(error=plan_repair_exhausted), no third request
```

## 4. 实现方式

### 关键模块

- `packages/core/src/context.ts`：Runtime Context、source Manifest、compiler、logical digest 与 Fork copy。
- `packages/core/src/reducer.ts`：continuation reason、causal receipt、repair count、bounded settlement。
- `packages/core/src/plan.ts`：atomic supersede expansion 与历史 pair materialization。
- `packages/core/src/codec.ts`：Runtime Context、Manifest、repair attempt 和 digest 的 fail-closed decode。
- `packages/core/src/thread-execution.ts`：historical pending repair Effect 的 recovery guard。
- `packages/core/src/harness.ts`：Fork Event identity remap 后重新计算 Context digest。
- `packages/llm/src/index.ts`：OpenAI/Anthropic 的同义 Runtime Context formatting。
- `packages/jixu/src/thread-projection.ts`：control-only completion 的准确 activity copy。

### 关键算法或状态转换

Context Compiler 以 Agent snapshot、accepted messages、active Plan、state-derived control descriptors、
Tool descriptors 和 Runtime Context 计算一个 canonical JSON digest。Event decoder 对持久化 input
重新计算该 digest；内容被改动但 Manifest 未同步时 fail closed。

单个 replacement `supersede` 先展开为两个 Kernel-internal proposal。第一个只使用已接受旧 Plan
生成 terminal revision，第二个使用模型给出的 replacement body 创建新 identity。这个展开是 pure
function，因此 live reduction、Replay 和 pending Plan recovery 得到相同 snapshots。

旧 schema 5 Event 没有 `repairAttempt`、Runtime Context 或 Manifest。Replay 在匹配 logical Effect
时允许这些 legacy optional fields 缺失，但新创建的 Event 总是带完整 v1 context。若旧日志最终停在
超过上限的 pending model Effect，execution loop 在 Driver dispatch 前提交 terminal failure。

### Failure path

- Runtime Context 或 Manifest 只出现一个、schema/compiler version 未知、logical digest 不匹配时
  persisted Event fail closed。
- 第一条 invalid Plan 保留当前 active Plan，并给模型一次具体修复机会。
- 第二条 control-only invalid Plan 保留当前 active Plan，返回 `plan_repair_exhausted`。
- invalid Plan 同时带有 usable public text 或 ordinary Tool 时，不丢弃可用结果，延续原有合同。
- Fork 未重写 runtime Event identity 时会被 logical Effect identity 拒绝；现在通过 deterministic remap
  与 digest recomputation 修复。
- historical repair pending Effect 不被 redispatch，避免恢复即继续产生模型成本。

## 5. 使用的技术

- TypeScript discriminated unions、readonly provider-neutral runtime types 与 exhaustive Reducer switch。
- canonical JSON digest、schema-versioned Event payload、fail-closed decoder。
- Event-sourced bounded retry、crash recovery、Fork identity mapping 与 pure Replay。
- OpenAI Chat Completions system message、Anthropic Messages system blocks。
- `node:test` deterministic model sequences、synthetic legacy Event prefix、clean package consumer smoke。

## 6. 验证证据

### Tests

- `pnpm run check:release`：77 个 Node tests 全部通过，另有 TUI smoke 通过。
- 新增 accepted Plan receipt、rejected Plan receipt、input/tool continuation、Manifest source、single repair
  budget、atomic supersede、Fork 和 digest corruption 回归。
- synthetic legacy Event log 先创建 active Plan，再连续构造 3 次旧版 invalid supersede 和第 5 个
  pending request；reopen 后 Driver
  call count 为 0，Event 增加一个 `model.failed(plan_repair_exhausted)`。
- OpenAI 与 Anthropic fixtures 均收到相同 reason、receipt、obligations、prohibition 和 1/1 budget。
- package portability：同一组真实 tarball 在 npm、pnpm、Yarn、Bun clean consumer 中全部通过。

### Static checks

- `pnpm run typecheck`：通过。
- `pnpm run lint`：core architecture lint 通过。
- `git diff --check`：通过。

### 关键断言

- Plan-only acceptance 产生 `plan.updated -> model.requested`，后者 receipt 指向已接受 Plan Event。
- 两次 invalid control 只产生两个 `model.requested`，没有第三次调用。
- atomic supersede 保留旧 Plan ID/history，并为 replacement 创建新 ID revision 1。
- Fork、Replay、restart 后 Context logical identity 一致，Replay 不 dispatch Driver。
- control-only completion 不生成 synthetic assistant text，也不再标记为 public response committed。

## 7. 遇到的问题与经验

第一次实现 typed receipt 时只保留了 error code，遗漏具体 validation message。这样的 Context 看似
结构完整，但模型无法知道该修哪一项。修复后 error message 同时进入 bounded causal receipt，并保留
legacy `planRejectionFeedback` 字段用于旧 Effect compatibility；provider formatting 会避免重复展示。

首轮 targeted tests 有两个 Fork failure。原因是 parent `model.requested` 的 Effect ID 已映射到 child，
但 Runtime Context 内部的 causing Event ID 和 Manifest digest 仍指向 parent。这个失败证明 Context
Manifest 必须参与 Fork identity 设计，不能当成不透明附加字段。最终在复制 model Effect 时映射内部
Event identity，并重新计算 runtime source digest 与 logical request digest。

历史兼容也不能只让 decoder 接受 optional 字段。旧 `plan.rejected` Event 缺少 `repairAttempt`，而
新 Reducer 从之前的 `model.completed` 会推导出该字段；logical comparison 必须显式忽略 legacy 中
不存在的 additive field，随后再从 Event 顺序恢复 count。

## 8. 已知限制与风险

- Context Manifest v1 只覆盖当前真实可用的 Agent、messages、active Plan、Tools 和 runtime sources；
  `JX-CTX-003` 规划的 Handoff、raw-tail boundary、token budgets、Skills 和 Artifacts 尚未实现。
- 当前没有 compaction，长 Thread 仍可能超过 provider context window；本阶段解决的是因果完整性，
  不是容量管理。
- repair limit 固定为 1，尚未成为用户配置；在有真实兼容性数据前不增加可调重试策略。
- `plan_repair_exhausted` 当前通过普通 error surface 披露，没有专门的交互式 Plan editor。
- OpenAI-compatible provider 对尾部 system message 的兼容性沿用已有 active Plan context 行为；新增
  provider 仍需通过 contract fixture 验证。

## 9. 下一阶段入口

下一阶段应在同一 Context Compiler 上实现 deterministic budget accounting 和 safe-boundary
Continuity Handoff：先建立 source priority、estimated token cost、raw-tail boundary 与 excluded reason，
再做 compaction。不得另建 conversation summary authority，也不要让 provider opaque state 成为恢复依赖。

## 10. 文件索引

- `SPEC.md`
- `packages/core/src/context.ts`
- `packages/core/src/codec.ts`
- `packages/core/src/domain.ts`
- `packages/core/src/effects.ts`
- `packages/core/src/events.ts`
- `packages/core/src/harness.ts`
- `packages/core/src/plan.ts`
- `packages/core/src/reducer.ts`
- `packages/core/src/thread-execution.ts`
- `packages/core/test/continuity.test.ts`
- `packages/core/test/runtime.test.ts`
- `packages/core/test/store.test.ts`
- `packages/llm/src/index.ts`
- `packages/llm/test/adapter.test.ts`
- `packages/jixu/src/thread-projection.ts`
