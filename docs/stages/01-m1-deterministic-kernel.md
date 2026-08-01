# 阶段 01：M1 Deterministic Kernel

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-18 |
| Milestone | M1 — Deterministic Kernel |
| 状态 | Completed |
| 关联目标 | `JX-GOAL-001`、`JX-GOAL-003`、`JX-GOAL-007`、`JX-GOAL-008` |
| 关联验收 | `JX-AC-001`、`JX-AC-012`，以及 `JX-AC-007` 的纯 Reducer 基础 |

## 1. 阶段目标与边界

### 要解决的问题

Jixu 的长期目标包括 pause、resume、recovery、fork 和 replay，但这些能力不能
分别长出一套执行逻辑。M1 的任务不是立即实现所有 continuity feature，而是先
证明存在一条足够小、确定、可测试的执行内核，后续能力都能在它上面生长。

这个阶段要回答四个问题：

1. Run 的事实来源究竟是什么？
2. 模型和 Tool 等外部调用如何不绕过持久化边界？
3. 相同 Event 序列能否得到相同 State 和 Effect？
4. 普通开发者能否通过 Agent、Runtime、Tool API 使用它，而不接触 Reducer？

### 本阶段完成

- 建立 TypeScript workspace 和 `core`、`testkit` package 边界；
- 定义 Agent、Runtime、Run、Event、State、Reducer、Effect、Driver、Tool、Store；
- 实现纯 Reducer；
- 实现 InMemory Event Store；
- 实现 model → Tool → model 的 Runtime 基础循环；
- 实现 deterministic Clock、ID 和 sequence Model Driver；
- 验证 basic loop、Tool schema failure、批量 Tool 请求顺序和并发写冲突。

### 本阶段明确不做

- JSONL 和 SQLite durability；
- crash recovery 和 pending Effect reconciliation；
- pause、resume、cancel；
- fork、replay、checkpoint；
- OpenAI、Anthropic、MCP 和 Agent Skills adapter；
- streaming Signal public API；
- CLI、发布 package 和完整 five-minute-start 示例。

这些内容属于 M2 到 M4。M1 如果提前实现，会把尚未验证的 continuity 语义混入
Kernel，导致核心概念变得难以审计。

## 2. 为什么这样设计

### 2.1 Event log 是唯一权威

最重要的判断是：Run 的 ordered durable Event log 是唯一事实来源。

Runtime 中的 `Map<runId, RunState>` 只是派生缓存；Model provider 的 conversation
ID、Tool 的内部状态、UI、trace 都不能决定 Run 当前处于什么状态。未来进程重启时，
只要读取 Event，Reducer 就应能重建 State。

如果同时让数据库中的 `runs.status`、provider thread 和 Event log 都有权决定状态，
恢复时必然出现“谁说了算”的冲突。Jixu 的差异化不是再提供一个调用 SDK，而是把
这个 authority boundary 设计清楚。

### 2.2 只有一条执行模型

所有外部工作统一通过：

```text
Event -> Reducer -> Effect -> Driver -> Event
```

- Event：已经接受的事实；
- Reducer：根据事实计算 State 和下一批 Effect；
- Effect：需要在纯函数外完成的工作请求；
- Driver：执行模型或 Tool 调用；
- outcome Event：把已知结果重新写回事实历史。

Tool 不能为了方便从 Reducer 里直接调用，Model adapter 也不能直接修改 State。
这让 replay 可以只 reduce Event，而完全不接触 live Driver。

### 2.3 Agent definition 与 Run execution 分离

Agent 是不可变配置，不是正在运行的实体。它包含：

- instructions；
- canonical `ModelRef`；
- Tool definitions。

Run 是 Agent 的一次执行实例。durable `run.created` Event 只保存可序列化的
`AgentSnapshot`，不会保存 Tool closure、SDK client 或 credential。

