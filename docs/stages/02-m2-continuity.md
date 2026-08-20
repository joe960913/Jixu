# 阶段 02：M2 Continuity

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-18 |
| Milestone | M2 — Continuity |
| 状态 | Completed locally, awaiting maintainer acceptance |
| 关联目标 | `JX-GOAL-002`、`JX-GOAL-004`、`JX-GOAL-005`、`JX-GOAL-007`、`JX-GOAL-008` |
| 关联需求 | `JX-RUN-001`～`JX-RUN-007`、`JX-EFF-008`～`JX-EFF-009`、`JX-CONT-001`～`JX-CONT-005`、`JX-FORK-001`～`JX-FORK-008`、`JX-REPLAY-001`～`JX-REPLAY-006`、`JX-STORE-001`～`JX-STORE-011` |
| 关联验收 | `JX-AC-003`～`JX-AC-008`、`JX-AC-012` |

## 1. 阶段目标与边界

### 要解决的问题

M1 证明了 `Event -> Reducer -> Effect -> Driver -> Event` 可以形成一个小而
确定的执行内核，但它只覆盖单进程、一次性跑完的 happy path。M2 要证明这条模型
真的能承载“continue”这个产品承诺，而不是只在命名上支持 continuity。

核心问题是：进程可能停在任何边界。尤其是外部 Tool 已经产生动作，但对应 outcome
Event 还没写入时，Runtime 不能假装 Tool 没执行，也不能无条件再执行一次。

M2 必须回答：

1. 重启后，Runtime 如何仅凭 Event history 找回下一步？
2. 已产生但尚未 durable-request 的 Effect 与已请求但 outcome 未知的 Effect 如何区分？
3. pause 在 Driver 正在工作时如何生效，又如何不丢 outcome？
4. Fork 如何复制历史语义而不共享父 Run 的身份或可变状态？
5. Replay 和 Checkpoint 如何保持 Event log 的唯一权威？
6. 三种 Store 如何证明遵守同一套语义，而不是各自实现一个 Runtime？

### 本阶段完成

- 将 `runtime.run()` 改为 durable acceptance 后返回，通过 `run.wait()` 等待安静点；
- 增加 `readyEffects` / `pendingEffects` 的明确区分；
- 增加 `runtime.recover(agent, runId)` 和 Agent snapshot 匹配；
- 对 pending model 和 idempotent Tool 使用稳定身份重试；
- 对 outcome 未知的非幂等 Tool 进入 durable `waiting`，不自动重放；
- 实现 durable pause/resume；
- 实现复制 Event prefix、重绑身份、原子创建的 Fork；
- 实现完全只读、零 Driver 调用的 Replay；
- 实现带版本、Event 位置、State digest 和结构校验的 Checkpoint；
- 实现 InMemory、JSONL、SQLite 三种 Store 的共享 contract suite；
- 加入 persisted Event / Checkpoint runtime decoder，未知 schema/type fail closed。

### 本阶段明确不做

- OpenAI、Anthropic Provider adapter；
- MCP Tool adapter；
- Agent Skills loader；
- approval、timer、cancel、stream public API；
- waiting Run 的人工 reconciliation API；
- distributed lease、active-active Run execution；
- package 发布、CLI 和五分钟示例。

这些属于 M3/M4。M2 只建立生态 adapter 可以依赖的稳定 continuity 语义。

## 2. 为什么这样设计

### 2.1 核心判断：恢复问题不是“把函数重新跑一遍”

常见 agent loop 把下一步藏在 while loop、Promise、provider thread 或 closure 中。
进程一停，这些信息就消失了。Jixu 的恢复必须从 durable Event projection 中重新发现
工作，因此下一步 Effect 也必须是 State 的确定性组成部分。

这使恢复不依赖“程序上次执行到第几行”，只依赖已经接受的事实。

### 2.2 为什么必须区分 ready 与 pending

M1 的 Reducer 返回 Effect，但 State 不保存它。如果进程在 outcome Event 已提交、下一条
request Event 尚未提交时停止，恢复只能看到 outcome，找不到 Reducer 当时返回的
Effect。这个窗口会让 Run 永久卡住。

M2 将派生状态明确分成：

- `readyEffects`：由最后一个已提交 Event 确定产生，但尚无 matching request Event；
- `pendingEffects`：已有 durable request Event，但没有已知 outcome Event。

它们不是第二个队列。两者都由 Event replay 得出：

