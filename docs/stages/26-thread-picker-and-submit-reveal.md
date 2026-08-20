# 阶段 26：Thread picker 与提交定位

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | Reference TUI interaction quality |
| 状态 | Completed |
| 关联需求 | `JX-TUI-009`、`JX-TUI-032` |
| 关联验收 | `JX-AC-046` |

## 1. 阶段目标与边界

### 要解决的问题

`/resume` 的 Thread 数量会直接决定 picker 高度。只有一个 Thread 时，原生
`Select` 被压成一行，标题、内容与操作提示挤在三行边框里，视觉上不像一个可浏览的
选择面板。

Transcript 使用 OpenTUI 的 bottom sticky scroll。用户手动滚到历史内容后，框架会按
设计暂停 sticky 行为；此时从 Composer 提交新消息，新增的 `YOU` 行仍可能落在 viewport
下方，用户无法立即确认刚才提交的内容。

### 本阶段完成

- `/resume` 使用三到六行的原生 `Select` viewport；少于三个 Thread 时保留可读空间，
  超过六个时继续使用组件内部滚动。
- Composer 提交普通消息时，Transcript 明确回到底部并恢复 sticky following。
- 通过真实 OpenTUI renderable 验证 picker 高度和 Transcript `scrollTop`，而不是只检查
  frame 文案。

### 本阶段明确不做

- 不修改 `harness.listThreads()`、Thread 排序、标题或 durable Event 投影。
- 不让模型、Tool 或 Signal 自己抢走用户的历史阅读位置。
- 不持久化 scroll position，也不把 viewport 状态写入 Event、State 或 Checkpoint。
- 不改变 `/resume` 与 `/continue` 的产品语义。

## 2. 为什么这样设计

### 核心判断

这是两个 presentation-state 问题，不需要修改 Controller 或 Thread 权威数据。Picker
应继续复用 OpenTUI 原生 `Select`，Transcript 也继续复用原生 sticky scroll，只在一个
语义明确的用户动作上增加 imperative reveal。

### 考虑过的替代方案

- 根据 Thread 数量保持一到六行：真实终端证据表明一行面板可读性不足。
- 每次 transcript 增长都滚到底部：会让模型 streaming 或 Tool receipt 打断用户阅读
  历史内容。
- 持久化每个 Thread 的 scroll position：这会把一次进程内 viewport 偏好误升格为
  durable Thread 状态。

### 主要 trade-off

少于三个 Thread 时会出现空白 viewport 行，但换来稳定、可识别的选择面板轮廓。提交时
会主动离开历史位置，这是用户发送新消息后的预期行为；没有提交时仍尊重手动 scroll。

## 3. 架构与概念

### 概念关系

```text
Composer submit
      │
      ├── ordinary input ──> ThreadController.submit ──> Thread.send
      │
      └── reveal nonce ────> Transcript ScrollBox.scrollTo(bottom)
```

### 权威与数据边界

Thread 的 Event log 仍是唯一权威。`transcriptRevealRequest` 只是
`AgentWorkspace` 内的一次性 presentation nonce；`ScrollBoxRenderable` 的 position 也只
存在于当前 TUI 进程。

### 执行时序

1. Composer 接受非 slash-command 输入并清空编辑器。
2. Workspace 增加 reveal nonce，同时启动既有 `controller.submit()` 路径。
3. Transcript effect 把原生 ScrollBox 定位到当前最大垂直 offset。
4. 到达 sticky edge 后，OpenTUI 恢复 bottom following；随后新增的 user/model 内容继续
   留在最新 viewport。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/slash-command-menu.tsx`：Thread picker 的三到六行 bound。
- `packages/jixu/src/tui-workspace.tsx`：只为普通 Composer submission 产生 reveal nonce。
- `packages/jixu/src/tui-transcript.tsx`：持有原生 ScrollBox ref 并执行 bottom reveal。
- `packages/jixu/test/tui-smoke.tsx`：真实 picker 与 transcript scroll regression。

### 关键算法或状态转换

Picker 行数为 `max(3, min(6, threadCount))`。Transcript bottom offset 直接由
`scrollHeight - viewport.height` 计算，不猜测消息高度，也不依赖固定终端尺寸。

### Failure path

Transcript 尚未 mount 或当前内容不可滚动时，reveal 是安全 no-op 或定位到 0。Slash
command 不产生 nonce，因此 `/resume`、`/config` 等控制路径不会无故改变历史位置。

## 5. 使用的技术

- React `useRef`、`useEffect` 与一次性 state nonce。
- OpenTUI `SelectRenderable` 的 bounded viewport。
- OpenTUI `ScrollBoxRenderable.scrollTo()`、`scrollHeight` 与 `viewport.height`。
- `@opentui/react/test-utils` 的真实 renderer、keyboard 与 renderable inspection。

## 6. 验证证据

### Tests

- `pnpm run test:tui`：通过。
- `pnpm run check`：53 个 Node tests、TUI smoke、typecheck 与 lint 全部通过。
- `pnpm run test:packages`：同一套真实 tarball 通过 npm、pnpm、Yarn、Bun clean consumer。

### Static checks

- `tsc -b tsconfig.build.json`：通过。
- `tsc --noEmit`：通过。
- architecture lint：通过。
- `git diff --check`：通过。

### 关键断言

- 只有一个 Thread 时，`thread-select.height === 3`。
- 长 transcript 可滚动且被定位到 `scrollTop === 0` 后，从 Composer 提交新消息。
- 下一 frame 可见新的 `Scroll task` 用户消息。
- Transcript 最终满足
  `scrollTop === scrollHeight - viewport.height`，且 turn 正常完成。

## 7. 遇到的问题与经验

OpenTUI sticky scroll 会在用户离开 sticky edge 后暂停，并在重新到达 edge 后恢复。这一
行为适合保护历史阅读，但它无法区分“背景内容增长”和“用户刚提交消息”。正确的修复
点是 Composer intent，而不是 transcript length 变化。

## 8. 已知限制与风险

- Scroll position 是进程内 UI 状态，重新启动后由当前 transcript layout 决定。
- 终端特别矮时，三行 picker 会压缩 transcript 空间，但 Composer 与 footer 仍受现有
  workspace bound 保护。
- 本阶段不增加鼠标点击 Thread picker 的新行为；既有原生 selection contract 保持不变。

## 9. 下一阶段入口

继续通过真实终端反馈识别高频 navigation friction；只有出现独立 failure boundary 时才
扩展自动化 UI test，避免冻结普通视觉细节。

## 10. 文件索引

- `SPEC.md`
- `packages/jixu/src/slash-command-menu.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/test/tui-smoke.tsx`
