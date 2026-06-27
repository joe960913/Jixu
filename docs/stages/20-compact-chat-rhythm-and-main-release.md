# 阶段 20：收紧聊天节奏并发布主线

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | M2.10 |
| 状态 | Completed |
| 关联需求 | `JX-TUI-017`、`JX-TUI-020` |
| 关联验收 | `JX-AC-030`、`JX-AC-032` |

## 1. 阶段目标与边界

### 要解决的问题

普通 transcript 将 `YOU / JIXU` role 放在十格宽的固定列中，角色名与正文之间
出现过大的空白，使一条聊天消息看起来像两块不相干的信息。Composer 又重复
显示 `YOU`，占据输入区最重要的起始位置，却没有增加新的语义。

### 本阶段完成

- 将普通 user、Agent、streaming 与 ephemeral Agent 行统一到六格 role
  gutter；
- 让 Tool receipt 的左边界跟随新的正文起点；
- 删除 Composer 内重复的 `YOU`，保留一格 accent rule 与一格自然呼吸；
- 保持 committed user message 的 `YOU` role，不改变历史语义；
- 完成全量 release check，为直接发布 `main` 提供证据。

### 本阶段明确不做

- 不改变消息内容、顺序、Markdown、Tool receipt 或 durable projection；
- 不修改输入键位、focus、placeholder、selection 或 multiline 行为；
- 不冻结普通视觉 spacing 的像素截图或绝对终端坐标；
- 不提交 pnpm 项目中非权威的 `bun.lock` 或包含本机临时路径的设计 QA 草稿。

## 2. 为什么这样设计

### 核心判断

role 是消息的近邻标签，不是独立导航列。六格宽度允许最长的 `JIXU` 保留两格
呼吸，同时让所有普通消息正文对齐。Composer 的输入位置、accent rule 和用户
刚刚执行的键盘操作已经明确说明作者身份，无需再次写 `YOU`。

### 考虑过的替代方案

- **按 role 文本动态宽度**：每行更紧，但 `YOU` 与 `JIXU` 正文起点不一致，
  会破坏纵向阅读节奏。
- **仅缩到八格**：改动更小，但真实终端截图中的分离感仍明显。
- **保留 Composer YOU 并降低颜色**：减少视觉权重，却仍占据输入首屏空间。

### 主要 trade-off

更窄的 gutter 不适合承载长 notice label，因此 notice 行保留自己的十格语义栏；
普通 chat、stream 与 Tool receipt 使用紧凑边界。两类信息不强求同一布局。

## 3. 架构与概念

### 概念关系

```text
committed user / Agent message
streaming Agent response
ephemeral Agent status
Tool receipt
  -> one compact chat content edge

Composer
  -> accent rule + focused textarea
```

### 权威与数据边界

本阶段只修改 OpenTUI normal-flow layout。Event、State、TranscriptEntry、Signal、
Replay、模型上下文和 Store 均不变。

### 执行时序

无新增执行时序。React 继续从同一 controller snapshot 渲染 transcript；
Composer 继续由同一 `TextareaRenderable` 处理 focus、编辑与提交。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/tui-transcript.tsx`：增加共享
  `MESSAGE_ROLE_WIDTH`，统一普通聊天正文起点；
- `packages/jixu/src/tui-workspace.tsx`：删除 Composer role text，以 normal-flow
  `columnGap` 保留输入呼吸；
- `packages/jixu/test/tui-smoke.tsx`：在空 transcript 的真实 renderer frame 中
  断言 Composer 不再出现 `YOU`。

### 关键算法或状态转换

无算法与状态转换。共享 gutter 常量只参与 Yoga layout；Composer 仍是 accent
box 与 textarea 两个正常 flow child。

### Failure path

窄屏继续使用同一 role gutter，正文由原有 wrap 与 scrollbox boundary 处理。
删除 label 不触碰 textarea focus，因此配置缺失、busy placeholder 与 multiline
提交路径保持原样。

## 5. 使用的技术

- OpenTUI React `box`、`text`、`textarea`；
- Yoga fixed-width gutter 与 `columnGap`；
- OpenTUI in-memory renderer smoke；
- authoritative tarball portability verification。

## 6. 验证证据

### Tests

- Node suite：50/50；
- OpenTUI smoke：通过；
- npm、pnpm、Yarn、Bun clean consumer：全部通过。

### Static checks

- `pnpm run build:packages`：通过；
- `tsc --noEmit`：通过；
- `pnpm run lint`：通过；
- `git diff --check`：通过；
- `pnpm run check:release`：通过。

### 关键断言

- connected empty workspace 的 Composer frame 不再包含 `YOU` role；
- placeholder、slash discovery、Attention Rail 与 Footer 继续出现；
- 全量 durable、provider、Tool、Store 与 package portability 回归无失败。

## 7. 遇到的问题与经验

首次 smoke 使用全局 `\bYOU\b` 否定断言，被右侧合法的 `NEEDS YOU` 命中。
修正后只约束 Composer 中 `YOU + placeholder` 的组合，避免把同词但不同语义的
Attention heading 错当成回归。

## 8. 已知限制与风险

- notice label 仍使用独立较宽 gutter，以容纳 `ERROR` 等标签；
- 终端字体决定实际字符笔形，但 cell width 与 content edge 稳定；
- spacing 属于视觉验收，不通过脆弱 snapshot 固化每个绝对坐标。

## 9. 下一阶段入口

后续可以独立实现绝对路径的 Command-click 打开和右侧文件 preview；它们不应
改变本阶段建立的聊天正文边界或 Composer 输入节奏。

## 10. 文件索引

- `SPEC.md`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/test/tui-smoke.tsx`
