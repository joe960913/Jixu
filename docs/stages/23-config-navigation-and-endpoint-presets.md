# 阶段 23：Configuration 返回与 endpoint presets

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | M2.13 |
| 状态 | Completed locally |
| 关联需求 | `JX-TUI-015`、`JX-TUI-027`、`JX-TUI-028`、`JX-TUI-029`、`JX-PROV-006` |
| 关联验收 | `JX-AC-029`、`JX-AC-042`、`JX-AC-043` |

## 1. 阶段目标与边界

### 要解决的问题

进入 `/config` 后只能通过 `Ctrl+C` 终止整个应用，无法回到原 workspace；同时
Base URL 只有自由输入，常见 endpoint 需要用户自行查找和完整录入。

### 本阶段完成

- 在 Configuration 页头增加可点击的 `BACK TO CHAT`，并让 `Escape` 执行相同返回；
- 打开 Configuration 时保留现有 active connection 和 selected Thread；
- connection attempt 进行中临时禁用返回，避免晚到结果覆盖已返回的 workspace；
- 为 OpenAI Chat Completions 提供 OpenAI、OpenRouter、DeepSeek、Groq 和 Custom；
- 为 Anthropic Messages 提供 Anthropic、OpenRouter、DeepSeek 和 Custom；
- preset 只填充现有 Base URL，并自动进入仍可编辑的原生输入框；
- 删除没有当前状态含义的 protocol footer，分别标注 settings、API key 和 workspace；
- 键盘提示改成独立 key/action layout group，不再用 `·` 拼接状态句；
- 在 80×24 中收紧卡片 padding 和提示行，保留完整表单、preset 与返回路径。

### 本阶段明确不做

- 不增加 provider、vendor、model catalog 或自动模型发现；
- 不增加配置 schema 字段，不迁移或重写 settings、auth、Event 或 Thread；
- 不根据 endpoint 自动切换 protocol 或 model；
- 不启动 dev server、浏览器或真实 provider 请求；
- 不提交、推送或处理 unrelated worktree changes。

## 2. 为什么这样设计

### 核心判断

Configuration 是 workspace 的可逆视图，不是 connection 生命周期本身。退出表单
不应销毁仍可用的 Controller。Endpoint preset 也只是输入辅助：持久化权威继续是
现有 `api + baseUrl + model`，不能因为 UI 便利再引入 provider routing state。

### 考虑过的替代方案

- **进入 Config 就清除 active connection**：导致无法无损返回，拒绝；
- **在 Base URL input 内抢占数字键或方向键**：会破坏端口、路径和光标编辑，改为
  独立 preset focus；
- **选择 provider 后同时猜 model**：model catalog 会漂移，也会制造第二套配置权威，
  拒绝；
- **把 preset 写入 settings**：运行时只需要规范化 URL，额外字段没有语义价值，拒绝。

### 主要 trade-off

Preset 列表是小而显式的维护面，不能覆盖所有兼容服务；`Custom` 保留任意合法
HTTP(S) URL。独立 preset focus 多一个 Tab stop，但避免与 URL 输入的正常编辑冲突。

## 3. 架构与概念

### 概念关系

```text
workspace active connection + selected Thread
  -> /config
Configuration view (active connection retained)
  -> Escape / BACK TO CHAT
same workspace connection + selected Thread

protocol
  -> endpoint preset
  -> editable Base URL
  -> existing normalize + connect + schema v3 save
```

### 权威与数据边界

Preset label 和 cursor 只是 React presentation state。选择 preset 后只更新表单的
`baseUrl` 字符串；保存时仍经过 `normalizeJixuBaseUrl`，凭据仍由 auth 文件单独保存。
Thread Event log、State、Replay 和 Controller snapshot 均不接收 preset identity。

### 执行时序

