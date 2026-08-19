# 阶段 16：统一双协议 LLM Adapter

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | Provider adapter boundary |
| 状态 | Completed |
| 关联需求 | `JX-PROV-001`—`JX-PROV-006`、`JX-MET-001`—`JX-MET-003`、`JX-SIG-005`、`JX-SEC-001` |
| 关联验收 | `JX-AC-016`、`JX-AC-017`、`JX-AC-034`、`JX-AC-035` |

## 1. 阶段目标与边界

### 要解决的问题

此前 `@jixu/llm` 同时暴露 OpenAI Responses、Chat Completions、OpenAI 与 OpenRouter
专用 factory。配置以 `apiFormat` 选择 Responses 或 Chat，但 Jixu 真正需要的是一个可解释、可测试、
不会暗中 fallback 的统一 Model Driver 边界。维护者确认将范围收紧为两种支持 client-side Tool calling
的协议：OpenAI-compatible Chat Completions 与 Anthropic Messages，并明确删除 Responses，不保留兼容层。

同时，现有 OpenAI SDK 默认会自动重试两次，这些网络尝试不会经过
`Event -> Reducer -> Effect -> Driver -> Event`，因此不能进入 durable attempt 账本。本阶段必须让一次
Driver dispatch 只产生一次 provider request。

### 本阶段完成

- 将 `SPEC.md` 升至 0.4.2，新增 `JX-PROV-001`—`JX-PROV-006`，先锁定两协议、Tool、retry、
  accounting、Base URL 与 authentication 边界。
- 发布一个 `createLLMModelDriver({ api, ... })` factory；`api` 是闭合 union
  `openai-chat-completions | anthropic-messages`。
- 删除 Responses Driver、Responses client type、OpenAI/OpenRouter 专用 factory、Responses 配置值和相关测试。
- OpenAI Chat Completions 继续使用现有 OpenAI SDK，但显式设置 `maxRetries: 0`。
- Anthropic Messages 使用本地、单请求的 `fetch` + SSE decoder，不增加依赖；支持 text delta、
  `tool_use`、`input_json_delta`、`tool_result`、Plan、progress、usage、HTTP/stream error 与 cancellation。
- 配置升级到 schema v3，以 `connection.api` 替代 `apiFormat`；CLI 改为 `--api` / `JIXU_API`，
  TUI 只展示两种协议。
- 所有 workspace 与 published package 的 Node floor 升到 `>=22.19.0`，不承诺 Node 22.18.x。

### 本阶段明确不做

- 不引入 Pi、Anthropic SDK 或另一套 provider registry。
- 不支持 Responses、legacy Completions、Bedrock、Vertex、OAuth、MCP、server-side Tool 或协议 fallback。
- 不建立 model catalog，也不根据 model slug 猜测能力；普通请求始终发送 Tool descriptors，不支持 Tool
  calling 的 endpoint/model 必须返回 typed failure，不能静默降级。
- 不迁移 schema v1/v2 配置，不修改用户现有 `~/.jixu` 文件，也不改变 Event schema version 5。

## 2. 为什么这样设计

### 核心判断

统一 adapter 的价值不是把所有 provider 名称塞进枚举，而是把少数真实 wire protocol 归一到稳定的
`ModelDriver` contract。Chat Completions 与 Messages 已覆盖当前目标，同时保留 arbitrary custom endpoint；
删除 Responses 后，配置、错误和测试不再维护第三条隐性分支。

Provider SDK 的 retry 会让一次 durable Effect 产生多个不可审计 request。把 OpenAI SDK 的
`maxRetries` 设为 0，并让 Anthropic client 只执行一次 `fetch`，才能保证所有再次 dispatch 都来自 Jixu
已记录的 Effect attempt。

### 考虑过的替代方案

- 继续保留 Responses 作为兼容 alias：会留下维护者已经拒绝的第三种公开语义，因此删除。
- 引入 Pi 作为 adapter：可以扩大 provider surface，但会把 Jixu 的协议、retry、usage 和 Node 边界交给
  外部抽象；当前只有两个协议时，本地实现更小且更可审计。
- 引入 Anthropic SDK：能获得生成类型与 stream helper，但会新增依赖；Messages 所需 SSE 状态机足够小，
  原生 `fetch` 更直接，也天然没有 SDK retry。
- 对所有 Anthropic-style endpoint 同时发送 `x-api-key` 与 Bearer：扩大密钥暴露面。实现只对标准路径发送
  `x-api-key`，对识别出的 OpenRouter Messages endpoint 发送其要求的 Bearer header。