```text
outcome/input Event
    -> ready Effect
    -> requested Event
    -> pending Effect
    -> outcome Event
    -> removed / next ready Effect
```

这样 crash 在任意箭头处，重放都能得到诚实且唯一的状态。

### 2.3 为什么非幂等 pending Tool 不能自动 retry

request Event 只能证明 Jixu 曾经要求外部系统执行，不能证明外部动作是否发生。若进程在
“外部动作成功”和“outcome Event 提交”之间停止，重复调用可能重复扣款、发消息或改数据。

因此恢复 policy 是：

| pending Effect | 恢复行为 |
| --- | --- |
| `model.generate` | 使用相同 logical identity 重试，`attempt + 1` |
| idempotent `tool.execute` | 使用相同 Effect ID / idempotency key 重试 |
| non-idempotent / unknown `tool.execute` | 不调用 Tool，追加 `run.waiting` / `effect_outcome_unknown` |

Jixu 提供 durable intent 和稳定 idempotency identity，不声称普适 exactly-once。真正的
单次外部动作仍要求 Tool/外部系统合作处理 idempotency key。

### 2.4 为什么 pause 是 durable intent + boundary

直接停止 Promise 会丢失已经完成的外部结果，也无法在重启后知道暂停是用户意图还是
进程事故。M2 使用两个事实：

1. `run.pause_requested` 记录控制意图；
2. `run.paused` 记录 Runtime 已到达不再派发新 Effect 的边界。

如果 Driver 已经开始，本批 request 对应的已知 outcomes 仍按确定顺序提交；这些
outcomes 新产生的 Effects 保留在 `readyEffects`，直到 `run.resumed` 提交后才请求。

### 2.5 为什么 Fork 复制 prefix 并重绑身份

Fork 不是“复制当前聊天数组”，也不是把父 Run 的 State snapshot 当权威。它必须保留
选定 Event N 的完整因果历史，同时成为独立 Run。

M2 的语义是：

1. 读取父 Run 到 Event N 的 prefix；
2. 为 child 分配新 Run ID；
3. 为每个 copied Event 分配新 Event ID；
4. 重绑 causation、Effect ID、idempotency key 和 Effect run identity；
5. 追加 `run.forked` 和 child input；
6. 用 Store 的 `createFork` 一次性发布完整 child history。

child prefix reduce 后，除身份外必须与父 Run 在 N 的 State 等价；child 后续 append
永远不能改变 parent。

选择完整复制而非共享 prefix，是 v0.1 对可审计性和 Store 简单性的取舍。未来 Store
可以内部去重，但 observable semantics 不变。

### 2.6 为什么 Checkpoint 只能是可丢弃缓存

Checkpoint 保存：

- Run ID；
- exact Event ID / sequence；
- Event schema version；
- Reducer version；
- derived State；
- canonical State 的 deterministic digest。

恢复会检查版本、位置、State revision/run identity、完整 State 结构和 digest。任何读取
异常、缺失、版本不兼容、结构错误或 digest 不一致都会退回 full replay。

digest 使用 FNV-1a 32-bit，只用于发现意外损坏，不是安全签名，也不能抵御恶意篡改。
Event log 仍是唯一权威。

### 2.7 为什么 Store 共享合同而不是各写各的测试

Store 是可替换 adapter。如果 JSONL 和 SQLite 对 revision、Fork 原子性或 Event ID
唯一性的解释不同，上层 Runtime 就不再有稳定语义。

`jixu-testkit/store-contract` 对每个 Store 运行同一组合同：

- create / duplicate create；
- immutable read；
- stale revision concurrency rejection；
- atomic Fork；
- Checkpoint round-trip；
- Store 范围 Event ID 唯一；
- non-terminal listing。

adapter 可以使用不同物理技术，但不能重新定义这些行为。

## 3. 架构与概念

### 3.1 概念关系

```text
durable Event log (only authority)
            |
            v
     pure Reducer / replay
            |
            v
  derived RunState
    |             |
readyEffects   pendingEffects
    |             |
request Event     +-- recovery policy
    |                  |-- retry same identity
    v                  `-- waiting, no dispatch
pendingEffects
    |
Driver -> outcome Event
```

Checkpoint 位于 Event log 到 State 的加速路径上；它不能绕过 Event identity、schema
version、Reducer version 或 State validation。

### 3.2 依赖方向

```text
jixu-store-jsonl ----+
                      +--> jixu-core ports/types
jixu-store-sqlite ---+