这样既保留普通 TypeScript Tool 的开箱即用体验，也不会把不可恢复对象写入 Event。
M2 做 recovery 时，应用需要重新注册 executable Tool，再与 snapshot 进行匹配。

### 2.4 Reducer 必须绝对纯

Reducer 不读时间、不生成随机 ID、不调用 Driver、不访问 Store。

Effect ID 直接由造成它的 Event ID 和 index 派生：

```text
<event-id>:effect:<index>
```

因此相同 State 和 Event 会得到结构完全相同的下一 State 和 Effect。稳定的 Effect ID
同时成为 stable idempotency key 的基础，为 M2 recovery 提供确定身份。

### 2.5 为什么外部调用前要先写 requested Event

Runtime 收到 Effect 后，不会立即执行。它先追加：

- `model.requested`；或
- `tool.requested`。

只有 Store append 成功，Driver 才能收到调用。这样即使进程在调用前后崩溃，Event
history 至少能够证明“这个外部意图是否已经持久化”。

它不能凭空提供 exactly-once，但能诚实地区分：

- 从未请求；
- 已持久化但尚未得到结果；
- 已知成功；
- 已知失败；
- outcome indeterminate。

### 2.6 为什么多个 Tool call 先全部记录再执行

模型可能一次返回多个 Tool call。Runtime 的处理顺序是：

1. 按模型返回顺序，为所有 Tool Effect 写入 `tool.requested`；
2. 所有请求提交成功后，通过 `Promise.all` 执行；
3. 不按网络完成顺序写结果，而按原 Effect 顺序提交 outcome Event。

这样既能并发执行，又不会让 Event history 和最终 State 受异步完成时序影响。

如果第一个 Tool 失败，Reducer 会记录 error，但只要还有 Tool outcome 未提交，Run
仍保持 `running`；等这一批结果全部落下后，才进入 `failed`。否则较慢 Tool 的结果
会因为 Run 已 terminal 而无法进入历史。

### 2.7 为什么使用 optimistic concurrency

Store append 必须携带 `expectedRevision`。Event 的 `sequence` 必须等于：

```text
expectedRevision + 1
```

两个 writer 同时基于 revision 0 写 sequence 1 时，只允许一个成功，另一个得到
`RevisionConflictError`。这避免 Event log 出现分叉或相同 sequence 的两个事实。

M1 的 InMemory Store 已实现这一合同；M2 的 JSONL 和 SQLite Store 必须复用同一组
contract tests，而不是重新解释并发语义。

## 3. 架构与概念关系

```text
Application
    |
    | defineAgent / defineTool / runtime.run
    v
Runtime ------------------------ transient State cache
    |
    +--> Store.append(Event) --- authoritative history
    |
    +--> Reducer(State, Event) - pure transition
             |
             +--> Effect[]
                    |
                    +--> Model Driver
                    +--> executable Tool
                              |
                              +--> outcome Event
```

依赖方向是向内的：

- `core` 不依赖 provider SDK、MCP SDK、数据库和 Web framework；
- testkit 依赖 canonical core types；
- 未来 adapter 只能实现 core port，core 不反向 import adapter。

## 4. 实现方式

### 4.1 Canonical data

`domain.ts` 定义 durable 和 derived domain data：

- `AgentSnapshot`；
- `ModelRef`；
- `ToolDescriptor`；
- `ModelMessage`；
- `ModelResponse`；
- `RunState`；
- `DriverError`。

`json.ts` 提供有限数值、无循环、plain object 的 JSON 边界验证。Agent schema 会被
clone 并 deep-freeze，防止调用方在 Agent 定义完成后修改 durable snapshot。

### 4.2 Tool schema

M1 没有引入 Zod 等 runtime dependency，而是定义极小的 `Schema<T>`：

```ts
interface Schema<T> {
  jsonSchema: JsonObject;
  parse(value: unknown): T;
}
```

Tool 必须同时提供 input/output schema 和 parser。Runtime 在 Tool Driver boundary：

