# 阶段 25：Tool 单条展开与语义 Markdown

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | M2.15 |
| 状态 | Completed locally |
| 关联需求 | `JX-TUI-026`、`JX-TUI-031` |
| 关联验收 | `JX-AC-041`、`JX-AC-045` |

## 1. 阶段目标与边界

### 要解决的问题

Tool action stream 的行看起来像 disclosure，但此前只能通过全局 `Ctrl+O` 展开；用户无法
点击某一条查看详情，展开输出也没有独立高度边界。与此同时，assistant Markdown 虽然
能生成 fenced code block，却只有基础 Markdown 颜色，代码 token 基本呈单色；普通内容
还会暴露 heading hash、task checkbox、table pipe 和 code fence 等源码符号，视觉层级接近
未渲染的文本。

### 本阶段完成

- 每个可见 Tool row 增加独立 open/closed marker 和 primary-button 点击区域；
- 点击只改变该 Effect，`Ctrl+O` 继续提供当前 Thread 的全部展开或全部收起；
- disclosure state 按 Thread ID 和 Effect ID 保存在当前 TUI process，切换 Thread 后可恢复；
- 每条 detail 在八行以内按内容自然收缩，只有超出八行才切换为 nested vertical scrollbox；
- `edit` 展开后以红色 `oldText` 和绿色 `newText` 显示 replacement diff；
- `read`、`write`、`bash` 和未知 Tool 都从 durable request Event 重建 bounded input detail；
- durable output、failure 和 live `bash` tail 与 request detail 在同一 disclosure 中分区显示；
- assistant committed/streaming Markdown 的 fenced JavaScript/TypeScript 使用 OpenTUI
  bundled Tree-sitter parser 和 Jixu-native syntax palette；
- HTML/HTM fence 显式复用 bundled TypeScript-React parser 做兼容高亮，不再静默成为
  unknown language；
- JSON/JSONC fence 显式复用 bundled JavaScript parser 做零依赖兼容高亮；
- Bash 0.25.1 和 Python 0.25.0 的 official Tree-sitter WASM/highlight query 固定在本地，
  `bash`/`sh`/`shell` 与 `python`/`py` 都解析为真实 language-aware code；
- stable Markdown 使用 OpenTUI top-level block renderer：heading、blockquote、thematic
  break、inline emphasis/code、compact table 和 fenced code 都不再暴露源码 delimiter；
- task list 在保留原生 list layout 和 nested content 的同时，以 `✓` / `○` 呈现状态；
- 每个 fenced code block 使用独立圆角 frame，十二行以内自然高度，超出后在十二行
  content viewport 内滚动，border title 标识 fence language；
- 未识别语言保留可读 code surface 和 raw-code fallback，不增加 parser/theme 依赖。

### 本阶段明确不做

- 不把展开状态写入 Event、State、Checkpoint、Replay 或 model context；
- 不把 replacement fragment 冒充 whole-file diff；
- 不改变 Tool input/output、Driver、Event schema version 5 或 Store；
- 不为 CSS/SCSS、SQL、YAML/TOML 等其他语言增加 parser asset；
- 不加入可配置主题市场、用户自定义 token color 或代码编辑能力。

## 2. 为什么这样设计

### 核心判断

Tool detail 的内容与打开状态必须分开：内容来自已经持久化的 request/outcome Events，因此
重开 Thread 后仍能重建；打开状态只是用户当下的视觉选择，同进程记忆即可，不能污染
durable Thread authority。代码高亮也属于同一 presentation boundary，只装饰已经存在的
assistant 文本，不改变文本或执行路径。

### 考虑过的替代方案

- **继续只有 `Ctrl+O`**：无法满足单条检查，且会一次展开大量输出，拒绝；
- **让 Tool category arrow 同时表示 disclosure**：会把 I/O 方向和展开状态混成一个语义，
  拒绝；
- **把展开状态写入 Thread Event**：会让纯 UI 偏好进入 Replay 和 durable history，拒绝；
- **渲染完整文件 diff**：`edit` Event 只有 old/new replacement fragment，没有修改前后完整
  文件证据，拒绝伪造；
- **详情直接撑高 transcript**：长输出会挤走对话和 Composer，拒绝；
- **引入第三方 syntax theme/parser package**：真实 probe 证明 bundled TypeScript-React
  parser 已能为 HTML 的 doctype、tag、attribute、string 和 operator 产生 token；当前阶段
  不需要新增发布依赖，但也不把它宣称为完整 HTML/CSS/script injection，拒绝扩大依赖。

