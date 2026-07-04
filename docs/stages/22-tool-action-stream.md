# 阶段 22：Tool action stream

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | M2.12 |
| 状态 | Completed locally |
| 关联需求 | `JX-SIG-006`、`JX-TUI-019`、`JX-TUI-026` |
| 关联验收 | `JX-AC-036`、`JX-AC-040`、`JX-AC-041` |

## 1. 阶段目标与边界

### 要解决的问题

原有 Tool receipt 虽已归属 `JIXU`，但仍像通用执行日志：连续的 Tool-only
模型决策会被合并，每个 Tool 固定占两行，完成态只显示 `Completed`，历史只保留
最后四项，Bash 运行期间也看不到输出。这些行为无法准确表达 Agent 的因果动作，
也会在长 Thread 中同时损失信息密度和失败可见性。

### 本阶段完成

- 按 `tool.requested.payload.effect.requestedByEventId` 划分 causal batch；
- 保留同一模型响应内 Tool call 的 source order，terminal outcome 原位更新；
- 将默认 receipt 收敛为每个 Tool 一行，并从 typed output 生成 read、write、edit、
  bash 的事实结果；
- 为 Node `bash` 增加有界 `tool.output.delta` Signal，Controller 再按 32 ms frame
  合并并限制为三行、1200 字符；
- 大于四项的历史 terminal batch 改为事实计数，失败和 indeterminate 操作不折叠；
- 通过 `Ctrl+O` 展开完整 operation list 和有界 durable preview，Composer 保持 focus；
- 更新公开 projection 类型、SPEC、targeted tests 和真实 OpenTUI smoke。

### 本阶段明确不做

- 不增加新的 Tool；仍只有现有 `read`、`write`、`edit`、`bash`；
- 不修改 Event schema、Reducer、Thread State、Replay 或 Store；
- 不把 Signal、TUI expansion 或 live tail 变成 durable authority；
- 不增加 per-Tool focus、鼠标 disclosure 或完整 debug console；
- 不伪造 duration、created/updated、diff 等当前 Tool outcome 没有提供的事实。

## 2. 为什么这样设计

### 核心判断

Tool 展示的最小正确单位不是“相邻日志”，而是一次模型决策请求的 Effect batch。
现有 durable Effect 已保存 `requestedByEventId`，所以可以直接投影因果分组，无需
新增 turn、run 或第二套状态机。Signal 只补足尚未 durable 完成时的观察体验，
terminal Event 到达后立即丢弃。

### 考虑过的替代方案

- **继续按相邻 receipt 合并**：无法区分多个 Tool-only model round，拒绝；
- **保留最后四项**：数量固定但语义随机，可能隐藏唯一失败，拒绝；
- **把所有 stdout 逐块直接 setState**：高频输出会造成不必要的 React publication，
  改为 32 ms coalescing；
- **把 live output 写入 transcript**：会让可丢 Signal 冒充 durable fact，拒绝；
- **为 grouping 新增 turn model**：已有 Event causation 足够，属于重复概念，拒绝。

### 主要 trade-off

`Ctrl+O` 当前是 transcript-wide presentation toggle，而不是逐行 focus disclosure。
它保持 Composer-first 的键盘模型和很小的交互状态，但展开时会同时显示多个 batch
的 preview。对当前 reference TUI，这是比新增 Tool selection state 更清晰的边界。

## 3. 架构与概念

### 概念关系

```text
model.completed Event ID
  -> tool.requested Effect.requestedByEventId
  -> TranscriptToolReceiptEntry.requestEventId
  -> ordered ToolOperation[]

bash stdout/stderr
  -> bounded tool.output.delta Signal
  -> Controller 32 ms coalescing + 3-line/1200-char tail
  -> running Tool row only

tool.completed / tool.failed Event
  -> Tool-specific outcome + bounded durable preview
  -> live tail discarded
```

### 权威与数据边界

Event log 仍是 request、outcome、batch identity 和 reopen projection 的唯一 durable
authority。`toolLiveOutput` 只存在于 `ThreadControllerSnapshot`，只接受当前 running
Effect 且 Tool name 匹配的 Signal；terminal Event、Thread 切换或 work boundary 都会
清除它。丢弃或乱序 Signal 不改变最终 receipt 和 Thread State。

### 执行时序

同一模型响应产生的 Tool request 先按 source order durable append，再由 Driver
执行。并发完成顺序只更新对应 Effect ID，不改变 receipt 行顺序。若 Tool outcome
触发新的 Tool-only model response，新 response 的 Event ID 会自然创建下一组 receipt。

## 4. 实现方式

### 关键模块

