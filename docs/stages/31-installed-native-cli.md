# 阶段 31：可安装的原生 Jixu CLI

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-21 |
| Milestone | Installed CLI distribution |
| 状态 | Completed（macOS arm64 release slice） |
| 关联需求 | `JX-CLI-001` 至 `JX-CLI-007` |
| 关联验收 | `JX-AC-017`、`JX-AC-050`、`JX-AC-051` |

## 1. 阶段目标与边界

### 要解决的问题

源码仓库里的 TUI 只能通过 workspace 命令启动，用户安装 `jixu` 后还不能直接在任意终端输入
`jixu`。发布路径也没有回答 native OpenTUI binary 如何按平台分发、如何避免 install script 和
runtime download、如何保证实际安装的文件就是已验收产物。

### 本阶段完成

- `jixu` facade 通过标准 `bin` 暴露 Node launcher，并以 exact-version optional dependencies 指向
  macOS arm64、macOS x64 和 Linux x64 glibc 平台包。
- launcher 根据 OS、CPU 和 Linux libc 只选择一个平台包，不执行 postinstall、运行时下载或
  fallback compilation；缺包和不支持的平台返回可操作错误。
- 将 reference TUI 通过固定 Bun 1.4.0 编译为 standalone executable，嵌入同一套 OpenTUI 与
  tree-sitter assets；运行时不要求用户安装 Bun。
- macOS binary 在编译后使用 runtime entitlements 签名；本地验收使用 ad-hoc identity，公开发布
  会强制要求 `JIXU_CODESIGN_IDENTITY`。
- release manifest 记录 Bun 版本、target、package、size 和 SHA-256；平台 tarball 必须逐字节匹配
  manifest，并在 tar header 中保留 executable bit。
- 使用真实 PTY 启动 standalone TUI，确认未配置模型时显示 `/config` 引导，再通过 `/quit` 正常退出。
- npm、pnpm、Yarn 和 Bun 均在禁用 lifecycle scripts 的 clean consumer 中安装同一组真实 host
  tarball，并运行 `jixu --version`、各自的 exec path、TypeScript 和 Node 22.19.0 smoke。
- README 收敛为简短英文安装和 framework quick start，明确 global install 与
  `npx` / `pnpm dlx` / `yarn dlx` / `bunx`。

### 本阶段明确不做

- 不发布 npm package，不修改 remote，不提交或推送。
- 不把 Homebrew formula 混入 npm 首发路径。
- 不把本机 cross-compiled 文件冒充 target-native 验收；macOS x64 和 Linux x64 glibc 仍需各自在
  对应 runner 上构建、运行和打包。
- 不在本地 ad-hoc 签名阶段声称完成 Developer ID 签名、公证或 Gatekeeper 公开分发验收。
- 不改变 Harness、Thread、Event、State、Reducer 或持久化 schema。

## 2. 为什么这样设计

### 核心判断

OpenTUI 的 native runtime 应在目标平台构建时进入 standalone binary，而不是在用户机器上安装后
再下载或编译。facade 只负责标准 npm command discovery 和平台选择；每个平台包只负责承载一个
已签名、可校验的 executable。这样 npm 与未来 Homebrew 可以复用同一份 checksum authority，
又不把 package manager 变成第二条应用运行路径。

### 考虑过的替代方案

- 直接把 Bun 当成用户运行时：安装简单，但增加未声明的 runtime prerequisite，且无法证明普通
  npm consumer path。
- postinstall 下载 GitHub Release：引入网络、供应链和代理失败面，禁用 scripts 时完全失效。
- 一个通用 package 同时携带全部 binary：每次安装下载所有平台产物，体积和审计边界更差。
- 在 arm64 Mac 上伪造 x64/Linux package acceptance：可以让本地测试变绿，但不能证明目标 native
  dependency、签名和 terminal 行为，违反 release artifact 同一性。
- 让平台包也注册 `jixu` bin：能间接保留 executable bit，但会与 facade 争夺同名 command。

### 主要 trade-off

facade launcher 仍要求 Node 22.19.0；standalone TUI 本身不要求 Bun。这样保留标准 package manager
bin linking 和明确错误，同时避免 native package 的 install scripts。若未来要求完全无 Node 的
分发，Homebrew 可以直接安装相同 native artifact，而不改变 npm 合同。

