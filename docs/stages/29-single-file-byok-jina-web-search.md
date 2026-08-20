# 阶段 29：单文件 BYOK 与 Jina Web Search

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | First-party network Tool |
| 状态 | Completed |
| 关联需求 | `JX-TOOL-010`、`JX-TUI-034`、`JX-SEC-008` |
| 关联验收 | `JX-AC-047`、`JX-AC-048` |

## 1. 阶段目标与边界

### 要解决的问题

Jixu 的模型连接与 Tool policy 已经能持久化，但 model Key 仍单独放在 `auth.json`，first-party
catalogue 也只有本地 Tool。对纯 BYOK 的本地应用，这会制造没有价值的 credential 概念分裂；
同时，Web Search 如果只返回搜索摘要，Agent 无法稳定形成可引用、有正文证据的答案。

### 本阶段完成

- Settings schema 升级为 v5，model Key、Jina Key、连接、Tool selection 与 permission policy
  统一保存在 `~/.jixu/settings.json`。
- schema v3/v4 与 legacy `auth.json` 原地合并，成功写入后删除 `auth.json`，不生成备份。
- 增加独立的 `@jixu/tools-jina` 包与 first-party `web_search` Tool。
- Jina Search 返回 title、URL、description 和 bounded page content；Agent instructions 要求将网页
  正文视为不可信证据而不是指令，并在答案中引用支持结论的 URL。
- Tool Center 显示 `web_search`、Jina configured/missing 状态、network risk 与 policy。
- 用户本机旧配置已完成同路径迁移，`web_search` 已启用。

### 本阶段明确不做

- 不增加另一套 auth store、登录流程、hosted proxy 或 Jixu 托管 Key。
- 不加入通用浏览器、页面交互、Reader Tool、crawl、deep research 或多 provider Search router。
- 不让编辑中的 settings 改写已选 Thread 的 immutable Agent；手动改 Key 后需重启 Jixu，再创建
  新 Thread。
- 不把网络 Tool policy 描述成 network sandbox。

## 2. 为什么这样设计

### 核心判断

BYOK 配置只有一个用户心智模型：本机 `settings.json`。model 和 Tool 的 Key 虽然用途不同，
但都不是 Thread authority，也都需要相同的原子写入和 `0600` 边界，没有理由维护第二个文件。

Web Search 的有效输出必须同时具备可追溯 URL 与正文证据。Jina Search 已提供搜索和网页正文，
first-party adapter 只负责输入约束、鉴权、响应边界、规范化与 typed failure，不再拼一套搜索
加抓取状态机。

### 考虑过的替代方案

- 保留 `auth.json`：继续让用户在两个文件间寻找 BYOK Key，且 Tool Key 最终仍需新位置。
- Key 通过环境变量注入：与“所有设置都在 settings”冲突，重启和迁移行为也更难解释。
- 只保存 Jina snippet：成本较低，但无法满足 Agent 对原始证据和可靠引用的需要。
- 每次执行从磁盘重读 Key：会让同一 Thread 的 Tool closure 可变，破坏 Agent snapshot 语义。
- 直接持久化完整上游响应：可能把超大网页、无关 metadata 或上游回显内容写进 Event。

### 主要 trade-off

首版固定使用 Jina Search 官方 endpoint，并把结果限制为最多 5 条、单条 12,000 字符、总正文
48,000 字符、响应 2 MB 和 30 秒。超长内容会明确标记 truncated；这是可恢复上下文、成本与
搜索完整度之间的保守边界。

## 3. 架构与概念

### 概念关系

```text
settings.json v5
  ├── connection.apiKey
  └── tools.webSearch.apiKey
          │
          v
createJinaWebSearchTool() -> immutable Agent.tools -> Harness -> Thread
```

Settings 决定下一个 Harness 的构造；Event log 仍是 Thread 的唯一 durable authority。

### 权威与数据边界

- Key 只存在于 user-only settings 与 Tool/Driver closure，不进入 Tool input/output、Event、Signal、
  receipt 或错误正文。
- `tool.requested` 先于网络 dispatch；规范化且有界的 Tool output 才进入 `tool.completed`。
- Tool Center 是 catalogue 与 settings 的投影，不注册第二份 executable Tool。
- Replay 只投影已有 Event，不调用 Jina。

### 执行时序

```text
model tool call
  -> tool.requested
  -> permission resolver
  -> POST s.jina.ai
  -> bounded JSON read
  -> normalized sources
  -> tool.completed
  -> next model response
```

## 4. 实现方式

### 关键模块

- `packages/tools-jina/src/index.ts`：typed schema、Jina request、响应边界、规范化与 failure mapping。
- `packages/jixu/src/config.ts`：Settings v5、v3/v4/auth migration、single-file atomic save。
- `packages/jixu/src/cli.tsx`：catalogue 组合、Jina Tool closure 与 enabled Tool selection。
- `packages/jixu/src/agent-instructions.ts`：Web Search 能力、引用要求与 prompt-injection 边界。
- `packages/jixu/src/tui-tool-center.tsx`、`work-status.ts`：配置披露、query receipt 与 source preview。
- `scripts/package-artifacts.mjs`、`verify-package-portability.mjs`：新包进入同一 release artifact path。

