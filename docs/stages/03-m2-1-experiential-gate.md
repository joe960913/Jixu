# 阶段 03：M2.1 Experiential Gate

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-18 |
| Milestone | M2.1 — Experiential Gate |
| 状态 | Accepted and merged to `main` |
| 关联需求 | `JX-API-008`、`JX-PROV-005`～`JX-PROV-008`、`JX-TOOL-006`～`JX-TOOL-007`、`JX-TUI-001`～`JX-TUI-008`、`JX-SEC-001`、`JX-SEC-005`、`JX-SEC-007` |
| 关联验收 | `JX-AC-002`、`JX-AC-013`、`JX-AC-015`、`JX-AC-016`、`JX-AC-018`、`JX-AC-019` |

## 1. 阶段目标与边界

### 要解决的问题

M2 已经用自动化测试证明 Run 可以恢复、暂停、继续、Fork 和 Replay，但维护者没有一条
真实、连续的路径去体验这些能力。一个只有内部 contract tests 的 agent framework 很难
判断概念是否真的容易理解，也无法验证普通开发者看到的是一个 Agent，还是另一套为演示
临时发明的状态机。

M2.1 的目标是建立最窄但真实的 vertical slice：用户在终端里配置模型、输入任务、看到
模型与 Tool 活动，并通过公开 continuity 能力观察 Run。这个体验层必须消费 M2 的同一
套 Runtime，而不能绕过 durable Event log。

### 本阶段完成

- 为 `RunHandle` 增加 Event catch-up + live Event/Signal 的统一 stream；
- 建立 `@jixu/llm` 统一 adapter，显式支持 Responses 和 Chat Completions wire format；
- 建立 `@jixu/tools-node`，提供名称固定的 `read`、`write`、`edit`、`bash`；
- 建立 `jixu` OpenTUI 应用，使用一个普通不可变 `Agent`；
- 在 TUI 内完成 API format、Base URL、API Key、自由文本 model ID 配置；
- 将 API Key 持久化到全局 `~/.jixu/auth.json`，普通设置放到
  `~/.jixu/settings.json`；
- 完整配置在下一次启动时自动恢复，`/config` 可以回到配置页，并兼容迁移旧 v1 provider 配置；
- 提供 `/events`、`/state`、`/pause`、`/resume`、`/replay`、`/fork` 控制；
- 引入集中 theme token，并把今样色 `#D05A6E` 限制为品牌与交互焦点；
- 将主界面收敛为 chronological transcript；宽屏增加约 4:1 的轻量 developer activity rail，
  窄屏则把关键 model、Tool、control activity 按因果位置插入内容流；
- composer 固定在左侧聊天列底部，工作区只保留左右各一列边距，并通过 `80x24` 降级验收；
- 空态使用 OpenTUI 原生 block ASCII `JIXU`，工作态退回紧凑 wordmark；今样色只用于品牌、
  左侧细线和光标，不做大面积填充；
- 将 source TUI 的 Bun 基线升级并验证为 1.3.14。

本轮 ASCII 品牌空态和 4:1 activity rail 属于维护者明确要求的快速 UI 验证；按维护者指示，
没有为这次视觉实验修改 `SPEC.md`。本记录只沉淀实现证据，不构成规范更新。

### 本阶段明确不做

- 不发布 npm packages；
- 不承诺 npm、pnpm、Yarn、Bun 的 packed consumer portability；
- 不制作 Web UI；
- 不实现 Anthropic、MCP、Skills 或 approval；
- 不实现真正的 shell sandbox；
- 不把 TUI 状态、provider state 或配置文件变成 Run 权威；
- 不因为 TUI 引入 `CodingAgent`、`TuiAgent` 或 demo-only Runtime。

## 2. 为什么这样设计

### 核心判断一：可体验性是架构验收，不是装饰

如果 continuity 只能通过测试文件理解，概念是否清晰仍然没有被验证。TUI 迫使架构回答：