Protocol focus 的 Enter 进入 preset row；方向键只移动 cursor，数字键或 Enter 应用
preset 并进入 URL input。鼠标选择执行同一 apply-and-focus transition。连接成功后
才替换 active Controller；连接失败时旧 Controller 仍可通过返回继续使用。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/tui.tsx`：Config view 不再清空 active connection，并注入返回动作；
- `packages/jixu/src/tui-setup.tsx`：返回键、endpoint presets、五段 focus 和 compact height；
- `packages/jixu/test/tui-smoke.tsx`：两种 protocol、鼠标/键盘返回、controller identity
  与 80×24 smoke；
- `SPEC.md`：`JX-TUI-027` 至 `JX-TUI-029`、`JX-AC-042`、`JX-AC-043`
  和兼容性说明。

Configuration chrome 同样由 `tui-setup.tsx` 负责，但每个文件位置、keyboard action、
workspace 和 Quit 都是独立 layout node；视觉层级来自对齐、间距与 semantic color，
不依赖标点分隔符。

### 关键算法或状态转换

当前 Base URL 与 preset 比较时只 trim 并去除尾部 slash，用于展示 applied marker；
真正保存仍调用严格 normalizer。未匹配 URL 始终归为 Custom。Protocol 切换只重算
preset cursor，不改写当前 URL；只有显式 apply 才填充 preset 值。

### Failure path

- Base URL、API Key 或 Model ID 校验失败后聚焦对应原生输入框；
- connection promise pending 时 Escape 和 Back 不离开，防止异步竞态；
- connection 失败保留旧 active Controller，用户可修改后重试或返回；
- preset 不匹配或用户编辑后的任意 URL 自动显示为 Custom。

## 5. 使用的技术

- TypeScript closed protocol union 与 `satisfies` typed preset map；
- React local state、derived selection 和受控 input；
- OpenTUI `useKeyboard`、primary mouse hit target 与 normal-flow flex layout；
- 高度感知的 80×24 compact layout，不使用 overlay 或 forced remount。

## 6. 验证证据

### Tests

- OpenTUI smoke：OpenAI 与 Anthropic preset 都能填充准确 Base URL；
- 鼠标 Back 返回未配置 workspace；
- active workspace 中 `Escape` 返回后 `ThreadController` object identity 不变；
- 80×24 frame 同时包含 header、Back、全部字段、preset、Connect 和 footer；
- wide frame 明确显示 `~/.jixu/settings.json`、`~/.jixu/auth.json` 和 labeled workspace；
- 80×24 frame 显示 `settings.json`、`auth.json`、Back 与 Quit，且无 `·` 分隔符；
- `pnpm run check`：51/51 Node tests 与完整 TUI smoke 通过；
- `pnpm run test:packages`：同一 tarball set 通过 npm、pnpm、Yarn、Bun clean consumer。

### Static checks

- `tsc -b tsconfig.build.json`：通过；
- `tsc --noEmit`：通过；
- `pnpm run lint`：通过，core architecture lint passed；
- `git diff --check`：通过。

### 关键断言

- Config navigation 不触发 reconnect，也不丢 active connection；
- preset selection 与 URL editing 是两个 focus surface，不抢占输入键；
- preset identity 不进入 schema v3 或 Thread durable data；
- compact viewport 不裁掉返回路径或 Connect。

## 7. 遇到的问题与经验

OpenTUI renderer 的 `findDescendantById` 返回 `Renderable`；最初 smoke 将其误收窄成
React `BaseRenderable`，运行测试虽通过，但 `tsc --noEmit` 正确发现坐标类型缺失。
改用真实 renderable 类型后，mouse hit test 与静态类型保持一致。

增加 preset row 后，原卡片在 80×24 会超过安全高度。最终没有压缩 input 或引入
滚动，而是在短 viewport 取消非必要的 protocol helper 和内层 padding，使四个字段、
preset、返回与 footer 都继续通过普通布局呈现。

最初的 footer 用 protocol 名称填满左侧、用未标注的 path 填满右侧，信息看似丰富，
实际既重复又含义不清。后续文案方案仍习惯用 `·` 串联不同信息，也会形成机器生成的
状态句观感。最终改为独立 key/action 与 labeled value 节点，让布局本身承担层级。

## 8. 已知限制与风险

- Provider endpoint 可能随上游变化，需要在后续维护中按官方文档更新；
- Preset 不验证 API key 或 model compatibility，真实 connect 仍是最终验证边界；
- 未列出的兼容服务继续使用 Custom；
- connection attempt pending 时暂不支持取消，只防止返回竞态。

## 9. 下一阶段入口

若继续打磨 Configuration，优先考虑安全遮罩 API Key、可取消的 connection probe，
以及 provider 错误的可行动反馈；不要把动态 model catalog 或 provider 路由状态塞进
核心配置，除非有新的明确产品需求和协议证据。

## 10. 文件索引

- `SPEC.md`
- `packages/jixu/src/tui.tsx`
- `packages/jixu/src/tui-setup.tsx`
- `packages/jixu/test/tui-smoke.tsx`