### 主要 trade-off

两协议边界清晰且 release path 更小，但特殊 gateway 若要求非标准 header，目前需后续显式配置能力；不能
假定所有 Anthropic-compatible endpoint 的认证方式相同。没有 model catalog 也意味着 Tool calling 能力以
真实 request 为准，而不是依赖可能过期的静态名单。

## 3. 架构与概念

### 概念关系

```text
Agent ModelRef
  -> durable model.generate Effect
  -> createLLMModelDriver(api)
       -> OpenAI Chat Completions
       -> Anthropic Messages
  -> normalized ModelOutcome
  -> durable model.completed / model.failed Event
```

协议 selector 只决定 wire mapping，不创建新的 provider 状态、Thread、retry engine 或 conversation authority。

### 权威与数据边界

- Event log 仍是 Thread 唯一权威；provider stream 只产生 transient Signals 和一个 terminal outcome。
- API Key 只在 Driver request header 中解析；不会进入 Event、Signal、Checkpoint、test output 或阶段文档。
- provider usage 只在 terminal accounting 中持久化。未报告字段保持 `null`；明确报告的 0 保持 0。
- OpenRouter host 是内建可信 provider cost 来源；其他 custom endpoint 必须显式声明可信或注入 versioned
  calculator，不能仅凭 `usage.cost` 字段名定价。

### 执行时序

Chat Completions 将 Jixu 的 system/user/assistant/tool history 映射到原生 message role，累积 text 与 function
argument delta，并在 usage-only terminal chunk 归一化 accounting。

Messages 将 immutable instructions 与动态 active Plan 分成 system blocks；历史 assistant Tool calls 映射为
`tool_use`，紧邻的连续 Tool outcomes 合并为一个 user message 的首部 `tool_result` blocks。stream 中先按 index
建立 content block，再累积 `input_json_delta`，到 `message_stop` 后统一解析 control 与普通 Tool calls。

## 4. 实现方式

### 关键模块

- `packages/llm/src/index.ts`：公开 types、双协议 Driver、native Anthropic SSE client 与统一 factory。
- `packages/llm/src/accounting.ts`：Chat 与 Messages capability-aware usage/cost mapping。
- `packages/jixu/src/config.ts`：schema v3、secret/settings 分离与 fail-closed parsing。
- `packages/jixu/src/cli.tsx`、`tui-setup.tsx`：两协议配置入口。
- `scripts/verify-package-portability.mjs`：Node 22.19.0 下的真实 tarball consumer acceptance。

### 关键算法或状态转换

Anthropic 的 `input_tokens` 不包含 prompt-cache read/write token。canonical `inputTokens` 确定性计算为
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，`totalTokens` 再加
`output_tokens`；缺失 cache 明细仍保持 `null`，不会把 unknown 伪装成 0。

两协议共享 control parsing 语义：有效 progress 只发 `model.progress` Signal；Plan 进入 proposal；普通 Tool
进入 `ModelResponse.toolCalls`。只有 progress 而无 public content、Plan 或普通 Tool 时，返回 non-retryable
`*_progress_only` failure。

### Failure path

- known HTTP status 返回 `failed`；408、409、429 和 5xx 标记 retryable，但 Driver 自身不重试。
- request 是否抵达 provider 无法确认时返回 `indeterminate`。
- aborted request 返回 typed、non-retryable `*_cancelled`。
- malformed known stream event、Tool JSON 或缺失 terminal event fail closed；stream 中途未知网络结果保留
  已报告 accounting。
- Anthropic `max_tokens`、`model_context_window_exceeded` 与 `pause_turn` 不伪装为完整成功。
- 所有 error message 在离开 Driver 前删除 API Key。

## 5. 使用的技术

- TypeScript 6 discriminated unions、readonly protocol types 与 exhaustive terminal mapping。
- OpenAI SDK 7.5.0 Chat Completions streaming，显式 `maxRetries: 0`。
- Node/Web `fetch`、`ReadableStream`、`TextDecoder` 与 SSE frame parsing。
- Anthropic Messages client Tool blocks、partial JSON streaming 与 cumulative usage。
- fixed-point USD nanodollars、versioned calculator 与 provider-reported cost provenance。
- Node test runner、OpenTUI smoke、真实 tarball portability consumers。

## 6. 验证证据

### Tests

- `pnpm run check`：48/48 headless tests 通过，OpenTUI smoke 通过。
- adapter contract 覆盖双协议 text/Tool/Plan/progress/usage、Anthropic Tool result 分组、native SSE、HTTP/stream
  failure、cancellation、credential redaction、progress-only durable failure 与闭合 public surface。