- 用户在哪里看到 durable Event 和 transient Signal 的区别？
- pause/resume 是控制同一 Run，还是在 UI 内偷偷维护另一份状态？
- Tool 名称和真实能力是否匹配？
- provider 是否只是 adapter，还是会改变 Agent 生命周期？

因此 M2.1 被插入 M2 接受之前，而不是作为 M4 的 UI polish。

### 核心判断二：只有一个 Agent 概念

代码操作不是 Jixu 唯一或黄金场景。`read`、`write`、`edit`、`bash` 是当前 reference
Agent 获得的 Tool，不是定义一个 `CodingAgent` 的理由。TUI 创建的是普通
`defineAgent(...)` 结果，Runtime、Run、Event、Effect 的语义和 headless 使用完全相同。

这让未来的 research、operations、customer support 等 Agent 仍使用同一抽象，仅通过
instructions、model 和 Tools 组合能力。

### 核心判断三：endpoint 差异必须停在 adapter 边界

Responses-compatible 与 Chat-Completions-compatible endpoint 使用同一个 canonical
`ModelDriver` contract。Agent 只记录稳定的 adapter ID 和 model，Kernel 不导入 provider
SDK，也不知道 Base URL、credential 或 response wire format。

用户显式选择 API format，adapter 不会在请求失败后改走另一条 endpoint。自动 fallback
可能让一个已被上游接收但响应中断的请求重复执行、重复调用 Tool 或重复计费。OpenAI 和
OpenRouter factory 仍保留为 convenience API，但 reference TUI 不硬编码 provider catalog。
切换 endpoint 不改变 Run lifecycle、Event shape 或 TUI session。

### 核心判断四：Key 应当持久化，但不能进入 workspace

要求用户每次重输 Key 会让 TUI 变成一次性 demo。当前本地 agent 产品的通行做法是把
credentials 和普通设置分开保存。因此采用：

```text
~/.jixu/
├── auth.json       # endpoint API key
└── settings.json   # API format + Base URL + model ID
```

它们都不属于 Run history。`auth.json` 是显式 versioned schema；POSIX 下目录为 `0700`，
文件为 `0600`。写入使用同目录临时文件、flush、原子 rename，避免半个 JSON 成为下一次
启动的凭证来源。

用户仍可用环境变量或 CLI flags 预填，但 TUI 本身必须能完成全部设置。模型不维护 catalog，
直接接受 model ID，避免模型列表过期或把 router 能力固化进 Jixu。

### 核心判断五：配置可靠性优先于自制 secret widget

API Key 使用 OpenTUI 原生 `<input>`，与 Base URL 和 model ID 共享同一焦点、粘贴、退格和
提交路径。Key 在 Setup 中可见；用户明确接受这一取舍。安全边界是 Key 只能进入内存、
`auth.json` 和 provider SDK，不得进入 Event、Checkpoint、Signal 或错误文本。

这不是系统 Keychain 或内存加密。后续如果 OpenTUI 提供稳定 password input，再在不接管
底层 keyboard dispatch 的前提下升级显示策略。

### 核心判断六：agent harness 需要 developer density，但不是 observability dashboard

M2.1 第一版把 `Conversation`、`Run activity` 和 `New Run` 做成三个有边框区域。它在功能上
完整，却把内部架构直接变成了信息架构：宽屏出现大片空面板，activity 脱离触发它的消息，
输入框被当成创建 Run 的表单。维护者体验后明确拒绝了这套设计，因此阶段重新打开。

直接观察 Claude Code 2.1.224、Codex CLI 0.148.0-alpha.15 和 OpenCode 1.18.9 后，共同精髓是：

- 主体只有一条时间顺序内容流；
- thinking、Tool、retry、error 在发生位置就地出现；
- composer 是持续可见的低矮工作面，不是 full-width form；
- provider/model/workspace/control 被压缩进邻近 context 或 status line；
- 空态可以有较强品牌识别，进入工作后品牌退回 wordmark 和少量 accent；
- 高级细节通过 command、inline activity 或窄 rail 渐进展开，不能让观测界面压过工作内容。

