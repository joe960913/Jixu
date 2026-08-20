# 阶段 24：CLI 退出 wordmark

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| Milestone | M2.14 |
| 状态 | Completed locally |
| 关联需求 | `JX-TUI-030` |
| 关联验收 | `JX-AC-017`、`JX-AC-044` |

## 1. 阶段目标与边界

### 要解决的问题

用户通过 `Ctrl+C` 离开 Jixu 后，OpenTUI 恢复 shell，但终端没有任何清晰的产品收尾。
目标是在不污染 TUI frame、不破坏终端状态的前提下，在 shell prompt 上方留下一枚
简洁的 `JIXU` terminal wordmark。

### 本阶段完成

- user Quit 和 `SIGINT` 走可区分的 ordinary shutdown reason；
- renderer unmount、destroy 并恢复 terminal ownership 后打印一次六行 `JIXU`；
- TTY 默认使用 Jixu brand color，`NO_COLOR` 或 dumb terminal 使用无 ANSI 版本；
- `SIGTERM`、help、non-TTY stdout、startup failure 和 unhandled failure 不打印；
- ANSI 输出在 wordmark 后显式 reset，避免改变 shell prompt 样式；
- 增加 formatter/reason tests，并通过真实 PTY Ctrl+C smoke。

### 本阶段明确不做

- 不在 Event、Signal、Thread、transcript 或 TUI State 中记录退出；
- 不拦截 crash 来伪装 ordinary exit；
- 不为 ASCII art 增加依赖或运行时 font renderer；
- 不在重定向、pipe、CI log、help 输出或 `SIGTERM` 中插入品牌内容；
- 不改现有 config、Tools、model connection 或 shell prompt。

## 2. 为什么这样设计

### 核心判断

退出 wordmark 属于 CLI process chrome，不属于 Jixu TUI，也不是 durable fact。只有在
renderer 已释放 alternate screen、mouse mode、cursor 和 color state 后写 stdout，内容
才不会被 `clearOnShutdown` 擦除，也不会与 OpenTUI 的绘制协议混在一起。

### 考虑过的替代方案

- **在 TUI 内渲染最后一帧**：destroy 时会被清除，shell 看不到，拒绝；
- **在 signal handler 直接写 stdout**：会与 renderer teardown 交错并留下 terminal mode，
  拒绝；
- **所有 exit 都打印**：会污染 pipe、CI、help、部署终止和 failure evidence，拒绝；
- **引入 figlet/ascii-font**：六行固定标识不值得增加依赖和发布面，拒绝；
- **调用 `process.exit()`**：会跳过正常 finally/teardown，拒绝。

### 主要 trade-off

Wordmark 使用固定六行、约 32 列，视觉稳定且足够有识别度，但不会根据极窄 shell
宽度重排。输出只面向真实 TTY；这意味着 snapshot、pipe 和普通日志默认看不到它，
这是为了保持机器输出干净的有意边界。

## 3. 架构与概念

### 概念关系

```text
Ctrl+C in TUI / /quit       SIGINT                  SIGTERM
        |                     |                       |
   interactive            interrupt               terminate
        \_____________________|_______________________/
                              |
                         resolve done
                              |
                  unmount root -> destroy renderer
                              |
           interactive or interrupt + stdout is TTY?
                     yes /                 \ no
             print one wordmark          print nothing
```

### 权威与数据边界

Exit reason 只存在于 `runCli` 的局部 process state，用来决定 teardown 后是否写 stdout。
它不是 Thread lifecycle，也不进入 config、Store、Event、Signal、Checkpoint 或 telemetry。
Formatter 是纯函数，只接收 reason、TTY 和 color capability。

### 执行时序

