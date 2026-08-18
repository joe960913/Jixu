# 阶段 10：Transcript 渲染稳定性

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 |
| 状态 | Completed locally |
| 关联需求 | `JX-EVT-006`、`JX-TUI-020`、`JX-TUI-021` |
| 关联验收 | `JX-AC-011`、`JX-AC-032` |

## 1. 阶段目标与边界

### 要解决的问题

Markdown table 使用整个 Markdown 宽度，而 assistant message 只留了左内边距；在带 scrollbar
的 transcript 中，最右侧边框因此贴边或被裁掉。模型每个 output delta 又会立即发布一次 React
snapshot，引发 Markdown parse、Yoga layout、sticky scroll 与终端绘制反复执行，视觉上闪烁。

### 本阶段完成

- assistant Markdown 左右使用对称 gutter，表格按可用宽度 balanced fitting。
- output delta 先保持顺序写入 buffer，再以 32ms presentation frame 合并发布。
- stable Event 到达、切换 Thread 或结束执行时清空 transient buffer，以 durable response 为准。
- Event decoder 只接受 current schema v3；删除两个 schema v2 本地 Thread 与一个旧 Checkpoint。

### 本阶段明确不做

- 不开启 continuous renderer，不引入动画循环或新依赖。
- 不修改 Markdown 内容、durable Event、滚动所有权或 Provider 协议。
- 不新增 UI snapshot 测试文件；使用现有 controller test 与一次临时 frame 检查。

## 2. 为什么这样设计

### 核心判断

表格是容器宽度问题，不应针对某张表硬编码列宽。闪烁是发布频率问题，不应关闭 streaming 或牺牲
逐步反馈。presentation batching 属于可丢失 Signal 投影，不进入 Thread State。

### 考虑过的替代方案

- 缩窄所有 Markdown：浪费普通文本空间，拒绝。
- 逐 token render：顺序正确但重复计算过多，拒绝。
- continuous renderer：空闲时也持续消耗资源，拒绝。
- 保留 v1/v2 upcaster：开发期增加未发布兼容复杂度，维护者明确允许删除旧数据后移除。

### 主要 trade-off

用户最多晚约 32ms 看到最新 token，但一次突发 delta 只触发一个 surface update，流式感更稳定。

## 3. 架构与概念

### 概念关系

```text
model output Signals -> ordered buffer -> 32ms frame -> transient TUI snapshot
model.completed Event ------------------------------> durable transcript
```

### 权威与数据边界

buffer 与 timer 只属于 `ThreadController`。Event log 仍是 response 的唯一 durable authority；表格
layout 只属于 TUI surface。

### 执行时序

1. controller 顺序接收 delta 并追加 buffer。
2. 当前 frame 尚未预约时创建一个 timer。
3. timer 将合并文本一次性发布给 React/OpenTUI。
4. stable boundary 取消未执行 timer、清空 buffer，并从 Event projection 显示最终回复。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/tui-transcript.tsx`：Markdown gutter 与 table fitting。
- `packages/jixu/src/thread-controller.ts`：stream frame buffer 与 lifecycle reset。
- `packages/core/src/events.ts`、`codec.ts`、`plan.ts`：current-only schema/parser。
- `packages/core/test/store.test.ts`、`packages/jixu/test/session.test.ts`：关键边界回归。

### 关键算法或状态转换

同一 frame 内的 delta 按到达顺序拼接。timer 只有一个；flush 后才能预约下一 frame。Thread 选择、
`model.requested`、sync、begin/end work 都显式 reset，避免旧 Thread 文本串入新响应。

### Failure path

- timer 被 stable boundary 取消时，最终 committed response 已由 Event projection 提供，不丢内容。
- 非 schema v3 Event 在 decode boundary fail closed，不做静默转换。

## 5. 使用的技术

OpenTUI Markdown `tableOptions`、Yoga padding、React external-store snapshot、TypeScript private
fields 与一次性 timer。

## 6. 验证证据

### Tests

- `pnpm run check`：44/44 Node tests 通过，OpenTUI smoke 通过。
- controller regression 将 `Read`、`ing` 连续发送，观察到合并后的 `Reading`，未观察到中间
  `Read` frame。
- `JX-AC-011` 验证 schema v1/v2/unknown 全部 fail closed。

### Static checks

- build、`tsc --noEmit`、architecture lint、`git diff --check` 均通过。

### 关键断言

80x14 临时 OpenTUI frame 中，Markdown table 的每一行都同时存在完整左右边界，且右侧保留一列
gutter；没有新增持久化 UI fixture。

## 7. 遇到的问题与经验

OpenTUI 的 `streaming` 优化 Markdown 增量语义，但不会替应用合并外部 snapshot。真正的闪烁源头
是每个 delta 都触发完整 surface 更新。表格默认 full-width，使原本不明显的右侧空间缺失最先
暴露出来。

## 8. 已知限制与风险

- 极慢、单字符间隔超过 32ms 的 Provider 仍会逐字符更新，这是正确的实时行为。
- 终端字体或 OpenTUI table renderer 自身的 Unicode 宽度差异不在本阶段修复范围。

## 9. 下一阶段入口

在真实 Provider 长回复中体验流式 cadence；如果仍有闪烁，应先采集 render 次数和 terminal
frame timing，再决定是否动态调整 frame interval。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `packages/core/src/events.ts`
- `packages/core/src/codec.ts`
- `packages/core/src/plan.ts`
- `packages/core/test/store.test.ts`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/src/thread-controller.ts`
- `packages/jixu/test/session.test.ts`