1. 验证模型生成的 arguments；
2. 只有 input 合法才执行 Tool；
3. 执行后验证 output；
4. 只有合法 JSON output 才生成 `tool.completed`。

这不是要替代 Zod、Valibot 或 TypeBox。未来 facade 可以提供 adapter，把生态 schema
映射到这个最小 canonical contract。

### 4.3 Commit 过程

Runtime 提交 Event 时：

1. 使用 injected ID 和 Clock 构造 Event；
2. 校验 Event 为 JSON data；
3. 用 Reducer 做 transition preview，验证 revision 和 lifecycle；
4. 调用 Store 的 expected-revision append；
5. 只有 append 成功才更新 derived State cache。

preview 不会产生外部副作用。它只是确保非法 Event 不会先写入 Store。State cache
更新发生在 durable append 之后，因此内存状态不能领先于权威历史。

### 4.4 Outcome 分类

Driver outcome 是 discriminated union：

- `succeeded`；
- `failed`；
- `indeterminate`。

Tool 已开始执行后抛异常，会记录为 indeterminate，而不是假装它一定没有产生外部
动作。Model Driver 抛异常同样转换为 indeterminate。M1 不自动 retry；M2 会结合
Tool 的 idempotency declaration 和 durable pending Effect 决定 recovery policy。

### 4.5 InMemory Store

InMemory Store 实现：

- Run creation；
- expected-revision append；
- contiguous sequence；
- Store 范围内 Event ID 唯一；
- append 时 structured clone，避免调用方后续修改历史；
- read 时再次 clone，避免消费者修改 Store 内部数据；
- 从 Event replay 后列出 non-terminal Run。

## 5. 使用的技术

### TypeScript 6

启用严格边界：

- `strict`；
- `exactOptionalPropertyTypes`；
- `noUncheckedIndexedAccess`；
- `verbatimModuleSyntax`；
- `isolatedModules`；
- `erasableSyntaxOnly`；
- `rewriteRelativeImportExtensions`；
- `NodeNext` module resolution。

这些选项迫使 durable data、optional field 和 type-only import 更明确，并确保源码可以
使用 Node 24 的 native TypeScript type stripping 直接测试。

### Node.js 24

- native `.ts` test execution；
- built-in `node:test`；
- `structuredClone`；
- `AbortSignal`；
- `crypto.randomUUID` 作为默认 ID 来源。

### pnpm workspace

workspace 当前包含 root、`jixu-core` 和 `jixu-testkit`。core 没有 runtime
dependency。TypeScript 和 Node types 仅为 devDependency。

### Zero-dependency architecture lint

自定义 lint 脚本检查 core：

- 不允许 provider 或第三方 package import；
- relative import 必须显式使用 `.ts`；
- 不允许 TypeScript suppression；
- 不允许 unresolved TODO/FIXME；
- 不允许逃逸到不明确类型。

## 6. 验证证据

### Tests

阶段完成时共有 5 个测试，全部通过：

1. pure Reducer 对相同输入产生结构相同结果，且不修改输入 State；
2. basic model → Tool → model loop 的精确 Event 顺序；
3. 多 Tool call 在第一次 Tool dispatch 前已经全部写入 request Event；
4. 非法 Tool input 产生 durable `tool.failed`，Tool implementation 调用次数为 0；
5. 两个 writer 在相同 revision append，只有一个能成功。

basic loop 的 Event 序列被精确断言为：

```text
run.created
input.received
model.requested
model.completed
tool.requested
tool.completed
model.requested
model.completed
```

### Static checks

- `pnpm run typecheck`：通过；
- `pnpm run lint`：通过；
- `pnpm run test`：5/5 通过；
- `git diff --check`：通过。

## 7. 遇到的问题与经验

### 7.1 共享引用不等于循环引用

第一次运行多 Tool 测试时，JSON validator 把两个 Tool 共用同一个 schema object
误判成循环结构。

