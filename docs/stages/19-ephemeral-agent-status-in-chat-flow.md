# 阶段 19：将瞬时 Agent 状态放回聊天流

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | M2.9 |
| 状态 | Completed |
| 关联需求 | `JX-TUI-019`、`JX-TUI-021` |
| 关联验收 | `JX-AC-033`、`JX-AC-036`、`JX-AC-037` |

## 1. 阶段目标与边界

### 要解决的问题

参考 TUI 原先把 `Thinking` 和当前 Tool trail 固定在 Composer 下方。这个位置
虽然稳定，却把 Agent 正在形成回答的状态与实际聊天因果流拆开：用户提交消息
后，聊天区没有 Jixu 的即时回应；当流式文本或 Tool receipt 出现时，Footer 又
继续表达另一套当前状态。

### 本阶段完成

- 将 Thinking 与 planning 状态渲染为聊天流中的临时 `JIXU` 行；
- 让 canonical `Thinking ...` 文案与 `JIXU` role 共用同一套逐字符色彩强调，
  同时保持固定字符宽度；
- 首个文本 delta 到达后，以流式 JIXU 回答替代临时状态；
- `tool.requested` 到达后，只显示因果 Tool receipt，不并列显示 Thinking；
- Tool outcome 后若模型继续工作，在 receipt 之后重新显示临时 JIXU 行；
- Composer 两行 Footer 在工作前后保持同一份 Model、Local I/O、Cost 与 quit
  上下文；
- 保留宽屏 Attention Rail 对同一瞬时状态的只读摘要。

### 本阶段明确不做

- 不新增 Event、State、Signal 类型或第二套状态机；
- 不把 Thinking 写入 durable transcript 或后续模型上下文；
- 不修改 Provider、Tool、Plan、Replay 或 Store 语义；
- 不重做 Tool receipt、Attention Rail、Composer 输入交互或普通视觉细节。

## 2. 为什么这样设计

### 核心判断

Thinking 是“Jixu 此刻正在回应”的临时界面状态，不是历史事实。它应该在用户
刚提交输入后立即占据下一条 Agent 位置，但不应伪装成已提交消息。流式文本和
Tool receipt 都比 Thinking 更具体，因此出现时必须成为当前唯一的因果表面。

### 考虑过的替代方案

- **继续放在 Footer**：布局稳定，但聊天区缺少 Agent 的即时反馈，且 Tool
  receipt 与 Footer trail 重复表达当前工作。
- **把 Thinking 写入 transcript projection**：可获得天然排序，却会污染
  durable 历史、Replay 与模型上下文语义。
- **同时显示 Thinking 与 Tool**：信息更多，但错误地表达两个并行阶段，增加
  视觉噪声。

### 主要 trade-off

临时行会随当前阶段在聊天流中进入和退出，这是正常的 Agent 消息占位行为；
它不再以固定 Footer 的方式保持绝对位置。换来的收益是聊天因果关系更自然，
且任一时刻只存在一个最具体的工作表面。

## 3. 架构与概念

### 概念关系

```text
existing controller snapshot
  ├─ thinking | planning + no stream -> ephemeral JIXU row
  ├─ responding + streamingText      -> streaming JIXU response
  └─ tool.requested Event            -> durable causal Tool receipt
```

### 权威与数据边界

- ordered Event log 仍是 Thread 唯一权威；
- `workStatus` 与 `streamingText` 仍是 transient presentation；
- Tool receipt 仍由 durable Tool Events 投影；
- 临时 JIXU 行只存在于 React render tree，不进入 `TranscriptEntry`。

### 执行时序

1. 输入提交后，现有 `#beginWork` 设置 `busy + Thinking`；
2. Transcript 根据 snapshot 渲染临时 JIXU 行；
3. delta 到达后 phase 变为 responding，临时行消失，stream 出现；
4. `tool.requested` 投影 receipt，work phase 变为 tool，不显示临时行；
5. Tool outcome 或后续 `model.requested` 恢复 Thinking，行出现在 receipt 后；
6. stable boundary 清空 transient 状态，仅保留 committed response 与 receipts。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/tui-transcript.tsx`：选择并渲染临时 Agent 状态；
- `packages/jixu/src/tui-motion.tsx`：提供 `JIXU` 与 canonical `Thinking ...`
  共用的逐字符 motion primitive；
- `packages/jixu/src/tui-workspace.tsx`：将 motion 传给 Transcript，并让 Footer
  始终渲染稳定上下文；
- `packages/jixu/src/tui-dock.tsx`：删除不再使用的 live Footer 状态与 Tool
  trail，只保留 Plan strip；
- `packages/jixu/test/tui-smoke.tsx`：通过可控 gate 验证真实中间帧。

### 关键算法或状态转换

临时状态只有在以下条件全部满足时出现：Thread 正忙、存在 `workStatus`、phase
为 `thinking | planning`、且 `streamingText` 为空。Tool 与 responding phase
自然排除，不需要新的布尔状态或生命周期。

### Failure path

Tool failure 仍先更新 durable receipt；若 Kernel 继续模型工作，现有
`Reconsidering` / `model.requested` 状态可重新形成临时 Agent 行。等待、暂停、
取消、失败与 idle 边界不会保留陈旧占位。

## 5. 使用的技术

- OpenTUI React normal-flow `box` / `text` / `markdown`；
- `useSyncExternalStore` 的既有 controller snapshot；
- React keyed committed transcript entries；
- Promise gate 驱动的真实 renderer 中间帧验收。

## 6. 验证证据

### Tests

- `node --test packages/jixu/test/session.test.ts`：1/1 通过；
- `pnpm --filter jixu test:tui`：通过。

### Static checks

- `pnpm run build:packages`：通过；
- `pnpm run typecheck`：通过；
- `pnpm run lint`：通过；
- `git diff --check`：通过。

### 关键断言

- 等待模型时，renderer 中存在 `ephemeral-agent-status`；
- canonical `Thinking ...` 走十二个固定字符节点组成的 motion label；
- 首个 delta 后，该节点消失且流式文本可见；
- Tool running frame 中只有 receipt，没有临时 Agent 状态；
- Tool completed 后进入下一次模型请求时，receipt 与新的 Thinking 同时按因果
  顺序存在；
- 全部中间帧持续显示同一 Model 与 Local I/O Footer。

## 7. 遇到的问题与经验

真实 OpenTUI smoke 在 committed Markdown 切换后立即抓帧时，parser 尚未完成
稳定渲染。测试最终按项目约定把状态提交与 renderer 验证放在不同 `act()`，并
为异步 Markdown 留出稳定边界。这个过程也证明不能只检查 controller 最终
snapshot；用户可见的中间帧必须经过真实 renderer。

## 8. 已知限制与风险

- 临时行展示的是公开进度文案或 Event-derived 状态，不展示 hidden reasoning；
- Tool receipt 当前仍以 bounded group 展示最近项目，完整记录由 `/events`
  提供；
- Attention Rail 会同时摘要 NOW，但它是辅助概览，不是第二条聊天消息；
- 极短模型请求可能在终端下一次绘制前完成，因此用户只看到最终结果，这是
  正确的 frame coalescing，而不是丢失 durable 状态。

## 9. 下一阶段入口

下一阶段可独立设计绝对路径的 Command-click 打开，以及右侧文件 preview
模式；它们应复用当前 Attention Rail 容器并保持可恢复，不与本阶段的瞬时聊天
状态耦合。

## 10. 文件索引

- `SPEC.md`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/src/tui-motion.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/src/tui-dock.tsx`
- `packages/jixu/test/tui-smoke.tsx`