- 单次失败 probe 同时验证 OpenAI SDK 与 Anthropic client 各只有 1 次 fetch，没有内部 retry。
- config tests 验证 schema v3 secret separation、v1/v2 fail closed 与 Responses value 拒绝。

### Static checks

- `pnpm run build:packages`：通过。
- `tsc --noEmit`：通过。
- `pnpm run lint`：通过，输出 `core architecture lint passed`。
- `git diff --check`：通过。

### Package acceptance

- `pnpm run test:packages`：一个 authoritative tarball set 在 npm、pnpm、Yarn 与 Bun 的隔离 consumer 中完成
  install、TypeScript 与 runtime smoke；全部使用 Node 22.19.0，`JX-AC-017` 通过。

### 真实 provider 验收

只读现有 schema v2 配置与 auth，使用 OpenRouter custom endpoint 和
`deepseek/deepseek-v4-flash-0731`，没有输出或修改 API Key：

- `openai-chat-completions`：普通 Harness 产生 2 个 `model.requested`、2 个 `model.completed`、1 个
  `tool.requested` 与 1 个 `tool.completed`；最终包含 `TOOL_OK jixu-live`，Thread `idle`，无 model failure。
- `anthropic-messages`：同样完成 2 次 model 与 1 次 client Tool round trip，最终内容与 Thread 状态一致，
  无 model failure。两次 terminal usage 分别归一化为 993/89/1082 与 1065/10/1075
  input/output/total tokens；第二次明确报告 768 cached-input tokens。

这两次验收使用同一真实 custom endpoint 和同一 model，分别命中 `/chat/completions` 与 `/messages`，证明
不是 mocked contract、Responses fallback 或配置声明替代真实 wire behavior。

## 7. 遇到的问题与经验

真实资料核对发现 OpenRouter 的 Anthropic Messages endpoint 要求 Bearer auth，而标准 Anthropic API 使用
`x-api-key`。若只按协议名统一 header，真实 custom endpoint 会在进入 stream 前失败。实现因此把认证视为
endpoint capability，但不把 provider routing 引入 core。

Anthropic stream 的 `message_delta.usage.output_tokens` 是 cumulative，而 `message_start` 提供 input 与初始
output。实现采用字段覆盖而不是累加，避免重复计算 output。缓存 token 需要加入 total input 才能与官方计费
语义一致，同时仍单独保留 cache read/write 明细。

真实 Chat probe 最初检查 `tool.requested.payload.name` 得到 false；Event 实际将 name 放在
`payload.effect.input.name`。同一输出中的 Event count 与 `tool.completed` 已证明完整 Tool path，未为修正展示
字段而重复消费 provider 请求。

## 8. 已知限制与风险

- 用户当前 `~/.jixu` 仍是 schema v2；按已确认的 no-compat 决策，新 CLI 会 fail closed，需通过 `/config`
  重新保存为 schema v3。本阶段没有擅自修改该文件。
- Anthropic `maxOutputTokens` 默认 4096，可由 library caller 配置，但 reference TUI 尚未暴露该字段。
- 除标准 Anthropic 与识别出的 OpenRouter 外，要求自定义 auth/header 的 Messages gateway 尚无公开 headers
  配置。
- 不启用或持久化 Anthropic extended thinking；当前支持公开 text 与 client-side Tool calling。
- arbitrary model 没有静态 Tool capability catalog；不支持 Tool calling 时由真实 provider request typed failure。
- provider 不报告 cost 时仍为 `null`；不能从 token 数量猜测未经版本化的实时价格。

## 9. 下一阶段入口

维护者验收本阶段后，先按仓库规则 commit/push。若继续扩展 adapter，下一阶段应优先从真实需求选择
capability profile（例如 custom headers、显式 max output 或 thinking contract），而不是先增加 provider 名单。
任何新增协议都必须复用同一 `ModelDriver`、durable retry 和 accounting 边界。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `README.md`
- `packages/llm/src/index.ts`
- `packages/llm/src/accounting.ts`
- `packages/llm/test/adapter.test.ts`
- `packages/jixu/src/config.ts`
- `packages/jixu/src/cli.tsx`
- `packages/jixu/src/tui-setup.tsx`
- `packages/jixu/src/tui.tsx`
- `packages/jixu/test/config.test.ts`
- `packages/jixu/test/tui-smoke.tsx`
- `scripts/verify-package-portability.mjs`
- root and package `package.json` engine declarations
