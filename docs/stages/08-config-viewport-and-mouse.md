# 阶段 08：Config 与 Workspace 交互收敛

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 |
| 状态 | Completed |
| 关联需求 | `JX-TUI-005`, `JX-TUI-013`, `JX-TUI-014`–`JX-TUI-017` |
| 关联验收 | `JX-AC-018`, `JX-AC-029`, `JX-AC-030` |

## 1. 阶段目标与边界

### 要解决的问题

Config 页的 header/footer 随整个表单一起垂直居中，没有占据首尾行；固定应用背景与终端字符网格之外的像素余量形成底部色带；配置项只有键盘路径，鼠标点击不能选择格式或聚焦字段。Workspace 还把 Composer 状态横跨到 Activity rail 下方，输入框只能单行提交，无法表达多段 prompt。

### 本阶段完成

- 页面 chrome 使用首行、末行和居中的配置卡片三段式结构。
- 最外层 canvas 继承终端背景，中央卡片、输入区和选中态继续使用 Jixu 深色 surface 与 Nippon 语义色。
- API format、Base URL、API Key、Model ID 和 Connect 支持 primary-button mouse input。
- 鼠标与 Tab、Shift+Tab、方向键、数字键和 Enter 共用同一份 React 状态。
- 配置项统一为编号、名称、语义提示、输入 surface 和焦点边框；宽屏与 80x24 紧凑视口保留完整结构。
- Workspace 改为左右两个完整列：Composer 状态只属于左列，Activity rail 独立延伸到自己的底行。
- Composer 使用原生 `Textarea`：Enter 提交、Shift+Enter 换行，从 3 行自动增长到最多 8 行，超出后内部滚动。
- 不新增测试文件；原有 TUI smoke 只保留配置连接主路径和 Composer
  键盘语义，不把布局与装饰细节固化为自动化断言。

### 本阶段明确不做

- 不修改 Harness、Thread、Event、State、Driver、Store 或 provider 连接语义。
- 不增加依赖、第二套焦点模型、hover-only 行为或自定义 renderer。
- 不改变 prompt 提交、Thread、slash command 或 Activity 数据语义。
- 不通过 OSC 修改用户终端 profile，也不伪造超出字符网格的绘制区域。
- 不解决 OpenTUI Input 尚未提供 password masking 的既有限制。

## 2. 为什么这样设计

### 核心判断

Config 和 Composer 都是应用层的瞬态输入，不应产生新的 Harness 概念。键盘和鼠标必须只触发同一个 `focus` 与 `apiFormat` 状态，否则会形成两个交互状态机。底部色带来自终端窗口高度不能整除字符单元高度后的像素余量，不是 Yoga 多出的一行；字符 renderer 无法绘制这些像素，因此最外层必须使用 terminal-native canvas。Workspace 的模型、安全与成本状态描述左侧 Composer，应与右侧 Activity 的事件观察面保持清晰所有权边界。

### 考虑过的替代方案

- 继续使用固定 `#141414` 填满 OpenTUI 行：无法覆盖字符网格之外的像素，色带仍存在。
- 把背景改成截图中终端的 `#050505`：只对一个 terminal profile 有效，不可移植。
- 用 OSC 11 临时修改终端默认背景：侵入用户终端状态，恢复和兼容性成本高，最终拒绝。
- 为鼠标维护独立 selected/focused 状态：会与键盘分叉，最终拒绝。
- 用单行 `input` 模拟换行或在 React 外维护第二份文本 buffer：会重复原生编辑能力，最终拒绝。
- 保留全宽 footer 再用空格伪装分栏：布局所有权仍然错误，终端 resize 时也不可靠，最终拒绝。
- 新建多个组件或测试文件：当前控件只服务 Config，本地小组件和现有 smoke path 已足够承载边界。

### 主要 trade-off

外层区域采用用户终端背景，因此 Jixu 不再强制给每个屏幕像素一个固定底色；作为交换，任意字符尺寸和 terminal profile 都不会暴露一条不同颜色的残余带。中央配置卡片仍使用固定深色背景，核心品牌体验和文本对比度保持稳定。

## 3. 架构与概念

### 概念关系

`JixuApp` 继续负责 config/workspace 页面切换；`Setup` 负责配置状态与连接；`FieldLabel`、`FormatOption` 和 `SetupField` 是 Config 内部的纯展示/交互边界；Workspace 左列拥有 Transcript、Composer 与 `ComposerStatus`，右列只拥有 `ActivityRail`；`jixuTheme.canvas` 表达终端原生画布，`background` 与 `surface` 表达 Jixu 自有层级。

### 权威与数据边界

鼠标、键盘、Composer 草稿和视觉焦点只属于瞬态 UI state，不进入 Thread Event、Checkpoint 或 Signal。只有普通 Enter 触发既有提交路径；Shift+Enter 只编辑草稿。保存行为仍由既有 `onConnect` 和配置 Store 负责，secret 不进入 Harness durable State。

### 执行时序