### 关键算法或状态转换

输入只接受 `query`、可选 `maxResults` 和 `site`。site 会规范化为 HTTP(S) origin；Key 会在
Tool closure 构造时去掉可选的 `Bearer ` 前缀。读取 response body 时逐 chunk 计数，超过
2 MB 立即 abort；随后按结果数、单条正文和总正文三层裁剪，并在 output 保留 truncation fact。

### Failure path

- 缺 Key：网络调用次数为 0，返回 settings 字段、重启和 next Thread 指引。
- 401/403：`jina_authentication_failed`；429：retryable `jina_rate_limited`；5xx：retryable
  `jina_upstream_unavailable`。
- timeout、用户 cancellation、network、oversize body、invalid JSON 和 invalid result URL 都有
  独立 typed failure，错误不包含 Key、header 或上游 body。
- migration 先 atomic replace `settings.json`，只有成功后才 unlink legacy `auth.json`。

## 5. 使用的技术

- TypeScript typed `Tool` / JSON schema、Web Fetch API、`AbortSignal.any()` 与 `AbortSignal.timeout()`。
- bounded stream reader、URL normalization、immutable Tool closure。
- atomic JSON write、schema-versioned migration、POSIX `0700` directory 与 `0600` file mode。
- Event-sourced Harness dispatch、Replay no-effect contract、OpenTUI catalogue projection。
- `node:test` deterministic fetch fixtures 与 clean package-manager consumers。

## 6. 验证证据

### Tests

- `pnpm run check:release`：74 个 Node tests、TUI smoke、typecheck 与 architecture lint 全部通过。
- Jina contract 覆盖缺 Key no-fetch、Bearer boundary、site/result count、三层 truncation、timeout、
  cancellation、malformed JSON、auth、rate limit 和 upstream failure。
- ordinary Harness test 记录 1 个 `tool.requested` 与 1 个 `tool.completed`；Replay 后 fetch 次数
  仍为 1。
- 同一组真实 tarball 在 npm、pnpm、Yarn、Bun 的 clean consumer 中通过 Node 22.19 类型检查和
  runtime smoke。
- 使用用户提供的 Key 走真实 first-party Tool probe，返回 2 个有效 HTTP(S) source，正文均在
  单结果上限内；验证输出未打印 Key 或正文。

### Static checks

- `pnpm run build:packages`、`tsc --noEmit`：通过。
- `pnpm run lint`：core architecture lint 通过。
- `git diff --check`：通过。

### 关键断言

- 本机迁移后 schema 为 v5，目录仅有 `settings.json`，权限为 `0600`，legacy `auth.json` 不存在。
- model Key 与 Jina Key 均存在于对应 settings 字段，`web_search` 已加入 enabled catalogue。
- fixture 和 live probe 都只输出 bounded、source-linked data；secret 不进入 durable path。

## 7. 遇到的问题与经验

第一次 live migration helper 在 Node 解析阶段因正则转义错误退出，发生在 fetch、配置 load 和
write 之前，因此没有网络或磁盘副作用。改为无正则的 prefix 和 URL protocol 检查后重新执行，
并只打印 boolean/count/mode 结果。这也说明 secret migration helper 应优先使用简单字符串逻辑，
避免把 shell、JavaScript 与 regex 三层转义叠在一起。

TUI smoke 最初按连续字符串匹配 API Key hint，但正常布局会在 label 与 hint 间补空格。测试改为
只约束语义文本而不冻结普通 spacing，符合 UI acceptance 边界。

## 8. 已知限制与风险

- 手动编辑 settings 不会热更新当前 Agent；必须重启 Jixu 后创建 Thread。
- Web Search 是公共网络 Tool，不提供登录态页面、JavaScript 交互或 network isolation。
- Jina 返回的网页内容可能包含 prompt injection；instructions 已要求只把它当证据，但模型侧
  仍需保持来源判断。
- 当前只有 Jina provider；如果以后出现第二个真实 Search provider，再抽象 provider registry。

## 9. 下一阶段入口

下一阶段可先观察真实 Thread 中的搜索质量、引用率、truncation 频率与失败分布，再决定是否需要
补充独立 `web_read`、domain allowlist 或 query refinement。没有这些证据前，不扩展为浏览器或
deep-research workflow。

## 10. 文件索引

- `SPEC.md`
- `README.md`
- `packages/tools-jina/`
- `packages/jixu/src/config.ts`
- `packages/jixu/src/cli.tsx`
- `packages/jixu/src/agent-instructions.ts`
- `packages/jixu/src/tui-tool-center.tsx`
- `packages/jixu/src/work-status.ts`
- `scripts/package-artifacts.mjs`
- `scripts/verify-package-portability.mjs`