JixuApp 的 Quit callback 或 process signal 只 resolve `done`。`finally` 先注销 signal
listener、unmount React root、destroy renderer。只有 try/finally 正常完成后，CLI 才
生成 output 并调用一次 `process.stdout.write`；异常继续向上抛出且不会显示 wordmark。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/cli-exit.ts`：固定 wordmark、brand ANSI 和纯 exit-output policy；
- `packages/jixu/src/cli.tsx`：exit reason、signal distinction、teardown 后 stdout write；
- `packages/jixu/test/cli-exit.test.ts`：plain/color output、ANSI reset 和 silent boundaries；
- `SPEC.md`：`JX-TUI-030`、`JX-AC-044` 和兼容性说明。

### 关键算法或状态转换

First exit reason wins；Promise resolve 仍保持 idempotent。Interactive Quit 与 `SIGINT`
可输出，`SIGTERM` 明确静默。Color capability 由 TTY、`NO_COLOR` 和 `TERM=dumb` 决定；
plain/color 两条路径复用完全相同的 wordmark rows。

### Failure path

- renderer 创建或启动失败：尚未进入 ordinary shutdown，不打印；
- renderer unmount/destroy 抛错：后续 output code 不执行；
- stdout 非 TTY：纯函数返回空串，不写 pipe；
- `SIGTERM`：正常 teardown，但返回空串；
- `NO_COLOR`：仍打印 wordmark，但不包含 escape sequence；
- 多个 exit request：只保留第一个 reason，stdout 最多写一次。

## 5. 使用的技术

- TypeScript closed exit-reason union；
- Promise-based orderly shutdown 与 `try/finally` teardown；
- 24-bit ANSI foreground、显式 SGR reset 和 `NO_COLOR` boundary；
- Unicode block terminal wordmark，无外部字体或图片协议；
- OpenTUI alternate-screen teardown 与真实 PTY keyboard input。

## 6. 验证证据

### Tests

- targeted exit tests：2/2 通过；
- `pnpm run check`：53/53 Node tests、OpenTUI smoke、typecheck 和 lint 通过；
- 真实 PTY 使用临时 `JIXU_HOME` 启动 CLI，发送 Ctrl+C 后确认先恢复 terminal，随后
  输出一次六行 wordmark；真实用户配置未读取或修改，临时目录由 trap 清理；
- `pnpm run test:packages`：同一 tarball set 通过 npm、pnpm、Yarn、Bun clean consumer。

### Static checks

- `tsc -b tsconfig.build.json`：通过；
- `tsc --noEmit`：通过；
- `pnpm run lint`：通过，core architecture lint passed；
- `git diff --check`：通过。

### 关键断言

- interactive Quit 与 `SIGINT` 的 plain rows 完全相同；
- color output 使用 theme brand RGB，并以 ANSI reset 结束；
- 去除 ANSI 后与 plain output byte-for-byte 一致；
- non-TTY、`SIGTERM` 和 null reason 返回空字符串；
- real PTY 中 wordmark 出现在 alternate-screen restore sequence 之后。

## 7. 遇到的问题与经验

OpenTUI 已关闭默认 `exitOnCtrlC`，Ctrl+C 由 React keyboard hook 转成普通 `onQuit`；
同时 CLI 仍保留 process `SIGINT` fallback。因此不能只在 signal handler 打印，否则正常
键盘退出不会经过该路径。最终让两条入口只提交不同 reason，共享一个 orderly teardown。

真实 PTY smoke 也验证了输出位置：renderer 的 restore sequence 完成后，wordmark 才进入
普通 screen。这个证据比仅测试 formatter 更重要，因为顺序错误会让正确字符串仍然不可见。

## 8. 已知限制与风险

- 固定 wordmark 不随 shell 宽度缩放；极窄终端可能自然换行；
- `/quit` 与 Ctrl+C 都属于 interactive user exit，因此都会显示相同 wordmark；
- 当前只使用单一 brand color，没有逐字母渐变或动画；
- terminal 若错误宣称支持 24-bit color，可能降级显示，但 ANSI reset 仍会执行。

## 9. 下一阶段入口

该退出边界已经闭合，不需要继续增加 goodbye 文案、动画或 telemetry。若未来提供
machine-readable CLI subcommand，应继续默认关闭所有品牌输出，并让 stdout 只承载协议数据。

## 10. 文件索引

- `SPEC.md`
- `packages/jixu/src/cli-exit.ts`
- `packages/jixu/src/cli.tsx`
- `packages/jixu/test/cli-exit.test.ts`