1. Tab/Shift+Tab 或字段 mouse down 更新同一个 `SetupFocus`。
2. API format 的键盘或 mouse down 更新同一个 `JixuApiFormat`。
3. React state 驱动 Input `focused`、边框色、说明色和 selected surface。
4. Enter 或 Connect mouse down 调用同一个校验与 `onConnect` 路径。
5. 连接失败把焦点返回具体错误字段；成功后由 `JixuApp` 返回 workspace。
6. Composer 的 key bindings 把无 modifier 的 Enter 映射为 submit，把 Shift+Enter 映射为 newline。
7. Textarea 按内容自动增长；达到 8 行外框上限后保持布局高度并在内部滚动。

## 4. 实现方式

### 关键模块

- `theme.ts`：区分透明 terminal canvas 与固定 Jixu background/surface。
- `cli.tsx`：renderer 初始 buffer 使用 canvas token。
- `tui-setup.tsx`：三段式视口、配置控件、统一键鼠状态和视觉层级。
- `tui-workspace.tsx`：工作区最外层同样使用 canvas，避免其他页面重现底部色带。
- `slash-command-menu.tsx`：slash menu 与 Thread picker 复用同一个 `TextareaRenderable` 焦点引用。
- `tui-smoke.tsx`：复用真实 OpenTUI parser、mouse hit grid 和 React renderer 验证普通路径。

### 关键算法或状态转换

`onPrimaryMouseDown` 只接受左键并转发一个领域无关 action。字段和格式组件不持有自己的 selected state；它们仅根据父级 `focus`、`apiFormat` 和输入值渲染。页面根容器以 `justifyContent: "space-between"` 放置等高 header/footer，使中央卡片在剩余空间自然居中。Workspace 主区域是左右两列，左列内部再划分 chat body 与两行状态；因此 Activity rail 的高度不再被 Composer 状态截断。Textarea 外框上限为 8 行，扣除上下 padding 后编辑区上限为 6 行。

### Failure path

URL、API key 或 model 校验失败时沿用现有 typed message，并把 `SetupFocus` 指向对应字段。connecting 期间重复 Connect 会被既有 guard 忽略。鼠标不可用的终端仍可通过完整键盘路径操作。

## 5. 使用的技术

- OpenTUI React `box`、`input`、`textarea`、mouse hit grid 与 `onMouseDown`。
- Yoga `space-between`、固定行高、responsive width 和 80x24 resize。
- React state、ref、effect 与受控 focus。
- OpenTUI in-memory renderer、Kitty keyboard protocol、`mockInput` 和真实 ANSI parser。

## 6. 验证证据

### Tests

- `pnpm --filter jixu test:tui`：通过。
- `pnpm run check`：44/44 Node tests 与 TUI smoke 全部通过。

### Static checks

- `pnpm run build:packages`：通过。
- `tsc --noEmit`：通过。
- `pnpm run lint`：通过，输出 `core architecture lint passed`。
- `git diff --check`：通过。

### 自动化边界

- TUI smoke 继续完成从未配置状态进入 Config、填写凭证、连接模型并返回 Workspace 的核心路径。
- Shift+Enter 保留换行、普通 Enter 提交并清空草稿，作为 Composer 的核心输入语义保留最小回归。
- Config 首尾行、鼠标选中样式、状态栏分栏和 Composer 精确高度属于可快速人工验收的 UI 细节，不再逐项写自动化断言。

## 7. 遇到的问题与经验

初次补充鼠标验收时，把 `mockMouse.click()` 触发 state 与 `renderOnce()` 放在同一个 async `act()` 中。React 在该 `act()` 退出时才提交 state，因此 renderer 捕获到旧帧，造成“点击没有生效”的假象。正确顺序是：interaction 使用一个 `act()`，待 state 提交后再用第二个 `act()` 绘制和断言。

这个规则在阶段 04 已经记录，但没有提升到仓库测试规则，本阶段又重复踩坑。现已写入 `AGENTS.md`；后续不得用生产代码试探来补偿 stale-frame 测试错误。

本阶段一度为坐标、鼠标选中样式和精确高度增加了过细断言。它们没有保护 Harness 的核心失败边界，反而会把正常的视觉迭代变成测试维护成本。发布前已删除，只保留连接主路径与多行输入语义，并把“UI 默认不需要自动化测试”写入仓库规则。

## 8. 已知限制与风险

- 80x24 是当前最小验收视口；更矮的终端可能无法同时容纳完整四字段表单。
- 外层 canvas 继承 terminal profile；中央卡片负责稳定对比度，但极端浅色终端下外层辅助文字可能需要未来的 theme-mode 适配。
- OpenTUI Input 仍会在 Config 页显示 API key；secret 不会出现在 workspace、Thread State 或 Event 中。
- Shift+Enter 依赖终端上报 modifier；支持 Kitty keyboard protocol 的现代终端可可靠区分，无法区分修饰键的旧终端只能按其实际输入事件处理。

## 9. 下一阶段入口

由 maintainer 在真实终端中验收背景余量、颜色层级和鼠标手感。通过后再进入下一 Harness milestone；本阶段不继续扩展 Config 概念或视觉组件库。

## 10. 文件索引

- `AGENTS.md`
- `SPEC.md`
- `packages/jixu/src/cli.tsx`
- `packages/jixu/src/theme.ts`
- `packages/jixu/src/tui-setup.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/test/tui-smoke.tsx`
