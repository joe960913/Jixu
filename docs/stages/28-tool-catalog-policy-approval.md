# 阶段 28：Tool Catalog、权限策略与 durable approval

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | First-party Tool control plane |
| 状态 | Completed |
| 关联需求 | `JX-EFF-008`、`JX-TOOL-008`、`JX-TOOL-009`、`JX-TUI-033`、`JX-SEC-007` |
| 关联验收 | `JX-AC-047` |

## 1. 阶段目标与边界

### 要解决的问题

Jixu 已有 `read`、`write`、`edit`、`bash` 四个可执行 Tool，但应用只能一次性把固定数组交给
Agent。Settings 不知道哪些 Tool 被启用，也没有统一的来源、风险与权限投影；用户无法在
执行前选择 `allow`、`ask` 或 `deny`。如果直接在 TUI 增加开关，会让页面成为第二个 Tool
注册中心，并且内存弹窗无法在进程重启后继续。

另一个风险是把“权限规则”误称为 sandbox。`bash` 实际继承 Jixu 进程权限，文件 Tool 的
workspace 边界也只约束这三个 Tool；策略可以阻止 dispatch，但不能提供 OS、网络或进程隔离。

### 本阶段完成

- `Tool` 定义携带 immutable origin、risk 与 authorization action/resource projection，实际
  executable Tool 集合成为唯一 typed catalogue。
- 增加 pure ordered permission resolver：whole-value `*` / `?` 匹配、last match wins，多个
  resource 按 `deny > ask > allow` 聚合。
- Settings schema 升级为 v4，保存 enabled Tool names、file scope、维护的 profile 与 ordered
  rules；v3 原地迁移且不生成备份，保持原有四个 Tool、process file scope 和 unrestricted。
- `allow` 正常 dispatch，`deny` 在不调用 Driver 的情况下提交 typed `tool.failed`，`ask` 提交
  `approval.requested` 并让 Thread 进入 waiting。
- public `Thread.decideApproval()` 提交 `approval.decided`；allow-once 或 deny 只作用于对应
  pending Effect，并能从 Event replay / reopen 恢复。
- `/config` 增加 Tool Center；workspace 增加 Tool approval bar、`/approve` 与 `/deny`。
- Agent instructions 只声明当前真正启用的 Tool；footer 分别显示 enabled Tools、FILES scope
  与始终 unsandboxed 的 `BASH process`。

### 本阶段明确不做

- 不实现 OS/container sandbox、网络隔离、命令解析器或 shell capability inference。
- 不增加 MCP、extension、网络搜索 Tool 或 hosted policy service。
- 不提供“永久允许”审批；allow-once 不修改配置策略。
- 不让 settings 或 TUI 构造 Tool schema、execute 实现或第二份 registry。
- 不迁移 schema v1/v2，不改写已有 Thread Event log。

## 2. 为什么这样设计

### 核心判断

Tool catalogue 与用户策略必须分开。catalogue 回答“应用真实能执行什么”，settings 回答
“这个 Agent 启用什么、dispatch 前如何裁决”。如果 settings 自带 Tool schema 或 factory，
它会与 `defineTool()` 漂移，模型看到的 descriptor、权限 UI 和 Driver 可能不再对应同一实现。

`ask` 不是普通 UI modal，而是运行时事实。只有先提交 `tool.requested`，再提交
`approval.requested`，Thread 才能在进程退出后精确恢复同一个 Effect；决定也必须成为
`approval.decided`，TUI 不能绕过 Kernel 直接调用 Tool。

### 考虑过的替代方案

- 仅在 settings 中保存 `toolName: allow`：无法表达 path exceptions，也没有可解释的 rule order。
- 每个 Tool 自己弹确认框：Driver 获得了状态机职责，Replay 和非 TUI surface 无法复用。
- 将 approval 只放在 Checkpoint 或 React state：崩溃后丢失，并产生第二套 Thread authority。
- 把 bash command 本文作为 approval resource：虽然利于 command pattern，但会重复持久化可能
  含 credential 的 shell 内容；当前只投影稳定的 `process` boundary。
- 把 policy 称作 sandbox：会向用户承诺实现中不存在的安全隔离。

### 主要 trade-off

当前 first-party UI 只编辑 profile、enabled state、file scope 和 whole-Tool override；已有
resource-specific rules 会原样保留，但复杂 pattern 仍需编辑 `settings.json`。这是在不把
Tool Center 变成规则 IDE 的情况下提供稳定常用路径。

