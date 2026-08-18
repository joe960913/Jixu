# 阶段 12：模型进度与 Jixu 字标

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 |
| 状态 | Completed locally |
| 关联需求 | `JX-EVT-006`、`JX-SIG-005`、`JX-TUI-019` |
| 关联验收 | `JX-AC-033`、`JX-AC-034` |

## 1. 阶段目标与边界

### 要解决的问题

轨道式 pulse 和它的静态帧都像通用加载组件；`finding the next move`、`shaping the answer` 等填充语
由 TUI 写死，不能表达 Agent 当前真正选择的下一项动作。

### 本阶段完成

- 模型请求新增内建 `jixu_progress_update` control，进度短语限制为 48 字符。
- Responses 与 Chat Completions 在原调用内解析 control，并发出 `model.progress` Signal。
- TUI 将模型短语延续到随后真实 Tool 状态，同时保留 Tool 名称与目标作为事实细节。
- 删除轨道、pulse 与冻结帧，用固定宽度 `JIXU` 字标的 Nippon 色彩扫光表达活动。
- reduced-motion 与 Responding 显示完整静态字标，Composer 固定槽位和高度不变。

### 本阶段明确不做

- 不为状态文案增加独立模型调用。
- 不把进度写入 Event、State、Checkpoint 或模型上下文。
- 不把公开进度扩展为 chain-of-thought、日志流或第二套任务状态。
- 不增加依赖、动画选择器或新的 UI 测试文件。

## 2. 为什么这样设计

### 核心判断

动态文案只能来自模型已公开输出的意图，不能由 TUI 猜测。它适合 Signal：有助于实时体验，但丢失、
重复或格式错误都不能改变执行。动效则应强化 Jixu 品牌，而不是重复一个与任何 CLI 都可互换的 spinner。

### 考虑过的替代方案

- 独立小模型生成状态：增加成本、首 token 延迟和新的失败路径，拒绝。
- 从最终回答文本截取一句：会复制 transcript，且无法可靠区分进度与答案，拒绝。
- 把 progress 当普通 Tool：会制造无意义的 Effect/Event 并污染效率指标，拒绝。
- 保留轨道只换字符：没有解决通用 loading bar 的视觉问题，拒绝。

### 主要 trade-off

每次模型请求多携带一个很小的 control schema，并可能多输出一句短语；换取与当前工作语义一致的反馈。
模型不调用 control 时仍使用 Event 派生状态，因此正确性与兼容性不依赖模型配合。

## 3. 架构与概念

### 概念关系

```text
existing model request
  -> jixu_progress_update (optional control output)
  -> Model Driver validation
  -> model.progress Signal
  -> ThreadController local projection
  -> ComposerWorkStatus + factual Tool Event detail
```

### 权威与数据边界

Progress control descriptor 随 `model.generate` Effect 持久化，但模型返回的进度短语只成为 Signal。
它不进入 ModelResponse、Event、State 或 Replay。Tool Event 仍是“做了什么”的唯一事实来源。

### 执行时序

1. Reducer 在 Model Effect 中提供 Plan control 和 Progress control。
2. Driver 在同一次 provider 调用中暴露两个内建 control 与普通 Tools。
3. 合法 progress 被规范化为单行、最多 48 字符并发出 Signal；非法 progress 被忽略。
4. Controller 暂存最新短语；随后 `tool.requested` 用短语作主文案、用 Tool Event 作次级事实。
5. 下一次 `model.requested` 或稳定边界清空短语。
6. WorkStatus 驱动固定 `JIXU` 字标；只有颜色强调改变，字符和几何不变。

## 4. 实现方式

### 关键模块

- `packages/core/src/progress.ts`：control descriptor、48 字符验证与公共 signal type。
- `packages/core/src/effects.ts`、`reducer.ts`、`codec.ts`：schema v4 与 reducer v7 的 Model Effect 边界。
- `packages/llm/src/index.ts`：Responses 与 Chat Completions control 适配。
- `packages/jixu/src/thread-controller.ts`、`work-status.ts`：瞬态投影与事实合并。
- `packages/jixu/src/tui-motion.tsx`：字标色彩帧与静态降级。

### 关键算法或状态转换

进度文本先压缩空白，再验证 1～48 字符。适配器按 provider 输出顺序处理 control；多个合法 Signal
仍只有最后一个成为当前表面投影。字标使用 `0,1,2,3,2,1` 强调序列，前一字符保留 brand echo，
其余字符使用 secondary，活动字符使用当前 phase tone。

### Failure path

- progress JSON、shape 或长度无效：忽略 control，继续普通 ModelOutcome。
- 模型不调用 control：Thinking 与 Tool Event fallback 正常工作。
- motion disabled 或 Responding：不创建 timer，直接显示 brand `JIXU`。
- Signal 丢失或进程恢复：不会影响 State、Tool dispatch 或 Replay。

## 5. 使用的技术

TypeScript discriminated boundary、JSON Schema function calling、现有 SignalSink、React local effect、OpenTUI
styled text spans、固定 Yoga geometry、Jixu Nippon theme tokens。

## 6. 验证证据

### Tests

- `node --test packages/llm/test/adapter.test.ts packages/jixu/test/session.test.ts`：8/8 通过。
- `pnpm run check`：44/44 Node tests 通过，TUI smoke 通过。

### Static checks

- package build、TypeScript typecheck、architecture lint 全部通过。
- `git diff --check` 通过。
- OpenTUI 真实 frame check 通过：动画帧强调从 `J` 移到 `I`，字符始终为 `JIXU`；静态模式等待后保持不变。

### 关键断言

- Responses 与 Chat Completions 都在原调用内发出 `model.progress`，且不把 control 变成 ToolCall。
- malformed progress 不会破坏同一响应中的内容、Plan 或 Tool。
- Controller 在 Tool 期间同时显示模型短语与 Event 派生事实。
- animated 和 static 字标都严格显示四个 `JIXU` cells，只有 animated styled spans 改变。

## 7. 遇到的问题与经验

品牌不等于给 spinner 换一个符号。用户感知到的“高级感”来自信息真实、视觉克制和边界稳定：文字
必须对应 Agent 的公开意图，动效只负责生命感，事实仍来自 Event。

## 8. 已知限制与风险

- Provider 只能在模型完成 progress control 输出后展示该短语；首个模型 token 之前仍只能显示 Thinking。
- 不同模型调用 control 的可靠程度不同，描述与 fallback 必须长期保留。
- 48 字符按 JavaScript 字符长度验证，不等同于终端 display cells；窄终端继续由状态槽裁切。

## 9. 下一阶段入口

用真实支持 function calling 的模型观察 progress 触发率、语言一致性和重复度；只有证据表明描述不足时
再调整 control prompt，不增加独立调用或更复杂的进度生命周期。

## 10. 文件索引

- `SPEC.md`
- `ARCHITECTURE.md`
- `packages/core/src/progress.ts`
- `packages/core/src/effects.ts`
- `packages/core/src/reducer.ts`
- `packages/core/src/codec.ts`
- `packages/llm/src/index.ts`
- `packages/jixu/src/thread-controller.ts`
- `packages/jixu/src/work-status.ts`
- `packages/jixu/src/tui-motion.tsx`