## 3. 架构与概念

### 概念关系

```text
global install / dlx
        |
        v
   jixu facade bin (Node launcher)
        |
        +-- OS + CPU + libc --> exact optional platform package
                                   |
                                   v
                         signed standalone jixu
                                   |
                                   v
                         reference TUI + Harness
```

### 权威与数据边界

- `packages/jixu/package.json` 是 command 和 optional package mapping 的发布入口。
- `cli-targets.ts` 是 target、package name、directory 和 Bun target 的 typed catalogue。
- `.bun-version` 是 executable compiler version authority。
- `artifact.json` 是单个平台 binary identity 和 checksum authority；tarball 必须匹配它。
- TUI 仍通过原有 Harness 和 Event-derived State 工作；launcher 和 native package 都不是 Thread authority。

### 执行时序

```text
jixu argv
  -> Node bin launcher
  -> detect runtime
  -> resolve @jixu/cli-<target>/package.json
  -> spawn bin/jixu with inherited stdio and environment
  -> OpenTUI reference CLI
  -> ordinary Harness path
```

## 4. 实现方式

### 关键模块

- `packages/jixu/src/cli-targets.ts`：target catalogue、libc detection 与 fail-closed selection。
- `packages/jixu/src/cli-launcher.ts`：optional package resolution 与 stdio-inheriting spawn。
- `packages/jixu/src/cli-bin.ts`：标准 package `bin` entrypoint。
- `scripts/build-cli-artifact.ts`：固定 Bun、standalone compile、macOS signing 和 manifest。
- `scripts/package-artifacts.ts`：binary copy、mode/checksum assertion、publint/ATTW 和 tarball manifest。
- `scripts/verify-cli-executable.ts`：macOS `expect` 与 Linux `script` 的真实 PTY acceptance。
- `scripts/verify-package-portability.ts`：四个 clean consumer 和 Node floor smoke。

### 关键算法或状态转换

launcher 对 catalogue 做 exact match，不按相近平台猜测。Linux 只有检测到 glibc 才选择当前
`linux-x64` package；未知或 musl 环境 fail closed。resolve 成功后直接以 `shell: false` 和继承 stdio
执行 binary，并透传 exit status。

构建器只允许 `.artifacts` 或系统临时目录作为输出，先验证当前 Bun 与 `.bun-version` 完全一致，
再关闭 compile-time bunfig、dotenv、package.json 和 tsconfig autoload。macOS 在 checksum 计算前
签名，因此 manifest 和 tarball 绑定的是最终可分发字节。

### Failure path

- Bun 版本漂移时构建立即失败，不产生候选 release artifact。
- unsupported OS/CPU/libc 或 optional dependency 缺失时 launcher 明确提示支持范围或重新安装方式。
- native tarball 缺 `LICENSE`、`package.json`、binary、executable bit 或 checksum 不一致时打包失败。
- public macOS build 没有非 ad-hoc identity 时失败；本地签名不能误进入公开发布模式。
- PTY 无法打开 TUI、缺少 `/config` 引导或不能在时限内 `/quit` 时 acceptance 失败。

## 5. 使用的技术

- TypeScript ESM、typed target catalogue、`createRequire` 和 `spawnSync`。
- Bun 1.4.0 standalone compilation 与 compile-time `define`。
- macOS `codesign`、hardened runtime entitlements 与 SHA-256 manifest。
- npm optional `os` / `cpu` / `libc` packages、`publishConfig.executableFiles`。
- `@publint/pack`、Publint、Are the Types Wrong、真实 clean consumer。
- PTY acceptance：macOS `expect`，Linux util-linux `script`。

## 6. 验证证据

### Tests

- `pnpm run check:release`：80 个 Node tests 全部通过，OpenTUI smoke 通过。
- `JX-AC-050`：target selection、native package resolution、unsupported/missing package failure 通过。
- `JX-AC-051`：真实 macOS arm64 standalone TUI 显示 `Model not configured` 与 `use /config`，
  `/quit` 后 exit 0。
- `JX-AC-017`：npm、pnpm、Yarn、Bun clean install、command、exec、TypeScript 和 Node 22.19.0
  runtime smoke 全部通过，且 install scripts 被禁用。