### 主要 trade-off

详情 projection 最多保留 120 行或 12,000 字符，render viewport 最多八行；短详情不会为
未使用的行预留空间。代码 frame 最多显示十二行内容。这样能检查实际内容并保持 transcript
稳定，但它仍不是 raw Event viewer；需要完整 payload 时使用 `/events`。语法高亮目前对
OpenTUI bundled JavaScript、TypeScript 及其 aliases 最完整，HTML/HTM 使用明确的
TypeScript-React compatibility mapping，JSON/JSONC 使用 JavaScript compatibility mapping，
未知语言使用统一 raw fallback。Bash/Shell 和 Python 使用从 exact npm release 机械生成、随
package artifact 分发的本地 parser asset，启动后不访问网络。完整 Markdown 改用 top-level
block mode，换来可靠的结构
渲染和紧凑表格；尚未闭合的 streaming trailing block 在 parser 可确定结构前仍可暂时保持
literal，避免猜测不完整语法。

## 3. 架构与概念

### 概念关系

```text
durable tool.requested / terminal outcome
                  |
         project ToolOperation
         /                   \
typed request detail      bounded output preview
         \                   /
          per-Effect disclosure row
             /                  \
     <= 8 rows: box        > 8 rows: scrollbox

Thread ID -> Set<Effect ID>     fenced assistant Markdown
         presentation state               |
                                         MarkdownRenderable
                                               |
                         custom fenced-code renderer + Jixu SyntaxStyle
                                      /                 \
                           <= 12 rows: frame      > 12 rows: scrollbox

stable Markdown token -> top-level native semantic block
                      -> task marker patch (`✓` / `○`)
```

### 权威与数据边界

`ToolOperation.requestDetail` 是 Event projection，包含 bounded 展示数据；它不是第二份
Event history。`toolDisclosureByThread` 只存在于 `AgentWorkspace` React state。新进程默认
收起，但再次点击会从 Events 得到同样 detail。SyntaxStyle 只向 OpenTUI 注册颜色和字体
属性，assistant content、stream delta 顺序与 committed transcript identity 均不改变。

### 执行时序

