# 阶段 32：三目标 Beta 发布边界

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-21 |
| Milestone | Installed CLI distribution |
| 状态 | Completed（本地验收） |
| 关联需求 | `JX-CLI-001` 至 `JX-CLI-007` |
| 关联验收 | `JX-AC-017`、`JX-AC-050`、`JX-AC-051` |

## 1. 阶段目标与边界

### 要解决的问题

撤回尚未发布的 Windows CLI 路线，将首个 Beta 的公开边界固定为 macOS arm64、macOS x64 和 Linux x64 glibc，避免为一个未接受的平台长期维护独立 launcher、PTY 和构建分支。

### 本阶段完成

- 删除 Windows 平台包、typed target、facade optional dependency 和 launcher acceptance。
- 删除 Windows command shim、winpty acceptance、平台路径兼容以及 release matrix runner。
- 将配置权限、tarball executable bit 和本地 Tool 测试收敛到受支持平台的 POSIX 语义。
- 保留 `0.1.0-beta.0`、npm Beta ad-hoc macOS 签名规则和三目标 artifact aggregation。

### 本阶段明确不做

- 不执行 npm publish。
- 不新增其他 OS、CPU 或 libc 目标。
- 不改变 Harness、Agent、Thread、Event、Reducer 或 durable schema。

## 2. 为什么这样设计

### 核心判断

一个平台只有在项目愿意持续承担 target-native build、PTY、包管理器安装和故障支持时才应进入公开 target catalogue。删除目标比保留一个半完成分支更诚实，也让 facade 继续只做 exact target selection。

### 考虑过的替代方案

- 保留代码但不宣传：仍会扩大 release matrix 和维护面，且 package metadata 已构成公开承诺。
- 只删除 workflow runner：launcher 和 optional package 仍会宣称支持，无法 fail closed。
- 保留跨平台 shell shim：当前三目标都可以直接 spawn，额外分支没有使用价值。

### 主要 trade-off

Jixu 不再提供 Windows 安装路径；换来的是一套更小、可解释、能够逐目标验收的首发矩阵。

## 3. 架构与概念

### 概念关系

```text
jixu facade
  -> darwin-arm64
  -> darwin-x64
  -> linux-x64-glibc
```

### 权威与数据边界

`cli-targets.ts` 仍是平台目录、package name、Bun target 和 executable name 的唯一 typed catalogue；release workflow 和 artifact aggregation 消费该目录，不创建第二份 target 状态。

### 执行时序

facade 检测 OS、CPU 和 Linux libc，exact match 后直接执行 `bin/jixu`；不匹配的环境在 TUI 启动前返回支持目标列表。

## 4. 实现方式

### 关键模块

- `packages/jixu/src/cli-targets.ts`：只保留三个公开目标。
- `scripts/build-cli-artifact.ts`、`scripts/package-artifacts.ts`：统一按 POSIX executable 处理。
- `scripts/verify-package-portability.ts`：只安装当前受支持 host artifact。
- `.github/workflows/release-candidate.yml`：只保留两个 macOS runner 和一个 Linux runner。

### 关键算法或状态转换

没有新增状态转换。target catalogue 缩小后，launcher、构建、聚合和 consumer verification 通过同一数组机械收敛。

### Failure path

不在 catalogue 的 runtime fail closed；缺少 optional dependency、artifact manifest 漂移、binary 非 executable 或 checksum 不一致仍会阻断发布。

## 5. 使用的技术

TypeScript discriminated target catalogue、Bun standalone executable、npm optional platform packages、GitHub Actions target-native matrix、macOS codesign 和真实 tarball consumer smoke。

## 6. 验证证据

### Tests

- `pnpm run check:release`：81/81 Node tests、OpenTUI smoke 全部通过。
- npm、pnpm、Yarn、Bun clean consumer 均通过安装、`jixu` command、TypeScript 与 Node 22.19.0 smoke。
- `JIXU_PUBLIC_RELEASE=1 pnpm run pack:packages`：生成 9 个当前 host release candidates，CLI manifest 只有 `darwin-arm64` 且签名为 `ad-hoc`。

### Static checks

- TypeScript typecheck、core architecture lint、Publint、Are the Types Wrong 和 `git diff --check` 通过。
- release workflow YAML 可解析。

### 关键断言

- facade optional dependencies 不再包含 Windows package。
- release target catalogue、workflow matrix 和 README 只声明三个目标。
- npm registry 未产生 `0.1.0-beta.0` 发布。

## 7. 遇到的问题与经验

目标平台不是“多加一个 matrix entry”。它会继续扩散到 shell invocation、PTY、path canonicalization、权限语义、fixture 和发布聚合。平台决策应在写代码前先确认长期支持意愿。

## 8. 已知限制与风险

- 本轮本地只能重新验证 macOS arm64 artifact；macOS x64 和 Linux x64 仍应由各自 runner 对当前提交重新构建和验收。
- lockfile 仍会记录 OpenTUI 上游声明的跨平台 optional packages；这是第三方依赖图，不是 Jixu 的公开 target catalogue。
- npm 尚未发布，三个 target 的最终聚合发布仍需单独确认。

## 9. 下一阶段入口

下一步只运行三目标 release candidate matrix，聚合三个 target-native artifact；确认 manifest 和安装验收后，再由 maintainer 决定是否执行 npm Beta 发布。

## 10. 文件索引

- `SPEC.md`
- `README.md`
- `packages/jixu/package.json`
- `packages/jixu/src/cli-targets.ts`
- `scripts/build-cli-artifact.ts`
- `scripts/package-artifacts.ts`
- `scripts/verify-cli-executable.ts`
- `scripts/verify-package-portability.ts`
- `.github/workflows/release-candidate.yml`