jixu-testkit --------> jixu-core
jixu-core -----------> only local core modules
```

SQLite 和 filesystem API 不进入 core。Runtime 不知道 Store 的物理格式。

### 3.3 执行与恢复时序

正常调用：

```text
input.received
  -> ready model Effect
  -> model.requested (durable)
  -> Model Driver
  -> model.completed
  -> ready Tool Effect(s)
  -> all tool.requested Events (durable)
  -> Tool Drivers in parallel
  -> outcomes committed in Effect order
```

恢复：

```text
Store.read Events
  -> read and validate optional Checkpoint
  -> reduce remaining Events or full history
  -> compare supplied Agent with durable AgentSnapshot
  -> inspect ready/pending Effects
  -> dispatch only policy-safe work
  -> checkpoint at terminal / paused / waiting quiescence
```

## 4. 实现方式

### 4.1 Runtime coordinator

`Runtime` 现在维护每个 live Run 的：

- derived State cache；
- executable Agent registration；
- serialized commit tail；
- active execution Promise；
- durable pause intent coordination。

这些都不是权威。`recover()` 和 `resume()` 会从 Store history 重建。每个 Run 的 commit
通过 Promise tail 串行，确保同一进程中的 pause、outcome 和 control Event 不竞争相同
revision。

`runtime.run()` 只等待 `run.created` 和初始 `input.received` durable commit，然后调度
后台执行。调用者用 `run.wait()` 观察 terminal、paused、waiting 或基础设施错误。

### 4.2 Reducer 状态转换

Reducer 增加：

- `readyEffects`；
- `pauseRequested`；
- `lineage`；
- `waitingReason`；
- lifecycle transitions；
- logical Effect retry validation。

retry request 必须保留 Effect type、ID、idempotency key、requested-by identity 和 input，
且 `attempt` 严格加一。任何变化都被视为非法 transition。

### 4.3 Runtime decoders

`codec.ts` 在 durable boundary 校验：

- Event envelope、schema version、Event type；
- AgentSnapshot、Tool descriptors、messages；
- Effect type、attempt、run identity、input；
- known outcome payload；
- Checkpoint envelope 和完整 RunState 结构。

TypeScript 类型不能替代 persisted JSON 的 runtime validation。未知 Event 不会被忽略，
也不会被“尽量解释”。

### 4.4 JSONL Store

物理结构：

```text
<directory>/
  runs/<encoded-run-id>.jsonl
  checkpoints/<encoded-run-id>.json