第二轮视觉验收又暴露了另一个极端：完全删除右侧信息面虽然简洁，却降低了 framework
开发者观察 Run、model 与 Tool 行为的效率。最终方案保留一条轻量 `ACTIVITY` rail：只在足够宽的
终端出现，聊天与 activity 约为 4:1；它没有四边框、空白大卡片或第二套状态机，只投影现有
session activity，并用短 Event ID 帮助与 `/events` 对照。窄屏隐藏 rail，把有解释力的 activity
放回 transcript，保证 `80x24` 仍可完成任务。

Jixu 没有复制其中的 agent mode、session navigation 或产品文案。它保留自己的 durable
controls，并用今样色 `#D05A6E` 作为 wordmark、左侧细线、cursor 和关键焦点。这样既能形成
JIXU 识别，又不会成为 Claude Code/OpenCode 的换皮。

### 主要 trade-off

| 选择 | 获得 | 代价 |
| --- | --- | --- |
| OpenTUI + React | 当前活跃 TUI runtime、组件化状态管理、可做 in-memory renderer test | source TUI 依赖 Bun 和 native package |
| JSONL workspace Store | Run 可直接检查、与 M2 Store contract 对齐 | 只支持一个活跃本地进程 |
| 全局 JSON config | 可理解、可备份、无需 OS-specific 服务 | 不具备 Keychain 的硬件/系统隔离 |
| 显式 API format cards | 两种 wire format 清楚且不会自动 fallback | 比单一 endpoint 多一个配置选择 |
| 原生可见 API Key input | 焦点、粘贴和测试路径可靠 | Setup 页面会显示 Key |
| local unsandboxed bash | 用户能真实完成广泛任务 | 权限等于 Jixu 进程，必须明确警告 |

## 3. 架构与概念

### 概念关系

```text
OpenTUI
  |
  +-- config form --> JixuConfigStore --> ~/.jixu/auth.json + settings.json
  |
  `-- JixuSession --> ordinary Agent --> Runtime --> durable Run
                                          |
                                          +-- Model Effect --> @jixu/llm --> compatible endpoint
                                          `-- Tool Effect  --> @jixu/tools-node

Run.stream()
  +-- durable Event catch-up
  `-- live Event + transient Signal
```

TUI 只订阅并投影 Runtime 公开信息。它不持久化 canonical Run state，不生成另一类 Event，
也不决定 Run 的真实 status。

### 权威与数据边界

| 数据 | 位置 | 是否 Run 权威 |
| --- | --- | --- |
| Run Events | workspace `.jixu/` JSONL Store | 是 |
| Derived State | Runtime / Replay | 否，可由 Event 重建 |
| Signals | process-local stream | 否 |
| TUI transcript/activity | React session state | 否 |
| API Keys | global `~/.jixu/auth.json` | 否，且禁止进入 Event |
| endpoint/model defaults | global `~/.jixu/settings.json` | 否 |

### 执行时序

```text
launch
  -> load versioned settings/auth
  -> complete config? yes: enter Agent / no: show Setup
  -> save submitted config atomically
  -> create compatible ModelDriver behind unified adapter
  -> define ordinary Agent with Node Tools
  -> prompt creates durable Run
  -> stream historical Events, then live Events/Signals
  -> merge transcript/activity by application sequence
  -> render one chronological feed; inspect State/Events on demand
