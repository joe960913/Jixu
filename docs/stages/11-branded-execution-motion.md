# 阶段 11：Jixu 执行动效

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 |
| 状态 | Superseded by 阶段 12 |
| 关联需求 | `JX-TUI-019`、`JX-TUI-021` |
| 关联验收 | `JX-AC-031`、`JX-AC-033` |

## 1. 阶段目标与边界

### 要解决的问题

已有 WorkPulse 只用 `✦` 和 `↳` 区分阶段，能够传达状态，但缺少 Jixu 自己的品牌运动语言。

### 本阶段完成

- 用固定一行的“续线”替换静态符号，pulse 沿连续轨迹前进。
- Thinking、Planning、Tool 使用不同 marker 和 cadence；Responding 保持静态。
- pulse 只使用现有 Nippon semantic tone，轨迹使用 secondary tone。
- 支持 `JIXU_MOTION=off` 与 `JixuApp motion={false}` 静态降级。
- 状态行归 Composer 所有，并复用原顶部留白；空闲时保留同一行几何，状态出现或消失不再推动消息区。

### 本阶段明确不做

- 不增加大幅启动 Banner、动画选择菜单、Nerd Font 或新依赖。
- 不修改 Event、State、Signal、WorkStatus 或 transcript。
- 不使用 continuous renderer，不新增 UI 测试文件。

## 2. 为什么这样设计

### 核心判断

Jixu 的核心意象是 continue。固定轨迹上的 pulse 比通用 spinner 更贴近品牌，也能暗示工作从模型
流向 Tool、再回到结果；文字仍承担完整语义，动画只提供执行感。

### 考虑过的替代方案

- 多套可选动画：形成配置与审美噪音，拒绝。
- Thinking/Tool 使用多行 ASCII：会改变 dock 高度并抢占内容，拒绝。
- OpenTUI Timeline：会持有 live-rendering 请求；离散字符无需持续 frame loop，拒绝。
- Responding 继续运动：会和 streaming text 同时争夺注意力，拒绝。

### 主要 trade-off

动态模式每 90～120ms 更新一次固定 glyph；换取清晰的轻量反馈。关闭后状态文字和几何完全不变。
固定状态槽占用 Composer 原有的顶部 padding 行，因此稳定布局没有额外牺牲消息空间。

## 3. 架构与概念

### 概念关系

```text
Event/Signal -> WorkStatus -> phase/tone -> MotionGlyph
                                     \-> static label/detail
```

### 权威与数据边界

MotionGlyph 只消费 transient WorkStatus。frame index 和 timer 是 React 组件局部状态，不进入
controller snapshot、Thread Event 或 Checkpoint。

### 执行时序

1. Composer 始终渲染一行固定状态槽，空闲时内容为空。
2. WorkStatus 决定 phase、tone、label 和 detail。
3. phase 选择 immutable frame sequence。
4. 一次性 timer 到期后只推进一个 frame。
5. phase 切换通过 React key 重建组件并从 frame 0 开始。
6. WorkStatus 清空时 MotionGlyph 卸载，effect cleanup 取消 timer，但状态槽几何保留。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/tui-motion.tsx`：frame 数据、semantic color 与调度。
- `packages/jixu/src/tui-dock.tsx`：ComposerWorkStatus 与 PlanDock。
- `packages/jixu/src/tui.tsx`、`tui-workspace.tsx`：静态降级参数传递。
- `packages/jixu/src/cli.tsx`：`JIXU_MOTION=off`。

### 关键算法或状态转换

每帧由 before trace、pulse、after trace 三段组成，总宽度始终为 8 cells；外层固定为 9 cells。
sequence 是模块级 immutable 数据，组件只保存 frame index。

### Failure path

- disabled 或 responding 直接选择 static frame，不创建 timer。
- unmount 和下一帧 effect cleanup 都取消旧 timer，不遗留 renderer work。
- 动画不可用时 label/detail 仍完整表达阶段。

## 5. 使用的技术

React local state/effect、OpenTUI demand-driven rendering、固定 Yoga geometry、现有 Jixu theme token。

## 6. 验证证据

### Tests

- `pnpm run check`：44/44 Node tests 通过，OpenTUI smoke 通过。
- 未新增纯视觉测试文件。

### Static checks

- package build、`tsc --noEmit`、architecture lint 通过。

### 关键断言

临时 OpenTUI frame 检查：动态模式从 `╶•─────╴` 前进到 `╶─•────╴`；静态模式等待同样时间仍为
`╶──•───╴`；前后 frame 长度一致。

临时布局检查：同一 Composer 在空闲、Thinking 与重新空闲三个状态下占用相同行数和纵向位置。

## 7. 遇到的问题与经验

品牌动效不需要增加视觉面积。把变化约束在已有状态行的一小段固定轨迹上，可以保留 Jixu 的密度、
稳定布局和专业感，同时让执行过程更有生命力。

瞬态状态不应成为布局中的瞬态节点。把它放进 Composer 的固定槽位，比为状态区设置动态高度或用
overlay 掩盖重排更简单，也明确了状态与输入动作属于同一交互边界。

## 8. 已知限制与风险

- 目前只提供环境变量和嵌入式 prop 关闭动效，尚未加入 `/config` UI。
- 没有独立 screen-reader 自动检测；需要辅助技术时应设置 `JIXU_MOTION=off`。

## 9. 下一阶段入口

真实体验否定了轨道式 pulse：它仍像通用 loading bar，静态降级更像冻结的残缺动画。阶段 12
保留固定状态槽与局部调度，但用 `JIXU` 字标色彩扫光替换整套 glyph，并让模型提供可选的公开进度短语。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `packages/jixu/src/tui-motion.tsx`
- `packages/jixu/src/tui-dock.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/src/tui.tsx`
- `packages/jixu/src/cli.tsx`
