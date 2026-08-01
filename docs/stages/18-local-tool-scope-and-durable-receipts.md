# 阶段 18：统一本地 Tool 边界与持久化 receipts

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | M2.8 |
| 状态 | Completed |
| 关联需求 | `JX-EFF-007`、`JX-TOOL-006`、`JX-TOOL-007`、`JX-TUI-019`、`JX-SEC-004`、`JX-SEC-005` |
| 关联验收 | `JX-AC-036`、`JX-AC-039`、`JX-AC-040` |

## 1. 阶段目标与边界

### 要解决的问题

参考 TUI 原先同时暴露 workspace-bounded `read`、`write`、`edit` 与
process-permission `bash`。因此同一个用户明确指定的绝对路径可能通过
`bash` 创建成功，却在后续 `edit` 时被 workspace 边界拒绝。该拒绝还会被
统一包装为 `indeterminate / tool_driver_exception`，无法表达这是执行前已经
确定的策略失败。

Tool Event 虽然完整保存在 Thread 中，默认 transcript 却只渲染当前轮的临时
`toolOperations`。最终回复提交或下一次输入会清空这份投影，使用户失去回答
形成过程中的关键因果证据。

### 本阶段完成

- 为 `jixu-tools-node` 增加显式 `workspace | process` filesystem scope；
- 保持库级默认 `workspace` 不变，参考 TUI 显式选择与 unsandboxed shell
  一致的 `process` scope；
- 增加 `ToolExecutionError`，区分确定性 Tool 拒绝与未知执行异常；
- 将 Tool receipts 作为 discriminated transcript entry 从 durable Events
  重建，并保留到最终回复、后续输入与 Thread reopen；
- 更新 Agent contract、Composer 安全披露、README、规范与核心验收。

### 本阶段明确不做

- 不实现 shell 命令解析器或伪 sandbox；
- 不新增审批系统或隐式路径授权状态机；
- 不修改 Event schema、Store 数据或配置 schema；
- 不重做 Attention Rail、Composer 布局、图标与普通视觉细节。

## 2. 为什么这样设计

### 核心判断

只限制文件 Tool、同时保留 unsandboxed shell 并不能形成真实安全边界。参考
TUI 已经向 Agent 提供进程权限级 shell，因此应如实让同一应用中的本地文件
Tool 使用相同边界，避免能力选择决定任务能否成功。作为独立库使用时，
`createNodeTools({ root })` 仍必须维持 workspace 隔离；扩大权限只能通过显式
`filesystemScope: "process"` 发生。

Tool 调用与结果是 durable Event，不应由临时 UI 状态决定其历史可见性。
Composer footer 适合表达“现在正在做什么”，transcript receipt 适合保留“这条
回答是如何形成的”。两者来自同一 Event 权威，但承担不同时间尺度的表达。

### 考虑过的替代方案

- **解析 bash 并阻止越界写入**：shell 语法、子进程、重定向与脚本组合无法
  通过字符串检查可靠 sandbox，容易制造虚假安全保证。
- **从用户自然语言动态提取授权路径**：会引入脆弱解析和非 durable 权限
  状态，不适合作为 release path。
- **继续只显示右侧摘要**：`bash · completed` 无法保留具体命令、目标和因果
  顺序，不能替代 transcript receipt。

### 主要 trade-off

参考 TUI 的 process scope 权限较宽，但这并未扩大其既有 unsandboxed shell
的实际权限上限；现在只是让 capability contract 与 UI 披露变得一致。第三方
库调用的安全默认值不变。

## 3. 架构与概念

### 概念关系

```text
configured filesystem scope
  -> Node file Tool path resolution
  -> ToolExecutionError | external I/O
  -> tool.failed | tool.completed Event
  -> transcript Tool receipt + live Composer status
```

### 权威与数据边界

- ordered Event log 仍是唯一 Thread 权威；
- `toolOperations` 仅是当前工作的 transient presentation；
- `TranscriptToolReceiptEntry` 每次都由 `tool.requested` 与匹配 outcome Event
  重建，不新增 Store 或历史；
- `ToolExecutionError` 只跨 Driver 边界传递可持久化的安全错误字段，本身不
  进入 Event。

### 执行时序

1. Reducer durably 请求 `tool.execute`；
2. Driver 在 I/O 前验证输入与 configured filesystem scope；
3. 已知拒绝抛出 typed `ToolExecutionError` 并提交 `failed` outcome；
4. 未知异常保持 `indeterminate`，不猜测副作用状态；
5. TUI 以 Effect ID 将 request 与 outcome 合并成 receipt；
6. 最终模型回复追加在 receipt 之后，后续输入不清除历史 receipt。

## 4. 实现方式

### 关键模块

- `packages/core/src/errors.ts`：公开 typed Tool execution error；
- `packages/core/src/effect-dispatcher.ts`：保留 typed failure，未知异常保持
  indeterminate；