```

## 4. 实现方式

### `@jixu/core`

`RunHandle.stream({ signal })` 先读取 selected durable Event prefix，再订阅 live sink。实现对
sequence 去重，保证 catch-up 与 live 交界处不会重复同一 Event。`AbortSignal` 终止 consumer
等待，不改变 Run authority。

### `@jixu/llm`

统一 factory 按显式配置把 canonical model input 映射到 Responses 或 Chat Completions API，
并把两种 streaming text/tool-call delta 转换成 `model.output_text.delta` 等 Signal。Chat
Completions 路径会还原 system、assistant tool calls 和 tool result 的完整历史。最终文本和
Tool calls 通过 typed outcome 返回，仍由 Runtime 追加 durable outcome Event。

adapter 的 typed error 会做 credential redaction，测试覆盖 API Key 不进入 errors 或
Signals。

### `@jixu/tools-node`

- `read`：读取 workspace 内文件，返回 path、content、truncated；
- `write`：创建或覆盖 workspace 内文件；
- `edit`：做显式 old/new text replacement，并拒绝歧义匹配；
- `bash`：本地 unsandboxed shell，带 timeout、output limit 和 cancellation propagation。

文件 Tool 同时做 lexical boundary 和 resolved symlink boundary 检查，防止 `../` 和
workspace 内 symlink 绕出 root。`bash` 无法继承这种文件边界，因此产品文案固定为
`Local shell · unsandboxed`，不能用模糊的 `host shell` 弱化风险。

### `jixu` TUI

TUI 分成两个主要 surface：

1. `Setup`：API format card、Base URL、可见 API Key、自由文本 model ID；
2. `AgentWorkspace`：左侧 transcript + compact composer、可响应的 developer activity rail、
   context/status line。

`JixuSession` 是 application model，不是第二套 Run authority。它把命令映射到公开 Run API，
并把 Event/Signal 投影成带共享递增 ID 的 transcript/activity snapshot。宽屏时 transcript
保留用户与 assistant 的主叙事，右侧 rail 展示 developer activity；窄屏则按 ID 合并两类项目，
所以 model 与 Tool 活动仍出现在触发它们的 user input 和最终 model output 之间。

`run.created`、`input.received`、`model.completed` 等 plumbing Event 不进入窄屏主内容流，但会在
宽屏 developer rail 中提供执行脉络；完整 payload 仍通过 `/events` 查看。`Thinking`、Tool 调用、
failure、pause/resume 等对当前行为有解释力的项目在窄屏进入内容流。`/state`、`/events`、
`/replay` 的完整结果仍在内容流尾部形成临时 inspector，不把 rail 变成 payload viewer。

用户消息和 composer 使用 neutral surface，并以 1 列今样色左线识别交互边界；assistant 使用
OpenTUI Markdown 渲染。空态使用原生 `ascii-font` 的 `block` 字体生成大号 JIXU 标识，不维护
容易错位的手写字符画。工作区只保留左右各一列边距；可用宽度达到 106 列时，左侧聊天与
右侧 activity 约为 4:1，低于阈值则折叠 rail。model context 和 `Local shell · unsandboxed`
处于同一底部状态层级，slash commands 只出现在空态。`80x24` 始终保留 prompt、安全文案和
`/config` 入口。

`/config` 只在没有 active busy Run 时回到 Setup，避免模型执行中途更换 executable Agent
配置。保存后的 endpoint 配置会成为下一次启动的默认连接。

### 配置 Failure path

- 文件缺失：返回空配置，显示 Setup；
- schema version/type 错误：fail closed，不猜测旧格式；
- 解析失败：错误信息只包含文件 label 和结构错误，不拼接原始 secret 内容；
- concurrent save：进程内 write tail 串行化；
- 写入中断：同目录 temp file 不会替换最后一次完整文件；
- API format/Base URL/Key/model 不完整：留在 Setup，不启动 Runtime；
- saved config 连接创建失败：回到 Setup 显示错误，可直接替换配置。

## 5. 使用的技术

- TypeScript ESM、strict discriminated unions；
- Node.js 22.18+ headless compatibility，当前验证 Node 24.14.0；
- Bun 1.3.14 运行 OpenTUI source application 和 renderer tests；
- OpenTUI Core + React 0.5.4；
- OpenTUI `ASCIIFont`、`ScrollBox` sticky-scroll、partial-border `Box`、flex layout、`Input`、
  `Markdown` 和 in-memory `testRender`；
- React 19 state、effect、external store subscription；
- OpenAI JavaScript SDK Responses API 与 Chat Completions API；
- Node filesystem `open`、`fsync`、`rename`、`chmod` 实现 atomic restricted JSON；
- Node child process / AbortSignal 实现 bounded local shell；
- Node test runner + OpenTUI in-memory test renderer。

## 6. 验证证据

### Tests

最终执行 `pnpm run check`：

- TypeScript typecheck：通过；
- architecture lint：通过；
- Node tests：44/44 通过；
- OpenTUI smoke test：通过；
- `git diff --check`：通过。
- headless `jixu` entry import：通过，未初始化 renderer；
- `jixu --help`：正常退出且未创建配置目录。

M2.1 的关键覆盖包括：

- Event/Signal catch-up、去重和 AbortSignal；
- Responses request mapping、delta Signal、Tool call outcome 和 caller Base URL；
- Chat Completions 完整历史、streaming text/tool call 与 caller Base URL；
- OpenAI/OpenRouter convenience factory 与 unified adapter contract；
- 两种格式的 typed error credential redaction；
- `read/write/edit` happy path 与 lexical/symlink escape；
- `bash` timeout/output/cancel boundary；
- 普通 Agent 经真实 Runtime 调用 Node Tool；
- settings/auth 分离、v2 connection schema、v1 migration、atomic write 无 temp 残留；
- POSIX directory `0700`、auth `0600`；
- malformed auth fail closed 且 error 不泄露 fixture；
- TUI Setup、free-form model、Agent screen、`/config`、auto restore；
- TUI completed Run 中 user input、`Thinking` 和 Markdown response 的因果顺序；
- `120x30` active/completed 4:1 frame、`160x36` full-width frame 和 `80x24` compact frame；
- 宽屏大号 ASCII `JIXU`、developer activity 数量/状态/短 Event ID 与空态；
- 窄屏隐藏 activity rail，并保留 inline `Thinking` 与最终 response；
- 主界面不存在 `Conversation`、`Run activity`、`New Run` 的重型 dashboard 文案；
- active workspace、Event、Signal 和 typed error surface 不显示 fixture API Key。

### 真实启动检查

使用隔离的临时 `JIXU_HOME` 和 workspace 启动 source TUI，确认：

- 首次启动进入 Setup；
- 未提交配置时只创建 `0700` config directory，不创建 auth/settings；
- workspace Run Store 不会在连接前提前创建；
- Ctrl+C 后 renderer/process 正常退出。

上述真实启动检查发生在布局重构前，证明的是 config、renderer lifecycle 和退出路径。新的
ASCII 空态、4:1 developer rail 与 compact fallback 已通过 native in-memory frame 验收，仍需
维护者在真实 endpoint 路径中完成最终视觉与交互体验验收。

### 未执行的 live probe

当前环境没有可用的付费 endpoint API Key，因此没有对真实 provider 发请求。两种 wire
contract 由 mock client 精确断言，但 live response/body 仍需维护者用自己的 Key
在验收路径中完成一次。

## 7. 遇到的问题与经验

### 自制 non-rendering secret capture 不值得成为基础设施

曾尝试让普通 `Box` 或 renderer-level listener 接管 API Key，再只渲染 `Key captured`。在
OpenTUI 0.5.4 的 in-memory renderer 中，从原生 Base URL input 切换后，焦点虽显示在 Secret
区域，但字符没有稳定交给自定义 handler。继续修补会让配置可靠性依赖 library 内部事件顺序。

维护者明确选择可见 Key，因此最终复用原生 Input。经验是：框架不应为了视觉遮罩自建输入
组件；安全不变量应该放在 Event/Signal/error redaction 与文件权限上。

### 产品文案是安全边界的一部分

`host shell` 对普通用户不清楚。`Local shell · unsandboxed` 明确表达执行位置和隔离事实，
并与 Tool contract test 中的真实能力一致。

### 配置属于产品，不是启动脚本细节

只支持环境变量会让 TUI 体验断裂；不保存 Key 会让每次启动都像 demo。把设置放进 TUI、
把 Key/普通配置拆开持久化后，reference app 才成为可日常使用的最小 Agent surface。

### 架构正确不等于信息架构正确

第一版 permanent activity panel 没有违反 Event 权威或 Runtime 边界，但它仍然是错误的产品
表达。它把 observability 当成 default workspace，把 `Run` 这个内部事实强迫用户在每次输入
时理解；随后完全删除 rail 又损失了 developer harness 应有的可观察密度。最终边界是：聊天永远
占主导，activity 只占约五分之一、只呈现可扫读摘要，完整审计仍进入 `/events`、`/state`、
`/replay`。产品迭代不是在“有面板/没面板”间二选一，而是控制信息层级和响应式退化。

### OpenTUI Markdown 的首帧不是最终帧

`<markdown>` 第一次渲染会异步准备解析器。最初 smoke test 只看到 `JIXU` label，若立即截图会
误判 response 丢失。测试现在等待 Markdown 内容真正进入 frame，再断言粗体 marker 被 conceal。
这说明现代 TUI 验收不能只验证 React state 已更新，还必须验证 native renderer 的最终字符帧。

## 8. 已知限制与风险

- `bash` 没有 sandbox，能访问 Jixu 进程可访问的本机资源；
- JSON auth 依赖 filesystem permissions，不等同于 macOS Keychain/Windows Credential Manager；
- 没有 live endpoint probe，真实账号策略或 provider-side error 仍需验收；
- OpenTUI transitive `bun-ffi-structs@0.3.1` 声明 TypeScript peer `^5`，当前 workspace
  TypeScript 6.0.3 产生 peer warning；typecheck 与 runtime tests 均通过，当前作为 non-blocking
  upstream metadata mismatch 记录，只有在实际安装或发布失败时再处理；
- SQLite 在当前 Node 仍输出 experimental warning；
- source TUI 需要 Bun；standalone executable 属于 M4；
- packed package manager portability 尚未验证；
- JSONL Store 只面向一个 active local process；
- 当前 setup 没有单独清空 credential 的操作；替换已有 Key 已支持。

## 9. 下一阶段入口

维护者先用任一兼容 endpoint 的 Key 完成一次体验验收：

1. `pnpm dev`；
2. TUI 内配置 API format、Base URL、Key、model ID；
3. 要求 Agent 读取或修改 workspace 文件；
4. 检查就地 model/Tool activity、`/events`、`/state` 和 `/replay`；
5. 退出并重启，确认无需重输；
6. 用 `/config` 切换或替换 endpoint 配置。

M2/M2.1 已由维护者验收，以 commit `3a684da` 经 GitHub PR #1 合并到 `main`，merge commit
为 `ff68d77`。下一开发阶段是 M3，完成 Anthropic、MCP、Agent Skills 等生态 adapter；
package publication 与四 package-manager packed fixtures 留在 M4。

## 10. 文件索引

- `packages/core/src/runtime.ts`：Run stream 与 live sink；
- `packages/llm/`：unified ModelDriver adapter；
- `packages/tools-node/`：Node Tools；
- `packages/jixu/src/config.ts`：global settings/auth store；
- `packages/jixu/src/session.ts`：TUI application session；
- `packages/jixu/src/tui.tsx`：OpenTUI React surface；
- `packages/jixu/src/cli.tsx`：CLI lifecycle 与 composition root；
- `packages/jixu/test/`：config、session 和 renderer acceptance tests；
- `SPEC.md`：M2.1 normative requirements；
- `README.md`：maintainer体验路径。
