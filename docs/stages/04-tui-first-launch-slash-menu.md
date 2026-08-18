# 阶段 04：TUI 首次启动与 Slash 命令菜单

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 |
| 状态 | Completed |
| 关联需求 | `JX-TUI-002B`, `JX-TUI-009` |
| 关联验收 | `JX-AC-015`, `JX-AC-018` |

## 1. 阶段目标与边界

### 要解决的问题

首次启动且没有完整连接配置时，配置表单阻断了主工作区；composer 输入 `/` 后也没有命令发现和键盘选择能力。

### 本阶段完成

- 未配置时直接进入主工作区，明确显示 model 未配置并引导使用 `/config`。
- 未配置时不创建 Run；普通输入和依赖 Run 的命令只返回配置引导。
- `/config` 打开完整配置表单，连接成功后返回工作区。
- composer 支持 Slash 命令前缀过滤，并用 OpenTUI 原生 Select 处理 Up、Down 和 Enter。
- Escape 关闭菜单并把焦点归还 composer；带参数命令把命令前缀插回输入框。
- 命令菜单与 `/help` 共用一份 typed metadata。
- composer 下方按功能拆成两行：模型/配置状态在上，Shell 安全信息与退出提示在下。
- footer 只复用现有主题 token：`/config` 使用 brand 主色，说明文字使用 secondary，`unsandboxed` 使用 warning。
- 将原先单体 TUI 文件拆为应用编排、配置、工作区、transcript、命令菜单和命令模型。

### 本阶段明确不做

- 不修改 Agent、Run、Event、Runtime、Driver 或 Store 语义。
- 不新增依赖，不修改配置持久化 schema，不改 Kernel。
- 不重做现有主题、transcript 内容模型或 provider 连接流程。

## 2. 为什么这样设计

### 核心判断

缺少 credentials 是应用配置状态，不是 Run 生命周期状态，因此不应阻断主工作区，也不能伪造第二套 Run State。Slash 菜单是瞬态 UI 状态，应停留在 TUI 应用层。

### 考虑过的替代方案

- 自行绘制列表并维护 selected index：会重复 OpenTUI Select 已提供的焦点、选择和键盘行为，最终拒绝。
- 绝对定位、负边距、透明度叠层：早期实验对 Yoga 和 buffered renderable 的更新时序敏感，最终移除。
- 为命令过滤单独增加纯逻辑测试文件：行为已经通过普通 TUI 路径验证，额外文件只会重复断言，最终移除。

### 主要 trade-off

菜单在正常 flex 流内展开，会临时压缩 transcript 高度，但布局确定、可测试，并能保持 composer 和状态行可见。Select 获得焦点后，字符输入暂停；Escape 返回 composer 后可继续编辑。

## 3. 架构与概念

### 概念关系

`JixuApp` 只管理启动、连接和 config/workspace 页面切换；`AgentWorkspace` 管理 composer 与未配置提示；`SlashCommandMenu` 管理瞬态菜单焦点；`Transcript` 只投影 session snapshot。

### 权威与数据边界

未配置页面使用空的只读 snapshot 作为展示输入，不产生 Event，也不成为 Run 权威。连接后的 State 和 transcript 仍来自既有 JixuSession 对 Event/Signal 的投影。

### 执行时序

1. 启动时尝试完整 saved configuration；没有完整配置则显示未配置工作区。
2. 输入 `/` 后从 command metadata 过滤选项并渲染 Select。
3. 首次 Up/Down 把焦点从 input 转给 Select，后续选择交给原生组件。
4. Enter 调用无参数命令，或把带参数命令前缀写回 composer。
5. `/config` 切换到配置表单；连接成功后创建 session 并返回工作区。

## 4. 实现方式

### 关键模块

- `commands.ts`：命令 metadata、help 文本和前缀过滤。
- `slash-command-menu.tsx`：原生 Select、焦点转移和接受/关闭行为。
- `tui.tsx`：应用级启动与页面编排。
- `tui-setup.tsx`：连接配置表单。
- `tui-workspace.tsx`：工作区状态、composer 和提交路由。
- `tui-transcript.tsx`：transcript 和 activity 展示。

### 关键算法或状态转换

只有以 `/` 开头且不含空白参数的 draft 才进入命令过滤。选择无参数命令时直接提交；选择需要参数的命令时写入 `${command.name} `，空白使菜单自然关闭并继续编辑。

### Failure path

未配置时，`/config` 和 `/quit` 可执行，`/help` 可本地展示；其他命令和普通 prompt 只生成本地 inspection，不调用 session，也不创建 Run。saved configuration 自动连接失败时回到工作区显示连接错误并保留 `/config` 入口。

## 5. 使用的技术

- TypeScript discriminated/readonly metadata。
- React state、ref、effect 和 external store subscription。
- OpenTUI React Input、Select、ScrollBox 与 Yoga flex layout。
- OpenTUI in-memory test renderer 和 mock keyboard。

## 6. 验证证据

### Tests

- `node --test packages/jixu/test/session.test.ts packages/jixu/test/config.test.ts`：5/5 通过。
- `pnpm --filter jixu test:tui`：通过。

### Static checks

- `pnpm run typecheck`：通过。
- `pnpm run lint`：通过，输出 `core architecture lint passed`。
- `git diff --check`：通过。

### 关键断言

- 首屏包含 not configured 和 `/config` 引导，不包含 setup form。
- `/` 显示完整菜单，前缀过滤得到 `/config`。
- Up/Down 改变原生 Select 选中项，Escape 关闭，Enter 打开配置。
- 未配置提示与 Shell 安全信息位于相邻两行，不会拼接成 `/configLocal shell`。
- 80x24 下 `/fork` 选择后保留 `/fork ` composer 输入，状态与安全提示仍可见。

## 7. 遇到的问题与经验

早期直接在单体 `tui.tsx` 中叠加状态和布局补丁，导致文件超过一千行且调试路径失控。正确做法是先确认原生组件与焦点模型，再按职责拆分。

OpenTUI React 测试中，输入触发的 React state 在 `act()` 结束时提交；绘制必须放在后续 `act()`。裸 ESC 还有 20ms ANSI 消歧窗口，测试需等待窗口结束。两者都属于测试时序，不应通过生产布局补丁解决。

## 8. 已知限制与风险

- OpenTUI Input 当前没有 password masking，配置页沿用既有明文输入行为；secret 仍不得进入 Event、State、activity 或最终工作区帧。
- Slash 菜单展开时会临时压缩 transcript；80x24 已覆盖，但更矮终端不在当前验收范围。

## 9. 下一阶段入口

由 maintainer 进行本地体验验收；通过后再决定是否接受该 M2.2 TUI 行为。包可移植性仍按现有 M2.2 边界独立推进。

## 10. 文件索引

- `AGENTS.md`
- `SPEC.md`
- `README.md`
- `packages/jixu/src/commands.ts`
- `packages/jixu/src/session.ts`
- `packages/jixu/src/slash-command-menu.tsx`
- `packages/jixu/src/tui.tsx`
- `packages/jixu/src/tui-setup.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/test/tui-smoke.tsx`