- `packages/tools-node/src/index.ts`：实现 filesystem scope、canonical scope
  检查与稳定 display path；
- `packages/jixu/src/thread-projection.ts`：从 Event 投影 causal receipt；
- `packages/jixu/src/tui-model.ts`、`tui-transcript.tsx`：使用 discriminated
  transcript entries 渲染消息与 Tool receipts；
- `packages/jixu/src/cli.tsx`、`agent-instructions.ts`、`tui-workspace.tsx`：
  统一参考应用的能力与披露。

### 关键算法或状态转换

`workspace` scope 对 lexical candidate 与 `realpath` 后的 canonical target
分别执行 containment 检查，阻止 `..` 与 symbolic-link escape。`process`
scope 保留相同 canonicalization 和稳定路径输出，但不施加 workspace
containment。相对路径始终从配置 root 解析。

投影遇到第一个连续 `tool.requested` 时创建一个 receipt group；后续 request
加入同组。`tool.completed` 或 `tool.failed` 通过 Effect ID 更新对应 operation。
新的用户输入只重置 live footer，不删除 receipt entry。

### Failure path

- `tool_path_outside_scope` 等 typed policy/precondition error → `failed`；
- 未知 Tool exception → `indeterminate / tool_driver_exception`；
- `/clear` → 清空可见 transcript projection，但不删除 durable Events；
- macOS `/var` → `/private/var` canonicalization 只参与安全判断，Tool output
  保留用户输入路径，避免 `write` 与 `edit` 回显不一致。

## 5. 使用的技术

- TypeScript discriminated unions 与 exhaustive narrowing；
- Node.js `realpath`、`relative`、`lstat` 与 filesystem primitives；
- immutable Event projection 与 Effect ID correlation；
- OpenTUI React normal-flow transcript rendering；
- Node test runner 与 OpenTUI in-memory renderer。

## 6. 验证证据

### Tests

- targeted：14/14；
- complete Node suite：50/50；
- OpenTUI smoke：通过；
- package portability：同一 authoritative tarball set 在 npm、pnpm、Yarn、
  Bun 隔离 consumer 中全部通过。

### Static checks

- `pnpm run build:packages`：通过；
- `tsc --noEmit`：通过；
- `pnpm run lint`：通过；
- `git diff --check`：通过；
- `pnpm run check:release`：通过。

### 关键断言

- 默认 scope 拒绝 lexical 与 symlink escape，并保留
  `tool_path_outside_scope`；
- process scope 对 root 外绝对路径完成 `write → edit → read`；
- typed rejection 为 `failed`，普通异常仍为 `indeterminate`；
- `cat > /tmp/hello.html` receipt 在最终回复及下一条输入后仍出现在真实
  OpenTUI frame；
- controller reopen 后 receipt 仍从 Events 恢复，`/clear` 后可见 transcript
  为空。

## 7. 遇到的问题与经验

macOS 的临时目录路径可能以 `/var` 输入、以 `/private/var` canonicalize。
如果把 canonical path 同时当成用户展示路径，不同 Tool 会回显不同字符串。
安全 identity 与 presentation identity 应分开：前者使用 realpath，后者稳定
保留 lexical input。

## 8. 已知限制与风险

- process scope 等同 Jixu 进程文件权限，不是 sandbox；TUI 必须持续明确披露；
- reference Agent contract 已从 v1 升到 v2；由于 Agent snapshot immutable，
  旧开发 Thread 不会伪装兼容，升级后需创建新 Thread 重试；
- receipt 当前默认展示最近四项，更多项目以 bounded summary 表达；完整原始
  history 仍通过 `/events` 查看；
- Jixu 尚无逐路径 durable approval 模型；未来若引入，必须走现有
  Event → Reducer → Effect → Driver 路径，不能成为第二权限状态机。

## 9. 下一阶段入口

若继续提升本地执行安全，应先设计跨平台、可验证的 approval/sandbox
capability，而不是解析 shell 字符串。UI 下一步可为历史 receipt 增加键盘可
操作的展开详情，但不应改变本阶段的 durable projection。

## 10. 文件索引

- `SPEC.md`
- `README.md`
- `packages/core/src/errors.ts`
- `packages/core/src/effect-dispatcher.ts`
- `packages/tools-node/src/index.ts`
- `packages/jixu/src/cli.tsx`
- `packages/jixu/src/agent-instructions.ts`
- `packages/jixu/src/tui-model.ts`
- `packages/jixu/src/thread-projection.ts`
- `packages/jixu/src/thread-controller.ts`
- `packages/jixu/src/tui-transcript.tsx`
- `packages/jixu/src/tui-workspace.tsx`
- `packages/core/test/runtime.test.ts`
- `packages/tools-node/test/tools.test.ts`
- `packages/jixu/test/session.test.ts`
- `packages/jixu/test/tui-smoke.tsx`
