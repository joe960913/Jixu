# 阶段 14：Live Turn Presentation Continuity

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 |
| 状态 | Completed locally |
| 关联需求 | `JX-TUI-019`、`JX-TUI-021` |
| 关联验收 | `JX-AC-036` |

## 1. 阶段目标与边界

### 要解决的问题

真实运行中，带 Tool call 的中间模型回复会先显示再消失；耗时只有几十毫秒的连续 Tool 操作会相互覆盖；
流式内容提交为 durable transcript 时还可能出现重复或空白过渡帧。此前独立插在聊天区与输入框之间的工作状态
还会改变 Composer 区域高度，使消息和输入框上下跳动。

### 本阶段完成

- 保留同一模型结果中同时出现的公开文本和 Tool calls，公开文本不再因继续执行 Tool 而消失。
- 从当前 turn 的 durable Tool Events 投影增量操作列表，按 Effect ID 原位更新成功或失败结果。
- 在一个 controller snapshot 中原子完成 transient stream 到 committed transcript 的提升。
- presentation-only 更新复用未变化的 transcript 与 Activity 数组 identity，减少无意义重绘。
- 恢复紧凑输入框，把实时 phase 与 Tool trail 放入输入框下方原本固定存在的两行状态栏。
- 工作状态只替换 footer 内容，不改变聊天区、Plan dock、输入框或 footer 的几何尺寸。
- Idle footer 只常驻显示当前 model，不展示 endpoint host 或 API format 配置细节。

### 本阶段明确不做

- 不公开 hidden chain-of-thought，不把 presentation Signal 变成 durable authority。
- 不用 minimum-duration timer 人为延长 Tool 状态，也不为动效引入第二套生命周期。
- 不新增依赖、Store schema 或单独的 UI 测试文件。
- 不修改 Activity rail 的完整审计历史。

## 2. 为什么这样设计

### 核心判断

工作状态是输入区对当前 turn 的反馈，归属 Composer footer，而不是聊天内容。Footer 本身永久占用两行，工作时
替换左侧信息即可稳定布局；完成后恢复 model 与 shell 信息，不需要挂载或卸载独立区域。Endpoint host 和
API format 只在配置界面出现，不占用日常工作状态栏。

Tool trail 必须来自 durable Events，因为“请求了什么”和“结果是什么”是执行事实；模型生成的 progress 只负责
一句公开、非权威的意图提示。二者不能混成一个会被快速覆盖的 singleton status。

### 考虑过的替代方案

- 在输入框上方永久预留工作状态区域：可以避免跳动，但无工作时形成大块空白，并侵占聊天区，拒绝。
- 仅在工作时插入状态区域：挂载和卸载会持续改变视觉重心，拒绝。
- 给每次 Tool 状态设置最短显示时间：会制造与真实执行不同步的 UI 时序，拒绝。
- 只展示最后一次 Tool：无法表达连续操作，也会让快速 Tool call 看起来像闪烁，拒绝。
- 直接渲染完整 Event log：信息正确但噪声过高；完整历史继续由 Activity rail 承担。

### 主要 trade-off

两行 footer 的空间有限，因此 Tool 操作按名称和状态聚合，并按宽度只保留最近若干组；完整事实仍可在 Activity
rail 查看。换取的是输入框和聊天区域完全稳定，窄终端也不会扩大 Composer。

## 3. 架构与概念

### 概念关系

```text
durable Tool Events -> Thread projection -> incremental Tool operations
model.progress Signal -> WorkStatus -> public current phase
model output deltas -> transient stream -> atomic committed transcript

Composer input
Composer footer row 1 -> current phase / idle model context
Composer footer row 2 -> Tool trail / idle shell context + persistent cost
```

### 权威与数据边界

Event log 仍是 Tool 执行和 transcript 的唯一 durable authority。`workStatus` 与流式文本是可丢失 presentation
state；`toolOperations` 是 Event projection，不建立第二份 history。Footer 不决定 Run 状态，也不影响 replay。

### 执行时序