错误原因是 validator 使用全局 visited set：一个对象第二次出现时直接判定 cycle。
但下面这种 DAG 对 JSON 来说是合法的：

```text
tool A ----> shared schema
tool B ----> shared schema
```

真正非法的是当前递归路径回到自己。修复方式是把 set 当 recursion stack 使用：完成
一个分支后将对象移出。这个问题说明基础设施的“保守”不能等于拒绝正常复用；必须用
具体测试区分 alias 和 cycle。

### 7.2 并发执行与确定历史可以同时成立

不需要为了 deterministic Event order 串行执行所有 Tool。正确分层后：

- dispatch 可以并发；
- request commit 和 outcome commit 顺序可以确定；
- Reducer 只看确定的 Event 序列。

确定性属于 history 和 reduction，不等于整个物理世界必须串行。

### 7.3 类型只是一层，durable boundary 仍需 runtime validation

Model Driver 和 Tool 即使有 TypeScript 类型，真实 provider response 仍属于不可信输入。
因此写 Event 前仍进行 JSON 和 canonical response validation。未来 adapter 不能因为
SDK 提供类型就绕过这一层。

### 7.4 pnpm 首次运行的副作用

在空 workspace 中运行 `pnpm run test/lint` 时，pnpm 自动完成了首次 dependency
resolution，复用了本机缓存并生成 `node_modules` 和 `pnpm-lock.yaml`。这说明阶段
计划中的“运行 script”也可能隐含 workspace bootstrap。今后如果明确禁止安装，应先
用只读方式确认 dependency state，或使用已知 compiler binary，而不能假设 `run`
一定无写操作。

## 8. 已知限制与风险

1. InMemory Store 不能跨进程恢复；
2. Runtime 当前执行到 terminal 后才返回 RunHandle；
3. 没有恢复未完成 Effect 的 policy；
4. executable Tool registry 只存在于当前 Runtime；
5. 没有 pause、fork、replay、checkpoint；
6. Event decoder 目前主要覆盖 Runtime 自己构造的 typed Event，M2 读取磁盘数据时需要
   完整的 persisted Event runtime decoding 和版本兼容诊断；
7. Signal port 已定义，但 public streaming surface 尚未实现；
8. 还没有 provider、MCP 或 Skills compatibility 验证；
9. package 尚未发布，README 中的完整 API 仍是 v0.1 target。

## 9. 下一阶段入口

M2 是 Continuity，核心目标不是增加更多 noun，而是证明同一个 Run primitive 能够：

- 写入 JSONL/SQLite；
- 从 Event 恢复；
- 识别 requested-without-outcome Effect；
- pause/resume；
- replay without dispatch；
- fork with lineage；
- 使用 disposable checkpoint 加速恢复。

进入 M2 前必须先为 Store contract、persisted Event decoder 和 recovery boundary 制定
更细的 acceptance slice，不能一次性把全部 continuity feature 塞进一个修改。

## 10. 文件索引

```text
package.json                         workspace scripts and dev tooling
pnpm-workspace.yaml                  workspace membership
tsconfig.json                        strict TypeScript contract
scripts/lint.ts                      zero-dependency architecture lint
packages/core/src/agent.ts           Agent, Schema, Tool definitions
packages/core/src/domain.ts          canonical domain data
packages/core/src/effects.ts         Effect and Driver outcome contracts
packages/core/src/events.ts          durable Event vocabulary
packages/core/src/reducer.ts         pure Kernel transition
packages/core/src/runtime.ts         append/dispatch/outcome coordination
packages/core/src/store.ts           InMemory Event Store
packages/core/src/ports.ts           injected runtime ports
packages/core/src/json.ts            JSON boundary and immutable clone helpers
packages/testkit/src/index.ts         deterministic Clock, IDs, Model Driver
packages/core/test/*.test.ts          M1 acceptance and invariant tests
```