allow-once 决定提交后若进程在非幂等 Tool outcome 前退出，恢复仍采用原有保守语义进入
indeterminate waiting；系统不会用“用户点过允许”推断副作用一定没有发生。

## 3. 架构与概念

### 概念关系

```text
defineTool() ── descriptor + metadata + authorize(input)
      │
      ├── actual Agent.tools ── model Tool descriptors
      └── Tool Center view  ── enabled names + policy settings
```

Settings 是 selection/policy，不是 executable registration authority。

### 权威与数据边界

- Settings v4 是下一次 Harness 构造时 Tool selection 与 policy 的本地来源。
- Agent snapshot 仍记录 immutable descriptors，并保护旧 Thread 不被不兼容 Agent 打开。
- Event log 是 approval 和 pending Effect 的唯一 durable authority。
- TUI selected row、profile cursor 与 approval button focus 都是 transient UI state。
- permission rule 不等同于 filesystem 或 process sandbox。

### 执行时序

```text
tool.requested
      │
      v
authorize(parsed input) -> ordered policy resolver
      │
      ├── allow -> Driver -> tool.completed / tool.failed
      ├── deny  -> tool.failed(tool_permission_denied), no Driver call
      └── ask   -> approval.requested -> Thread waiting
                                      │
                                      v
                              approval.decided
                              ├── allow_once -> Driver -> outcome Event
                              └── deny       -> typed tool.failed
```

## 4. 实现方式

### 关键模块

- `packages/core/src/agent.ts`：Tool metadata 与 deterministic authorization projection。
- `packages/core/src/tool-permissions.ts`：immutable policy parser、wildcard matcher 与 pure resolver。
- `packages/core/src/effect-dispatcher.ts`：在 Driver 前检查 policy，并构造 deterministic denial。
- `packages/core/src/events.ts`、`domain.ts`、`codec.ts`、`reducer.ts`：approval Event、State、
  fail-closed decode 与 waiting projection。
- `packages/core/src/thread-execution.ts`、`thread.ts`、`harness.ts`：public decision API、durable
  dispatch/recovery 与 Fork payload identity remap。
- `packages/tools-node/src/index.ts`：四个 built-in catalogue entry、normalized file resource 与
  explicit `process` bash resource。
- `packages/jixu/src/config.ts`：Settings v4、v3 migration、profiles 与 effective policy。
- `packages/jixu/src/tui-tool-center.tsx`、`tui-tool-approval.tsx`：独立 Tool settings 和 approval
  surfaces，避免继续扩大 Setup / Workspace catch-all。
- `packages/jixu/src/agent-instructions.ts`、`cli.tsx`：从 enabled executable Tools 动态构造 Agent。

### 关键算法或状态转换

规则按声明顺序扫描。每个 resource 初始使用 `defaultEffect`，每次匹配覆盖当前 effect，因此
最后一个匹配规则决定该 resource；一次调用的多个 resource 再按 deny、ask、allow 优先级聚合。

`approval.requested` 只接受 matching pending `tool.execute`，并记录 effect ID、Tool call ID、
action 和 bounded resources。`approval.decided` 必须对应仍未决定的 approval。Tool terminal
Event 删除对应 approval；若还有 unresolved approval，Thread 保持 waiting，否则恢复 running。

### Failure path

- unknown enabled Tool、duplicate name、invalid file scope/profile/effect/rule shape fail closed。
- Tool input 无法 parse 时不伪造 permission 结论，仍走已有 typed Tool failure path。
- configured deny 产生 non-retryable `tool_permission_denied`，实现函数执行次数保持 0。
- restart 后 unresolved approval 仍 waiting；allow-once 后继续同一个 Effect identity。
- 多 Tool batch 可同时保留 allowed outcomes 与一个或多个 waiting approvals。
- Settings v3 migration 只替换 `settings.json`，不会创建 backup 或触碰 auth secret。

## 5. 使用的技术

- TypeScript exhaustive Event union、immutable object projection 与 public generic Tool types。
- pure whole-value wildcard matcher，无 regex injection 和外部依赖。
- Event-sourced waiting/decision lifecycle、现有 idempotency recovery contract。
- atomic JSON write、schema-versioned local settings 与 restrictive POSIX permissions。
- OpenTUI React keyboard/pointer focus model、80×24 compact acceptance path。
- `node:test`、Bun OpenTUI renderer、clean package-manager consumer smoke。

## 6. 验证证据

### Tests

- targeted core/config tests：28 个通过，覆盖 rule order、multi-resource precedence、deny no-call、
  durable allow-once、restart recovery、v3 migration 与 malformed settings。