- `packages/core/src/tool-output.ts`：Signal type、单 delta 上限和 fail-closed parser；
- `packages/tools-node/src/index.ts`：Bash 已捕获 output 的 UTF-8 Signal emission；
- `packages/jixu/src/thread-controller.ts`：Signal 校验、coalescing、二次 bound 和清理；
- `packages/jixu/src/thread-projection.ts`：causal grouping 与 Effect ID 原位 outcome；
- `packages/jixu/src/work-status.ts`：typed outcome、tone 与 bounded preview；
- `packages/jixu/src/tui-transcript.tsx`：单行 action、聚合压缩、live/durable detail；
- `packages/jixu/src/tui-workspace.tsx`：`Ctrl+O` presentation toggle。

### 关键算法或状态转换

Terminal batch 超过四项且未展开时，不再做 `slice(-4)`：Header 统计 `done`、
`failed`、`unknown`，正文只保留 failed/indeterminate 行。Live batch 无论大小都完整
展示。Bash 非零 exit code 仍忠实标记为 succeeded Driver outcome，但使用 warning tone。

### Failure path

- malformed 或超长 Tool Signal 被忽略，不影响 execution；
- Signal 的 Effect ID、Tool name 或 running 状态不匹配时不进入 snapshot；
- deterministic Tool failure 显示 `Failed`，indeterminate 显示 `Outcome unknown`；
- failure message 只在展开 detail 中显示，默认行保留 command/target 和 error code；
- terminal Event 会同时丢弃尚未 flush 的 delta，防止完成后短暂回显 stale tail。

## 5. 使用的技术

- TypeScript discriminated Event、Signal 和 receipt projection；
- Node `StringDecoder`，避免 Bash chunk 边界破坏 UTF-8；
- OpenTUI React normal-flow layout、global keyboard hook 和 in-memory renderer；
- bounded buffering、source-order arrays 和 Effect ID keyed update。

## 6. 验证证据

### Tests

- targeted Node tests：7/7 通过，覆盖 causal batch、read/bash outcome、live Signal
  bound、reopen projection 和 cancellation；
- `pnpm run check`：通过，Node tests 51/51，OpenTUI smoke 通过；
- OpenTUI frame 覆盖 live tail、`exit 0`、`Ctrl+O`、五项成功压缩、source order 和
  indeterminate 操作不被隐藏；
- `pnpm run test:packages`：同一真实 tarball set 通过 npm、pnpm、Yarn、Bun 的
  clean install、TypeScript 与 Node 22.19.0 smoke。

### Static checks

- `tsc -b tsconfig.build.json`：通过；
- `tsc --noEmit`：通过；
- `pnpm run lint`：通过，core architecture lint passed；
- `git diff --check`：通过。

### 关键断言

- 两次相邻 Tool-only model decision 产生两个 receipt group；
- 同一 model response 的 Tool 行保持 source order；
- running Tool receipt 原位转为 typed terminal outcome；
- Signal 全部丢弃后，reopen 仍能从 Events 重建相同 terminal receipt；
- collapsed batch 永远保留 failed/indeterminate operation。

## 7. 遇到的问题与经验

第一次 renderer 断言仍假设 target 与 outcome 紧邻，但新的单行 flex 会在宽屏中用
空白把 outcome 对齐到右侧；测试改为验证语义同一行而不冻结空格。Failure smoke
又暴露出长 error message 会挤掉 command，最终把默认结果收敛为 error code，并将
完整 message 放进展开 preview。这也说明“失败不隐藏”必须同时验证状态和目标，
不能只验证 header count。

## 8. 已知限制与风险

- stdout 与 stderr 的 durable Bash output 分字段保存，完成后的 preview 按 stdout
  后 stderr 展示，不能重建两个 stream 的精确交错顺序；live Signal tail 保留到达顺序；
- `write` outcome 只能确认写入 bytes，当前 contract 不能准确声称 created 或 updated；
- `edit` outcome 只能确认 replacement count，当前 contract 没有 durable diff；
- `Ctrl+O` 是全局 transcript detail toggle，不是逐 operation disclosure。

## 9. 下一阶段入口

若继续打磨四个核心 Tool，应先从 Tool contract 补充真实可证明的数据，例如 write
的 create/overwrite 语义、edit 的 bounded structured diff 和 read 的 range/line API；
TUI 再从这些 typed outcomes 投影，而不是靠展示层猜测。Web search 也应沿用同一
request batch、typed outcome、Signal 与 durable receipt 路径。

## 10. 文件索引

- `SPEC.md`
- `packages/core/src/tool-output.ts`
- `packages/core/src/index.ts`
- `packages/tools-node/src/index.ts`
- `packages/tools-node/test/tools.test.ts`
- `packages/jixu/src/tui-model.ts`
- `packages/jixu/src/work-status.ts`
- `packages/jixu/src/thread-projection.ts`
- `packages/jixu/src/thread-controller.ts`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/test/session.test.ts`
- `packages/jixu/test/tui-smoke.tsx`
