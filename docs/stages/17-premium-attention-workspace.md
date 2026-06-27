# 阶段 17：Premium Attention Workspace

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | Reference TUI presentation |
| 状态 | Completed |
| 关联需求 | `JX-TUI-014`、`JX-TUI-018`、`JX-TUI-019`、`JX-TUI-022`—`JX-TUI-024` |
| 关联验收 | `JX-AC-030`、`JX-AC-031`、`JX-AC-033`、`JX-AC-036`、`JX-AC-037` |

## 1. 阶段目标与边界

### 要解决的问题

此前 reference TUI 已经可用，但右侧 Activity log 重复暴露 durable Event transport，没有直接回答用户最关心的四个问题：
现在在做什么、是否存在 Plan、刚刚验证了什么、是否需要用户介入。空状态、大面积边框、低对比品牌色和实现导向的信息层级，
也没有形成 Jixu 所需的“安静但昂贵”工作环境。

### 本阶段完成

- 用 always-on `NOW / PLAN / VERIFIED / NEEDS YOU` Attention Rail 替换默认 Activity log。
- 无 Plan 时明确显示 `Direct execution`；只有 active Plan 才在 Composer 上方增加 bounded Plan strip。
- 将 current-turn Tool receipts 放回 transcript 叙事流，完整 raw history 保留在 `/events`。
- 调整 header、empty state、speaker gutter、Composer、footer、品牌色对比度和 wide/compact responsive hierarchy。
- 采用 portable one-cell semantic glyphs：普通 text path、1-cell marker、2-column gutter、相邻完整文字。
- 将 `SPEC.md` 升至 0.4.6，并增加一个只保护 graphics boundary 的核心 smoke regression。

### 本阶段明确不做

- 不改变 Event schema、Reducer、Effect、Driver、Thread lifecycle、Plan lifecycle 或配置 schema。
- 不让 UI 成为 durable authority，也不新增第二套 Thread、Plan 或 Tool 状态机。
- 不展示推测的完成百分比、ETA、chain of thought、raw Effect ID 或默认 raw Thread ID。
- 不根据 model slug 猜 provider logo，不依赖 Nerd Font，不引入 image 或 custom drawing surface。
- 不为颜色、间距、具体行列或普通视觉文案增加脆弱测试。
- 不新增或更新依赖，不部署，不提交或推送代码。

## 2. 为什么这样设计

### 核心判断

Attention Rail 不是日志换皮，而是从当前 authoritative presentation snapshot 投影出的 user-centered control surface。
简单任务也保留右栏，因为“没有 Plan”本身是有价值的执行结构信息；它明确表达直接执行，而不是遗漏 Plan。

icon 的最终边界来自真实 terminal 证据，而不是 source asset 或独立 icon sheet。OpenTUI 没有内置通用 icon component；
Context7 文档、termcn `StatusMessage` 和 OpenCode 当前 TUI 都使用普通 text glyph 作为 status/Tool marker。OpenCode 的 inline Tool
gutter 固定为 2 columns。这一模式同时满足小尺寸、基线一致、可移植和明确语义。

### 考虑过的替代方案

- 继续保留 Activity feed：信息完整但重复 `/events`，并把 transport noise 放在用户任务之前。
- 简单任务隐藏右栏：空间更大，但 attention model 和布局会随任务复杂度跳变。
- 24 × 24 或 128 × 128 image icon：真实 terminal 中分别表现为压窄模糊和巨大图片贴片。
- 8 × 3 或 4 × 2 handcrafted cell art：没有 image scaling，但视觉权重仍过高，缩小后语义不可辨识。
- Nerd Font icon：能保持单 cell，但字体能力无法可靠探测，不适合作为 release default。
- one-cell portable Unicode glyph：图形细节有限，但尺寸、baseline、fallback 和跨终端行为最可解释。

### 主要 trade-off

最终 marker 不追求 GUI icon 的轮廓丰富度。Jixu 选择让完整文字承担语义，让 glyph 只提供扫读锚点；这是 terminal-native
产品约束，而不是用大图案模拟 GUI 的折中补丁。

## 3. 架构与概念

### 概念关系

```text
ordered durable Events
  -> canonical Reducer
  -> authoritative State snapshot
  -> TuiController presentation snapshot
       -> transcript + current-turn Tool receipts
       -> pure AttentionModel projection
            -> wide Attention Rail
            -> compact attention summary
       -> active Plan strip
```

### 权威与数据边界

AttentionModel 只读取 presentation snapshot，不持久化、不 dispatch Effect，也不决定 Thread status。`VERIFIED` 来自成功完成的
durable activity；`NEEDS YOU` 来自真实 config、waiting、paused 或 failure 状态。相同 projection 同时服务 wide 和 compact layout。

marker catalog 只把 attention/Tool category 映射为 portable glyph 和 default tone，不读取 provider metadata、不生成状态、
不改变 layout authority。文字 label 始终是语义权威。

### 执行时序

```text
Event/Signal observation
  -> controller snapshot
  -> createAttentionModel(snapshot)
  -> AttentionRail / AttentionStrip
  -> normal OpenTUI text rendering
```

