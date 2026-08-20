# 阶段 21：修正 Tool receipt 的 Agent 归属

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | M2.11 |
| 状态 | Completed locally |
| 关联需求 | `JX-TUI-019` |
| 关联验收 | `JX-AC-036` |

## 1. 阶段目标与边界

### 要解决的问题

当模型响应没有公开文本、只请求 Tool 时，Transcript 会跳过空的 Agent message，
随后把 Tool receipt 直接放在 `YOU` 消息后。Receipt 虽然占用与 Agent 正文相同的
左边界，却没有显示 role，因而在真实终端中看起来像用户发起的工作。

### 本阶段完成

- 明确 Tool receipt 必须保留 `JIXU` role anchor；
- 在 receipt 的共享六格 role gutter 中渲染静态 `JIXU`；
- 保持 `TOOLS` 标题、操作详情、状态和因果顺序不变；
- 在现有 OpenTUI smoke 中增加 Tool-only 响应的归属回归断言。

### 本阶段明确不做

- 不修改 Event、State、Thread、Driver、Store 或配置 schema；
- 不制造空的 Agent message，也不改写模型公开输出；
- 不增加新的 turn/group 生命周期或第二套 Transcript 状态；
- 不调整 Tool 合并、截断、状态更新或最终回复顺序。

## 2. 为什么这样设计

### 核心判断

Tool receipt 是 JIXU 请求外部工作的因果证据。`TOOLS` 表示内容类型，不能代替
消息角色。最小且准确的修复是让 receipt 使用与普通 Agent message 相同的 role
gutter，而不是向 durable transcript 注入模型没有生成的文本。

### 考虑过的替代方案

- **保留一个空 `JIXU` message**：可以产生视觉锚点，但会把展示需求伪装成模型
  输出并污染 transcript，拒绝。
- **为整个因果 turn 新增 UI group**：可以只显示一次 `JIXU`，但需要新的分组模型
  和边界规则，远超本次归属问题，拒绝。
- **只调整缩进或颜色**：仍无法明确说明谁请求了 Tool，拒绝。

### 主要 trade-off

Tool receipt、后续 Thinking 和最终回复可能分别显示 `JIXU`，会重复 role 文本；
换取的是每一个独立 transcript surface 都能在滚动、截断和 live 更新中保持准确
归属，而且无需新增状态或推断分组边界。

## 3. 架构与概念

### 概念关系

```text
tool.requested + matching outcome Events
  -> TranscriptToolReceiptEntry
  -> ToolLedger
  -> JIXU role gutter + TOOLS receipt content
```

### 权威与数据边界

Event log 仍是 Tool request 和 outcome 的唯一 durable authority；
`TranscriptToolReceiptEntry` 仍由现有 Event projection 生成。本阶段只改变 React
展示树，不改变 Replay、模型上下文或公开 Thread 状态。

### 执行时序

现有时序保持为 `input -> model -> Tool -> model`。Tool 请求仍替换 transient
Thinking surface；区别仅在于 receipt 自身继续显示 `JIXU` 作者锚点。

## 4. 实现方式

### 关键模块

- `SPEC.md`：补充 Tool receipt role anchor 的规范和验收语义；
- `packages/jixu/src/tui-transcript.tsx`：把 `ToolLedger` 改为 role gutter 与
  receipt content 的 normal-flow 横向布局；
- `packages/jixu/test/tui-smoke.tsx`：断言 live Tool header 同时包含 `JIXU`
  与 `TOOLS`。

### 关键算法或状态转换

无新增算法或状态转换。现有 receipt operation 数组、Effect ID、terminal status
和最多四项展示规则保持不变。

### Failure path

Tool failure 继续在同一 receipt 中显示失败 tone 与状态；Tool-only 响应、带公开
文本的响应和后续模型 continuation 都使用同一 Event projection。极窄 viewport
继续由已有 flex shrink、wrap 和 scrollbox 边界处理。

## 5. 使用的技术

- OpenTUI React normal-flow `box` 与固定宽度 role gutter；
- TypeScript discriminated transcript entries；
- OpenTUI in-memory renderer smoke。

## 6. 验证证据

### Tests

- `pnpm run check`：通过，Node tests 50/50，OpenTUI smoke 通过；
- `pnpm --filter jixu test:tui`：针对性验证通过；
- live Tool frame 中，包含 `TOOLS` 的标题行同时匹配 `JIXU`。

### Static checks

- `pnpm run typecheck`：通过；
- `pnpm run lint`：通过，core architecture lint passed；
- `git diff --check`：通过。

### 关键断言

- Tool-only 模型响应不再让 receipt 视觉上附着于前一条 `YOU`；
- Tool 运行中的事实详情和 `In progress` 状态继续出现；
- receipt 出现时仍不重复渲染 ephemeral Agent status。

## 7. 遇到的问题与经验

因果顺序正确并不等于视觉归属正确。空的 Tool-calling model response 被正确省略
后，role gutter 也被一起省略，导致用户把相邻 surface 误读成父子关系。内容类型
标题和作者角色必须分别表达。

## 8. 已知限制与风险

- 同一 causal span 内可能多次出现 `JIXU` role；这是有意保留的局部自解释性；
- 本阶段使用真实 renderer frame 验证语义位置，但不冻结颜色或绝对坐标；
- 尚未启动交互式 TUI 做人工截图验收，maintainer 可在接受阶段复核终端观感。

## 9. 下一阶段入口

若真实终端仍觉得连续 `JIXU` role 过密，应先用独立原型验证单一视觉 group 的
滚动、stream promotion、Tool continuation 和 reopen 边界，再决定是否扩展
presentation model；不能为减少重复而引入第二个 Thread 状态机。

## 10. 文件索引

- `SPEC.md`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/test/tui-smoke.tsx`
- `docs/stages/21-tool-receipt-agent-attribution.md`