### Static checks

- `tsc --noEmit`：通过。
- core architecture lint：通过。
- Publint 与 Are the Types Wrong：所有实际候选 tarball 通过。
- macOS arm64 artifact：Mach-O arm64，ad-hoc hardened-runtime 签名验证通过，compiler 为 Bun 1.4.0。

### 关键断言

- facade tarball 的 `bin.jixu` 指向已编译 Node launcher。
- host platform tarball 的 binary SHA-256 与 `artifact.json` 一致，tar mode 含 executable bit。
- `jixu --version` 从 executable 的 compile-time version 返回，与所有 package version 一致。
- clean consumer 不依赖 workspace import、Bun runtime、postinstall 或 runtime download。

## 7. 遇到的问题与经验

本机原有 Bun 1.3.12 生成的 standalone Mach-O 无法签名且启动后被系统终止。构建器先增加 exact
compiler guard，升级到 1.4.0 后相同入口成功构建、签名和运行。这证明 compiler pin 必须是 release
contract，而不能只记录在开发说明里。

macOS 自带 `script` 在 Node pipe 下无法获得 controlling terminal，报 `tcgetattr/ioctl`。最终使用
系统 `expect` 真正分配 PTY；Linux 保留 util-linux `script`。测试夹具失败与应用失败必须分开判断。

pnpm pack 会把普通 payload 规范化为 `0644`。平台 manifest 使用
`publishConfig.executableFiles` 声明 executable，并在 tar header 和 clean install 两层验证权限，
避免依赖 postinstall `chmod`。

Yarn 在预发布本地 tarball 场景仍会解析不属于当前机器的 optional platform packages。测试为尚未
发布的异构包生成仅用于 resolution 的 metadata tarball，并配置 `supportedArchitectures` 让 Yarn
完整 fetch；这些夹具不进入 release candidate 或 `artifacts.json`，host binary 仍是唯一实际运行对象。

尝试在 arm64 Mac cross-compile x64 时，Bun 正确报告缺少
`@opentui/core-darwin-x64`。本阶段据此保持“一 target 一 native runner”边界，没有复制 host binary
或使用占位 binary 伪造跨平台产物。

## 8. 已知限制与风险

- 仅 macOS arm64 已完成 target-native compile、签名、PTY、tarball 和四包管理器验收。
- macOS x64 与 Linux x64 glibc package metadata 已定义，但仍需对应 runner 安装目标 OpenTUI native
  dependency、构建并执行 `JX-AC-051`；在此之前不得公开宣称三个 target 均已验收。
- 公开 macOS release 仍需 Developer ID Application identity、timestamp、公证和 Gatekeeper 验证；
  当前 ad-hoc 签名只用于本地验收。
- package version 仍是 `0.0.0`，npm scope/package ownership、最终 version bump、provenance 和发布顺序
  尚未执行。
- Homebrew 尚未实现；未来 formula 必须引用同一 target artifact checksum，不能重新编译另一份 TUI。

## 9. 下一阶段入口

下一阶段先建立 macOS x64 与 Linux x64 glibc 的 target-native release matrix：每个 runner 使用同一
`.bun-version` 构建、运行 PTY acceptance、签名或校验、打包并上传 manifest。聚合阶段只接受所有
target 的已验证 manifest，再统一设置正式 version、完成 Developer ID/notarization、npm ownership
与 publish dry-run。公开发布仍需 maintainer 单独确认。

## 10. 文件索引

- `.bun-version`
- `README.md`
- `SPEC.md`
- `packages/jixu/package.json`
- `packages/jixu/src/cli.tsx`
- `packages/jixu/src/cli-bin.ts`
- `packages/jixu/src/cli-launcher.ts`
- `packages/jixu/src/cli-targets.ts`
- `packages/jixu/test/cli-launcher.test.ts`
- `packages/cli-darwin-arm64/package.json`
- `packages/cli-darwin-x64/package.json`
- `packages/cli-linux-x64/package.json`
- `scripts/build-cli-artifact.ts`
- `scripts/macos-cli-entitlements.plist`
- `scripts/package-artifacts.ts`
- `scripts/verify-cli-executable.ts`
- `scripts/verify-package-portability.ts`