```

实现选择：

- 初始化时扫描所有 Run，验证 Event 并建立 Store 范围 Event ID 集合；
- 同一个 adapter instance 的所有写操作显式串行；
- append 先读取和验证 revision，再写完整临时文件并 atomic rename；
- create 使用临时文件 + hard link，避免覆盖已有 Run；
- Fork 在完整 validation/replay 通过后一次性创建目标文件；
- Checkpoint 使用独立 atomic replace。

这是偏 inspectability 的本地 Store，不是高吞吐数据库。每次 append 重写整个 Run file，
且 v0.1 只保证一个 active local Runtime process。

### 4.5 SQLite Store

SQLite adapter 使用 Node 24 built-in `node:sqlite` `DatabaseSync`，没有新增 runtime
dependency。表包括：

- `runs`；
- `events`，以 `(run_id, sequence)` 为主键、`event_id` 全局 unique；
- `checkpoints`。

启用 WAL、foreign keys 和 STRICT tables。append、Fork、Checkpoint 都在
`BEGIN IMMEDIATE` transaction 中完成，失败时 rollback。同步数据库 API 被完全隔离在
adapter 内，不进入 Runtime 或 Kernel。

### 4.6 Fork identity rebinding

Fork 先建立 old Event ID → new Event ID map，再映射 Effect identity。标准 Effect ID
仍遵循：

```text
<new-requested-by-event-id>:effect:<index>
```

outcome、waiting 和 causation references 统一指向 child identity。Store 在 child 可见前
对完整 history 执行 decode 和 replay，所以 invalid prefix 不会留下 partial Run。

## 5. 使用的技术

### TypeScript 6 / Node.js 24

- strict discriminated unions；
- native TypeScript execution；
- `node:test`；
- `structuredClone`；
- `AbortSignal`；
- `fs/promises`；
- built-in `node:sqlite`；
- private class fields 和 Promise-based serialization。

### Context7 + Node 官方资料

实现前通过 Context7 核对 Node 24 官方 API：

- `node:sqlite` 的 `DatabaseSync`、`exec`、`prepare` 和 Statement API；
- `fs/promises` 操作不会自动为并发修改提供同步；
- `rename` 的目标替换语义；
- file open/create flags。

这直接影响了 JSONL adapter 的显式 write serialization 和临时文件替换设计。

### Zero new external runtime dependency

M2 新增 workspace packages，但没有引入第三方 runtime library。`pnpm-lock.yaml` 只增加
workspace link importers。这样 core/Store 语义可以先稳定，再决定未来是否用稳定的
SQLite dependency 替换 experimental built-in API。

## 6. 验证证据

### Tests

阶段完成时完整 suite 为 26/26 通过，覆盖：

- 3 个 M1 basic Runtime loop / Tool boundary tests；
- 1 个 pure Reducer determinism test；
- 1 个 unknown Event schema/type fail-closed test；
- 7 个 M2 continuity acceptance tests；
- 12 个三 Store 共享 contract tests；
- 2 个 JSONL / SQLite adapter reconstruction tests。

M2 的关键断言：

1. 非幂等 Tool 外部动作已发生、outcome append 前停止：恢复后 Tool 额外调用 0 次；
2. outcome 已提交、下个 request 未提交：恢复能重新发现 ready Effect；
3. 幂等 Tool 同一个 logical Effect 调用 2 次，但 cooperative action 只有 1 次；
4. retry 保持 Effect ID / idempotency key，attempt 从 1 变为 2；
5. active Driver outcome 在 pause 时仍提交，新 ready Tool 在 resume 前调用 0 次；
6. Fork prefix State 与 parent at N 等价，parent history 在 child 完成后不变；
7. Replay 结果与 live State 相等，Driver 调用和 Event 数量不增加；
8. valid、missing、throwing、wrong-version、wrong-digest、invalid-shape Checkpoint
   恢复结果一致；
9. mismatched AgentSnapshot 在恢复时被拒绝；
10. 同一基础设施错误被后续 `run.wait()` 稳定观察到；
11. 三种 Store 都拒绝 stale revision 和全局重复 Event ID；
12. invalid Fork 不会留下可见的 partial child Run。

### Static checks

- `pnpm run typecheck`：通过；
- `pnpm run lint`：通过，core architecture lint passed；
- `pnpm run test`：26/26 通过；
- `pnpm run check`：通过；
- `git diff --check`：通过；
- private file 检查：`SPEC.md`、`AGENTS.md`、`docs/` 均未 tracked，且被
  `.git/info/exclude` 命中。

### 观察到的 runtime warning

SQLite tests 全部通过，但 Node 24 明确输出：

```text
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

这不是测试失败，但属于公开的兼容性 caveat，README 已明确说明。

## 7. 遇到的问题与经验

### 7.1 Effect 只作为函数返回值不够 durable

最初的 M1 设计只在 Reducer return value 中暴露 Effect。failure injection 暴露出
outcome commit 与 request commit 之间的丢失窗口。将 ready Effect 放入 derived State
不是增加第二权威，而是让同一个 Event projection 能完整描述“接下来该请求什么”。

### 7.2 强化 Fork 测试发现真实 identity bug

最初 Fork 给 copied Effect 分配独立的新 ID，但 copied prefix 的 State projection 不再
满足 Reducer 的标准 Effect ID 公式。表面上 child 仍能运行，语义等价测试却失败。

修复不是放宽测试，而是让 copied Effect ID 从映射后的 causation Event ID 按原公式派生。
这个问题证明 Fork 测试必须比较 Event N 的 State projection，不能只验证 child 最终成功。

### 7.3 async `run()` 改变了 M1 调用时序

为了让调用者能 pause live Run，`runtime.run()` 不能等整个 Run 完成才返回。M1 tests
最初因此在后台执行完成前读取 State。正确兼容方式是明确新增 `await run.wait()`，并在
SPEC 和 README 中记录 pre-release migration，而不是悄悄保留同步完成假象。

### 7.4 Checkpoint 的“可丢弃”必须在自定义 Store 路径上也成立

Store adapter 会 decode Checkpoint，但 Runtime port 允许应用提供自定义 Store。若 Runtime
只信任 TypeScript 类型，自定义 Store 可以返回结构错误却 digest 自洽的数据。

因此 Runtime 再做一次 decoder validation；错误会退回 Event replay。类型只约束编译期，
durable boundary 必须校验真实值。

### 7.5 resume 不应信任同进程 State cache