- `pnpm --filter jixu test:tui`：通过，覆盖 80×24 Tool Center 与 approval bar render path。
- `pnpm run check:release`：68 个 Node tests、TUI smoke、typecheck、lint 全部通过。
- package portability：同一组真实 tarball 在 npm、pnpm、Yarn、Bun clean consumer 中全部通过。

### Static checks

- `pnpm run typecheck`：通过。
- `pnpm run lint`：core architecture lint 通过。
- `git diff --check`：通过。

### 关键断言

- allowed Tool 正常执行；configured deny 提交 `tool.failed` 且 implementation call count 为 0。
- asked Tool 在 `approval.requested` 后 implementation call count 为 0；allow-once 后恰好为 1。
- reopen 后 approval、pending Effect 和 waiting reason 完整恢复。
- Settings v3 迁移目录中只有替换后的 `settings.json`，没有 backup 文件。
- first-party file authorization resource 会 lexical normalize；bash 只暴露 `process` boundary。
- TUI Tool Center 显示四个 Tool、profile、file scope、effective policy 与 no-sandbox warning。
- Agent instructions 与 footer 都来自当前 enabled Tool settings，不再固定宣称四个 Tool/process file access。

## 7. 遇到的问题与经验

Settings 从 v3 升到 v4 后，旧 TUI smoke 的 connect fixture 仍断言只有四个 connection 字段；
类型检查和 frame assertion 很快暴露了真实 public config 已扩展，测试随后改为验证完整 Tool
settings，而不是在生产代码里做隐式 optional fallback。

Configuration header 加入 Connection / Tools 后，80-column frame 首次发生 chrome 互相挤压。
最终只在 wide terminal 显示完整 settings/auth 路径，compact header 保留产品名、两个 section
与 Back；表单和 Tool Center 仍保持普通布局流。

approval TUI 测试再次证明 OpenTUI React interaction 与验证 render 必须使用分离的 `act()`。
最终把 durable decision 放在 core runtime/recovery tests，TUI smoke 只验证该独立组件的稳定
用户可见 contract，避免用 renderer timing 重复证明 Kernel 行为。

最初 bash authorization resource 使用 raw command。安全复查后改为稳定的 `process`，避免
approval Event 为权限展示重复持久化潜在 secret；未来若要 command policy，必须先设计明确的
redaction 和 canonical command identity，而不是直接记录 shell 文本。

## 8. 已知限制与风险

- `bash` 仍是 unsandboxed process Tool；ALLOW 或 allow-once 不增加任何 OS isolation。
- file scope 只约束 first-party read/write/edit，不能约束 shell 自己读写 filesystem。
- Tool Center 暂不提供 resource-specific rule editor，但保存时不会删除现有规则。
- catalogue 目前只有四个 first-party Tool；extension/MCP origin type 已可表达，但没有加载机制。
- approval resources 是有界标识，不是 Tool input preview；具体参数继续由 durable Tool receipt 展示。

## 9. 下一阶段入口

网络搜索 Tool 可以作为新的真实 `defineTool()` entry 接入相同 catalogue/policy/approval 路径。
若要提高 shell 安全性，应单独设计可验证的 OS/container sandbox Driver，并保持 policy 与
isolation 两个概念分离；不能只增加更多 deny patterns 就宣称 sandbox 完成。

## 10. 文件索引

- `SPEC.md`
- `README.md`
- `packages/core/src/agent.ts`
- `packages/core/src/tool-permissions.ts`
- `packages/core/src/domain.ts`
- `packages/core/src/events.ts`
- `packages/core/src/codec.ts`
- `packages/core/src/reducer.ts`
- `packages/core/src/effect-dispatcher.ts`
- `packages/core/src/thread-execution.ts`
- `packages/core/src/thread.ts`
- `packages/core/src/harness.ts`
- `packages/core/test/tool-permissions.test.ts`
- `packages/core/test/runtime.test.ts`
- `packages/core/test/continuity.test.ts`
- `packages/tools-node/src/index.ts`
- `packages/tools-node/test/tools.test.ts`
- `packages/jixu/src/config.ts`
- `packages/jixu/src/agent-instructions.ts`
- `packages/jixu/src/cli.tsx`
- `packages/jixu/src/tui-tool-center.tsx`
- `packages/jixu/src/tui-tool-approval.tsx`
- `packages/jixu/src/thread-controller.ts`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/jixu/test/config.test.ts`
- `packages/jixu/test/tui-smoke.tsx`