`tool.requested` 进入 projection 时按 Tool 名生成 typed request detail。primary-button 点击
row 后，只切换当前 Thread 对应 Set 中的 Effect ID。row 展开时，request detail 与已有
terminal preview 进入 nested scrollbox；running `bash` 即使未手动展开也继续显示 transient
live tail。`Ctrl+O` 根据当前 Thread 全部 Effect 是否已展开，选择填满或清空 Set，并同步
large-group visibility。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/work-status.ts`：从 durable Tool request/outcome 生成 bounded detail；
- `packages/jixu/src/tui-model.ts`：typed `ToolRequestDetail` union；
- `packages/jixu/src/tui-workspace.tsx`：按 Thread 保存 disclosure state 和全局快捷键；
- `packages/jixu/src/tui-transcript.tsx`：clickable row、diff renderer 与 nested scrollbox；
- `packages/jixu/src/tui-markdown.ts`：code frame、height boundary、language normalization；
- `packages/jixu/src/tui-parsers.ts`：幂等注册本地 parser，并在 asset 不可用时保留 raw fallback；
- `packages/jixu/src/tui-parsers.generated.ts`：OpenTUI generator 生成的 parser descriptor；
- `packages/jixu/tree-sitter.parsers.json`：parser 版本、alias、WASM 与 query 的唯一来源；
- `scripts/copy-package-assets.mjs`：把 source asset 机械复制进 package `dist`；
- `packages/jixu/src/tui-syntax-theme.ts`：Jixu Markdown/code syntax palette；
- `packages/jixu/test/tui-smoke.tsx`：真实 mouse、scroll、Thread switch 和 code render smoke；
- `SPEC.md`：`0.4.17` disclosure contract 与 `0.4.21` semantic Markdown/parser contract。

### 关键算法或状态转换

`ToolRequestDetail` 是 closed union：普通输入使用带 label 的 text detail，`edit` 使用
`replacement-diff`。内容先归一化换行，再从 start 或 end 保留最多 120 行/12,000 字符并
加省略标记。UI 不解析格式化字符串来猜 Tool 类型。

Disclosure map 的 value 包含 `expandedEffectIds` 和 `showAllOperations`。row click immutable
clone 当前 Set；`Ctrl+O` 在“全部 Effect 已展开”和“展开全部”之间切换。Map 由
`AgentWorkspace` 持有，因此 `/new` 或 `/resume` 不会删除旧 Thread 的 presentation state。

Syntax palette 直接复用 `jixuTheme`：keyword/import 为 brand，function/module/property 为
info，string/character 为 success，number/type/constant 为 warning，comment 为 italic
secondary，raw block background 为 elevated。

Markdown 使用 OpenTUI `internalBlockMode="top-level"`，由 native renderer 分别构建 heading、
blockquote、rule、table、list 和 inline styled text。`renderNode` extension point 只替换 fenced
`code` token，并在 native task list 构建完成后把 task marker 从普通 bullet 修正为状态明确的
`✓` / `○`；nested list 和 inline child 仍由 native renderer 负责。短代码创建自然高度的
`BoxRenderable`，长代码创建固定十四行外框（十二行 content 加上下 border）的
`ScrollBoxRenderable`；两者都持有同一个 `CodeRenderable` 和语言 title。HTML/HTM 只在
filetype normalization 时映射到 `typescriptreact`，JSON/JSONC 映射到 `javascript`，assistant
原始文本保持不变。

`tree-sitter.parsers.json` 固定 `tree-sitter-bash@0.25.1` 与
`tree-sitter-python@0.25.0` 的 immutable npm URLs。OpenTUI maintained asset generator 下载
WASM 和 `highlights.scm` 并生成 runtime descriptor；CLI 在 renderer 初始化前完成一次全局
注册。asset resolution 失败会产生明确 warning，但不阻断 TUI，code block 继续使用 raw
fallback。package build 把 WASM、query 和各自 MIT license 一并复制到 `dist`，tarball 检查
会 fail closed 于任何缺失文件。

### Failure path

- request 字段缺失：显示明确的 unavailable fallback，不构造虚假内容；
- terminal output 为空：仍可展开 request detail；
- 未知 Tool：显示 bounded JSON arguments；
- 未知 fenced language：保留 raw code block，不丢文本；
- Bash/Python asset 缺失：CLI 发出 warning，Thread 仍以 raw-code fallback 渲染；
- incomplete trailing Markdown：在 parser 确认完整 block 前允许保持 literal；
- detail 超长：projection 有字符/行 bound，viewport 再以八行 bound 内滚；
- code block 超长：frame 保留十二行 content viewport，mouse wheel 只改变内部 scroll；
- 新进程：disclosure 默认收起，但 detail 从 Event 重建；
- Tool Signal 丢失：只影响 live tail，不影响 terminal receipt 或展开内容。

## 5. 使用的技术

- React immutable `Map<string, ToolDisclosureState>` 与 `Set<string>`；
- OpenTUI `MouseButton.LEFT`、`onMouseDown`、conditional `BoxRenderable` / `ScrollBoxRenderable`
  和 mouse wheel；
- TypeScript discriminated union 与 exhaustive rendering；
- OpenTUI `MarkdownRenderable.renderNode`、`CodeRenderable`、`SyntaxStyle`、bundled
  Tree-sitter 与 maintained asset generator；
- Jixu Nippon semantic color tokens，无外部 syntax-theme dependency。

## 6. 验证证据

### Tests

- targeted Thread projection：2/2 通过；
- targeted OpenTUI smoke：通过；
- `pnpm run check`：53/53 Node tests、OpenTUI smoke、typecheck 和 lint 全部通过。
- `pnpm run test:packages`：同一组真实 tarball 在 npm、pnpm、Yarn、Bun 与 Node 22.19.0
  隔离 consumer 中全部通过；`jixu` tarball 已验证包含两种 parser asset 与 license。

### Static checks

- `tsc -b tsconfig.build.json`：通过；
- `tsc --noEmit`：通过；
- `pnpm run lint`：通过，core architecture lint passed；
- `git diff --check`：通过。

### 关键断言

- 点击 `edit` 不会展开相邻 `bash`；
- `edit` 首屏显示 old fragment，mouse wheel 后可看到 new fragment；
- long `edit` 和 `bash` detail renderable height 都等于八行；
- short batch detail 的 renderable height 小于八行，没有空白占位；
- `/new` 后回到原 Thread，之前打开的 Effect detail 仍存在；
- `Ctrl+O` 展开所有 operation，large group 保持 source order；
- collapsed terminal receipt 不泄漏 durable output preview；
- streaming 与 committed JavaScript fence 都产生 `CodeRenderable` 和 bordered frame；
- HTML fence 的 filetype 为 `typescriptreact` 且产生实际 highlight ranges；
- short JavaScript frame 为四行内容加两行 border，long HTML frame 为十二行内容加两行
  border，nested pointer-wheel input 会推进 HTML frame 的 `scrollTop`；
- fence marker concealed，未知语言正文仍可见；
- JSON fence 的 filetype 为 `javascript`，所有 code frame 都显示 fence language title；
- `bash`、`sh`、`shell`、`python` 与 `py` 都产生非空 Tree-sitter highlight ranges；
- package tarball 同时包含两种 parser 的 WASM、query 与 MIT license；
- Markdown fixture 的 heading hash、quote marker、task checkbox、table pipe/delimiter row 和
  code fence 均不出现在 frame；quote rail、thematic rule、`✓` / `○`、aligned table 和 `BASH`
  code title 仍清晰可见；
- keyword/string/raw-block background 分别等于 Jixu brand/success/elevated token。

## 7. 遇到的问题与经验

第一版 detail renderer 把 durable preview 和 transient live tail 使用了同一显示条件，导致
terminal output 在 row 收起时仍然出现。smoke 立即捕获该问题，最终只有 transient tail 可
自动显示，durable preview 必须由 disclosure 打开。

长 replacement diff 的 `+ newText` 不在首个八行 viewport 中，这不是内容缺失，而是正确的
height boundary。测试改为真实 mouse wheel 滚动后验证 new fragment，同时断言 renderable
高度等于八行。

一次性展开多条长 detail 后，外层 transcript 会正确把旧 header 滚出当前 viewport。测试不再
错误地要求所有文本同时出现在 screen capture，而是检查 render tree 中所有 row/detail 的
存在性和 y 轴 source order。

OpenTUI code highlighting 会异步初始化 bundled Tree-sitter parser。streaming smoke 必须等待
parser publication 后再检查 frame；这不是额外 model request，也不改变 delta 或 committed
content。

真实对话截图还说明仅依赖 coalesced Markdown conceal 不足以形成可靠信息层级：稳定内容仍
可能短暂或持续暴露 source delimiter，table 也会占满整行。最终切换到 OpenTUI maintained
top-level block path，并只补它缺失的 task 状态，避免在 Jixu 内复制第二套 Markdown parser。

真实终端截图暴露了 `ScrollBoxRenderable + maxHeight` 的一个布局误区：它约束上限，但
ScrollBox 内部结构仍可能占满该上限，因此短 detail 看起来像被硬撑高。最终实现不再把所有
详情都交给 ScrollBox，而是按 logical row count 在普通 box 与固定八行 scrollbox 之间选择。
同一原则也用于 fenced code block，并把上下 border 的两行显式纳入 frame 总高度。

## 8. 已知限制与风险

- disclosure state 不跨 process 持久化，这是有意边界；
- detail 是 bounded projection，不替代 `/events` 的完整 payload；
- `edit` 显示 replacement fragment，不包含未经读取的周边文件 context；
- HTML/HTM 是 TypeScript-React compatibility highlight，能覆盖常见 markup token，但不是
  完整 CSS 和 `<script>` language injection；JSON/JSONC 同样不是专用 JSON grammar；其他
  未注册语言仍可能只有 raw style；Bash 和 Python 是完整的专用 grammar；
- 首次 language-aware render 可能短暂等待 Tree-sitter WASM 初始化；随后复用 process client；
- nested scrollbar 会占一列，极窄 terminal 中有效代码宽度相应减少。

## 9. 下一阶段入口

这一阶段已经闭合 Tool receipt 的 inspectability 和 transcript code readability。后续只有在
真实使用数据证明必要时，再考虑增加 CSS/SCSS、SQL、YAML/TOML parser、复制 code block、
或通过键盘在单条 disclosure 之间导航；这些都不应改变 Thread/Event authority。

## 10. 文件索引

- `SPEC.md`
- `packages/jixu/src/index.ts`
- `packages/jixu/src/tui-model.ts`
- `packages/jixu/src/work-status.ts`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/src/tui-markdown.ts`
- `packages/jixu/src/tui-parsers.ts`
- `packages/jixu/src/tui-parsers.generated.ts`
- `packages/jixu/src/tui-syntax-theme.ts`
- `packages/jixu/tree-sitter.parsers.json`
- `scripts/copy-package-assets.mjs`
- `packages/jixu/test/session.test.ts`
- `packages/jixu/test/tui-smoke.tsx`