1. `model.requested` 开始 turn，并清除上一轮 transient stream。
2. output deltas 经有界 coalescing 发布，不复制未变化的 transcript 与 Activity。
3. `model.completed` 的公开文本进入 transcript，即使同一结果还包含 Tool calls。
4. `tool.requested` 按 Effect ID 追加操作；对应 outcome 到达时原位更新状态。
5. 后续模型请求继续使用同一 footer；稳定边界到达后清理本轮 Tool trail，footer 恢复 idle context。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/thread-projection.ts`：公开模型文本与当前 turn Tool 操作的 Event projection。
- `packages/jixu/src/thread-controller.ts`：原子 snapshot promotion、no-op 检测与 identity 复用。
- `packages/jixu/src/work-status.ts`：Tool request 到展示模型的事实映射。
- `packages/jixu/src/tui-dock.tsx`：固定行高的 phase 与 Tool trail 小组件。
- `packages/jixu/src/tui-workspace.tsx`：Composer footer 的 idle/live 内容切换。
- `packages/jixu/test/session.test.ts`：复用现有 session 测试覆盖 load-bearing continuity。

### 关键算法或状态转换

Tool operation 以 `effectId` 为稳定 identity。请求首次出现时状态为 `running`，`tool.completed` 或
`tool.failed` 只更新匹配项。展示层再按 `name + status` 聚合连续事实，不改变底层 projection。

Controller 先计算完整 projection，再以一次 `#patch` 同时发布 transcript、Tool operations、work status 与空的
streaming text。未变化的数组直接复用旧引用，避免 `useSyncExternalStore` 消费者把每个小状态变化都当成整块
内容变化。

### Failure path

- Tool 失败：匹配操作变为 `failed`，不删除先前操作。
- progress Signal 缺失或非法：显示 Event-derived factual phase，不影响执行。
- 最终回复为空：沿用既有显式空回复占位语义；带 Tool call 的空中间结果不制造 transcript 项。
- 操作数量溢出：footer 聚合并截取最近分组，Activity rail 保留完整历史。

## 5. 使用的技术

TypeScript discriminated unions、immutable Event projection、`useSyncExternalStore` snapshot identity、OpenTUI
固定行高 flex layout、Nippon semantic color tokens、bounded stream frame coalescing。

## 6. 验证证据

### Tests

- `packages/jixu/test/session.test.ts`：验证公开中间文本保留、Tool request/outcome 增量更新、最终稳定边界清理、
  transient/committed 不重叠，以及 presentation-only frame 复用引用。
- `pnpm run check`：45/45 Node tests 通过，TUI smoke 通过。

### Static checks

- package build、`tsc --noEmit`、architecture lint 全部通过。
- `git diff --check` 通过。

### 关键断言

- `Reading note.txt.` 与同一 response 的 read Tool call 同时存在，文本不会闪现后消失。
- Tool operation 至少经历 `running -> succeeded`，同一 turn 完成前不被下一状态覆盖。
- 没有任一 frame 同时包含同一 committed 文本和非空 transient stream。
- 多个 streaming frame 复用完全相同的 transcript 与 Activity references。
- Composer input 保持 3 行最小高度，footer 始终为固定 2 行。

## 7. 遇到的问题与经验

闪烁不是单一动画问题，而是三种语义被混在一起：公开模型文本、瞬时工作提示和 durable Tool facts。简单延长
显示时间只能遮住症状。把公开文本投影为 transcript、把 Tool call 投影为增量列表、把 progress 保留为
非权威 Signal 后，生命周期自然清晰。

布局稳定也不等于必须在聊天区预留更多空间。最小而正确的归属是复用 Composer 已有 footer：输入相关反馈
靠近输入，聊天内容不参与其几何变化。

## 8. 已知限制与风险

- Footer 只展示最近若干聚合操作，长 turn 的完整操作顺序需要查看 Activity rail。
- 终端字体、CJK 宽度和极窄窗口可能进一步压缩 detail 文案，但不会扩大固定区域。
- 本阶段用 TUI smoke 验证布局与运行路径，没有新增逐像素 snapshot；真实终端观感仍应由 maintainer 验收。

## 9. 下一阶段入口

用 configured provider 执行一个包含多次快速 Tool call、公开中间说明和较长最终流式回复的真实 turn，观察 footer
聚合密度、窄屏截断与 frame cadence；只有出现可复现问题时再补对应的高价值回归断言。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `packages/jixu/src/tui-model.ts`
- `packages/jixu/src/work-status.ts`
- `packages/jixu/src/thread-projection.ts`
- `packages/jixu/src/thread-controller.ts`
- `packages/jixu/src/tui-dock.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/test/session.test.ts`