最初 `resume()` 直接使用 paused State cache。虽然正常测试结果正确，但它没有兑现
`JX-RUN-004` 的持久化重建语义。最终改为先读取 Events、验证 Checkpoint 并恢复 State，
再追加 `run.resumed`。

### 7.6 execution Promise 既是同步点也是错误证据

清理 active execution 时，若把 settled Promise 一并删除，晚到的 `wait()` 会失去已经
发生的基础设施错误。最终只清除 active 标记，保留最后一次 execution Promise，直到
下一次调度覆盖它。这样 pause/resume 没有 active race，错误也可重复观察。

### 7.7 文件 API 不提供业务级并发语义

`fs/promises` 的每个调用是异步操作，但多个写操作之间不会自动形成 revision transaction。
JSONL adapter 必须显式串行化 read-check-replace 整体，否则两个 writer 都可能看到相同
revision 后覆盖彼此。

## 8. 已知限制与风险

1. JSONL 是单 active process、低吞吐、可检查的开发 Store；append 是 O(history)。
2. v0.1 不支持 distributed lease 或多个 Runtime process 同时驱动一个 local Store。
3. `node:sqlite` 在 Node 24 仍是 experimental；adapter 已隔离，未来可替换实现。
4. FNV-1a State digest 是 accidental-corruption detector，不是 cryptographic proof。
5. 外部系统不合作时无法保证 exactly-once；非幂等 unknown outcome 会停在 waiting。
6. M2 尚无 waiting reconciliation API，必须由后续 approval/intervention 设计继续推进。
7. Fork 完整复制 history，长 Run 的空间和时间开销为 O(prefix)。
8. Run 初始化由 create、`run.created`、`input.received` 分步完成；`run()` 返回前停止可能
   留下不可恢复的空/部分 orphan，尚无 orphan cleanup 工具，但不会向调用者返回已接受 Run。
9. Checkpoint 加快常规 replay，但 Event schema / Reducer migrations 尚未实现。
10. public packages 尚未发布，API 仍允许在 M3/M4 基于真实 adapter evidence 调整。

## 9. 下一阶段入口

M3 只进入 ecosystem adapters：

1. 用同一个 canonical `model.generate` contract 实现 OpenAI / Anthropic；
2. 把 MCP discovered Tool 映射为 Jixu Tool，不扩展 MCP wire protocol；
3. 兼容标准 Agent Skills / `SKILL.md`，保持 Skill 是 instructional context；
4. provider credentials、clients、transport state 不得进入 Event / Checkpoint；
5. 运行 `JX-AC-009`、`JX-AC-010`、`JX-AC-011`、`JX-AC-013`。

M3 不应重新实现 Run lifecycle，也不应为每个 provider 增加 Kernel branch。若真实 SDK
evidence 暴露现有 Effect contract 不足，先按 spec evolution 流程修改最小 canonical
contract，再实现 adapter。

## 10. 文件索引

### Core

- `packages/core/src/domain.ts`：Continuity State 和 Checkpoint data；
- `packages/core/src/events.ts`：M2 lifecycle Events；
- `packages/core/src/codec.ts`：Event / Checkpoint runtime decoder；
- `packages/core/src/reducer.ts`：ready/pending、pause、waiting、Fork transitions；
- `packages/core/src/runtime.ts`：async execution、recover、pause/resume、Fork、Replay；
- `packages/core/src/store.ts`：InMemory Store 和 Checkpoint/Fork support；
- `packages/core/src/ports.ts`：扩展后的 EventStore contract。

### Adapters / testkit

- `packages/store-jsonl/src/index.ts`：JSONL Store；
- `packages/store-sqlite/src/index.ts`：SQLite Store；
- `packages/testkit/src/store-contract.ts`：跨 Store contract suite；
- `packages/core/test/continuity.test.ts`：M2 failure injection / acceptance；
- `packages/core/test/store-contract.test.ts`：InMemory contract registration；
- `packages/store-jsonl/test/store.test.ts`：JSONL contract + reconstruction；
- `packages/store-sqlite/test/store.test.ts`：SQLite contract + reconstruction。

### Public/private docs

- `README.md`：M2 已实现能力、当前 API 和 SQLite caveat；
- `SPEC.md`：M2 normative behavior，private/untracked；
- `AGENTS.md`：阶段验收后才提交/推送/合并，private/untracked；
- `docs/stages/02-m2-continuity.md`：本阶段记录，private/untracked。