## 4. 实现方式

### 关键模块

- `tui-attention.ts`：纯 attention projection。
- `tui-attention-rail.tsx`：wide rail 与 compact strip 布局。
- `tui-icons.tsx`：portable one-cell glyph catalog 与 Tool category mapping。
- `tui-transcript.tsx`：transcript 与 current-turn ToolLedger。
- `tui-dock.tsx`：work status、Tool trail 与 active Plan strip。
- `tui-workspace.tsx`：responsive workspace shell、Composer 与 footer。

### 关键算法或状态转换

`JixuIcon` 只渲染一个 `<text>`：glyph 占一个 cell，node 固定为 2 × 1，第二列是与 label 的 gutter。Attention title 在同一行
接 label；Tool receipt 第一行是 marker + Tool name，第二行以相同两列缩进展示 target/status。没有 image capability branch、
font probing、custom buffer、pixel packing 或 terminal geometry calculation。

Tool category 使用 `→` read、`←` edit/write、`✱` search、`◈` web、`$` terminal 和 `⚙` generic。Attention 使用 `•` current/direct、
`≡` Plan、`✓` verified、`○` no intervention、`!` attention。状态颜色继续来自现有 theme token。

### Failure path

glyph 笔形可能随 terminal font 改变，但 cell width/height 与相邻文字不会改变。即使某一 glyph 的视觉细节较弱，完整 label 和
semantic tone 仍表达状态；Kitty/Sixel capability 不会切换到另一条 rendering path。

## 5. 使用的技术

- OpenTUI React `<text>`、normal flow layout 与 headless test renderer。
- TypeScript discriminated presentation types 与纯 attention projection。
- Portable Unicode text glyphs 和固定 two-column gutter。
- Context7 当前文档、termcn 与 OpenCode upstream source research。
- terminal span capture、char-frame capture 与 real-terminal screenshot comparison。
- WCAG 普通文本 4.5:1 对比门槛。

## 6. 验证证据

### Tests

- `pnpm --filter jixu test:tui`：通过。
- smoke 覆盖 wide initial/no-Plan、simple direct turn、active Plan、current-turn Tool receipt、rail resize restore 和 compact semantics。
- graphics regression 强制 Kitty capability 后确认 marker 仍是 `TextRenderable`、尺寸为 2 × 1，且 render tree 不存在
  `ImageRenderable`。

### Static checks

- `pnpm run check:release`：通过。
- `git diff --check`：通过。

### 关键断言

- wide/no-Plan rail 常驻并明确显示 `Direct execution`。
- active Plan rail、Plan strip 和 three-Tool receipt 同时存在且不重叠。
- compact layout 保留 NOW、PLAN、VERIFIED、NEEDS YOU 文字语义。
- marker 不改变 section height、Tool two-line rhythm 或 Composer/footer geometry。

## 7. 遇到的问题与经验

最初新增 TSX module 时，package composite build 没有包含 `.tsx`；扩展 build include 后 source、declaration 和发布 artifact
回到同一 pipeline。

真正的主要失败是 icon 路径。前两轮围绕 image source resolution 和 slot size优化，但真实 terminal 证明问题是图片与文字网格
语言不同。撤销 image 后又把“terminal-native”误解为“必须手画多行 cell art”，导致 8 × 3 图案过大、4 × 2 图案不可辨识。

仓库规则要求同一交互失败两次后停止编辑 production code。最终按此边界重新执行：Context7 查 API、读取 upstream component、
在 `/tmp` 做 isolated proof、视觉确认比例，再修改 production。核心教训是先测量用户真实 slot，再选择表示方式；不要把 asset
复杂度当作产品精致度。

## 8. 已知限制与风险

- Unicode glyph 的具体笔形由终端字体决定；cell 占用和相邻文字稳定。
- provider/model brand logo 不在 catalog 内，避免从 model slug 猜测品牌与 capability。
- ToolLedger 只覆盖当前轮；完整历史仍通过 Event log 与 `/events` 查询。
- 不显示 ETA、percentage 或 raw chain of thought；未来如有可信 durable timing contract，必须先更新规格。
- 自动 capture 覆盖可重复路径；维护者仍需在日常 terminal 中验收具体字体和键盘手感。

## 9. 下一阶段入口

维护者可运行 `bun run dev` 验收真实字体下的 one-cell markers、Attention Rail 密度和 keyboard flow。若继续演进，应基于真实使用
证据选择 attention navigation、长 Plan/长 Tool target dense-state polish 等聚焦边界；不应重新引入 Activity log、大图案、
image icon、伪进度或第二套 UI 状态机。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `README.md`
- `design-qa.md`
- `packages/jixu/THIRD_PARTY_NOTICES.md`
- `packages/jixu/src/theme.ts`
- `packages/jixu/src/tui-attention.ts`
- `packages/jixu/src/tui-attention-rail.tsx`
- `packages/jixu/src/tui-icons.tsx`
- `packages/jixu/src/tui-dock.tsx`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/test/tui-smoke.tsx`
