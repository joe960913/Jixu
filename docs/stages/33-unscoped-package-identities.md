# 阶段 33：独立的 Jixu 品牌包名

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-21 |
| Milestone | First npm beta |
| 状态 | Completed（本地验收） |
| 关联需求 | `JX-CLI-001` 至 `JX-CLI-007` |
| 关联验收 | `JX-AC-017`、`JX-AC-050`、`JX-AC-051` |

## 1. 阶段目标与边界

### 要解决的问题

原计划的 `@jixu/*` package identifiers 依赖一个不属于本项目的 npm scope。实际首次 publish 在网页二次认证后被 registry 以权限错误拒绝，且没有产生任何已发布版本。Agent Framework 又必须保持独立安装，不能为了绕过 scope 把所有模块和 native dependencies 塞进 `jixu` facade。

### 本阶段完成

- 主包与终端命令继续使用 `jixu`。
- framework packages 改为 `jixu-core`、`jixu-llm`、`jixu-store-*`、`jixu-tools-*` 和 `jixu-testkit`。
- native implementation packages 改为三个 `jixu-cli-*` 名称。
- package manifests、workspace dependencies、imports、launcher catalogue、consumer fixtures、文档和锁文件使用同一组 package identifiers。

### 本阶段明确不做

- 不合并 framework package boundaries。
- 不改变 Agent、Thread、Event、Reducer、Effect 或持久化 schema。
- 不增加平台目标，不恢复 Windows。

## 2. 为什么这样设计

### 核心判断

独立 npm package 必须拥有独立 registry identifier。`jixu/core` 只能成为 `jixu` 包的 export subpath，不能独立安装；把它用于 framework 会让 framework-only consumer 同时获得 TUI 与 native optional dependencies。统一的非 scoped `jixu-*` 前缀既保留模块边界，也不把维护者个人账号写进公共 API。

### 考虑过的替代方案

- `@22t/*`：技术上可发布，但公共名称绑定个人账号，品牌边界较弱。
- 单一 `jixu` package 加 subpath exports：import path 简洁，但失去独立安装和依赖裁剪。
- 继续使用 `@jixu/*`：没有 scope 权限，registry 已实际拒绝。

### 主要 trade-off

import specifier 从 scoped slash 形式变为连字符形式；换来的是立即可控、品牌一致且可独立发布的 package ownership。

## 3. 架构与概念

### 概念关系

```text
jixu                      -> CLI facade + TUI
jixu-core                 -> durable Agent kernel
jixu-llm / stores / tools -> independently installed adapters
jixu-cli-<target>         -> optional native executable
```

### 权威与数据边界

每个 `packages/*/package.json` 是自身 npm identifier 的 authority；`cli-targets.ts` 是 native package mapping 的 typed authority；release manifest 绑定最终 tarball name、version 和 checksum。

### 执行时序

framework consumer 只安装需要的 `jixu-*` modules。CLI consumer 安装 `jixu`，package manager 根据 optional dependency metadata 只选择匹配平台的 `jixu-cli-*` executable。

## 4. 实现方式

### 关键模块

- `SPEC.md` 与 `README.md`：公开 package identifiers 和安装方式。
- `packages/*/package.json`：package names 与 exact workspace dependencies。
- `packages/jixu/src/cli-targets.ts`：三个 native package names。
- `scripts/package-artifacts.ts` 与 `scripts/verify-package-portability.ts`：tarball 分类和 clean consumer imports。

### 关键算法或状态转换

本阶段没有运行时状态转换。package rename 通过 workspace package identity 机械传播，测试仍从正式 package boundary 导入，避免 source-path bypass。

### Failure path

旧 scope 残留、dependency name 漂移、tarball manifest 不一致或 consumer 无法解析独立 package 都会在 build、typecheck、pack 或四包管理器 smoke 中失败。

## 5. 使用的技术

pnpm workspace linking、TypeScript package imports、npm exact-version dependencies、optional OS/CPU/libc packages、Publint、Are the Types Wrong 和真实 tarball consumers。

## 6. 验证证据

### Tests

- `pnpm run check:release`：81/81 Node tests 与 OpenTUI smoke 通过。
- npm、pnpm、Yarn、Bun clean consumer 均完成安装、`jixu` command、TypeScript 与 Node 22.19.0 smoke。
- `JIXU_PUBLIC_RELEASE=1 pnpm run pack:packages`：当前 host 生成 9 个候选包，名称全部为 `jixu` 或 `jixu-*`。

### Static checks

- typecheck、core architecture lint、Publint、Are the Types Wrong 和 `git diff --check` 通过。
- tracked source、tests、manifests 和 lockfile 不再引用旧 scoped package path。

### 关键断言

- framework packages 仍可单独安装。
- facade 仍以 `bin.jixu` 暴露相同终端命令。
- 所有候选包保持 `0.1.0-beta.0`，没有已发布旧名称需要迁移。

## 7. 遇到的问题与经验

npm package 返回 404 只说明具体 package 尚未发布，不说明它所属的 scope 可被当前账号使用。真正的发布权限必须通过 authenticated write 或组织成员查询验证。公共 package identity 应在生成多平台 artifact 前先完成 ownership probe。

## 8. 已知限制与风险

- 当前只完成本机 macOS arm64 public pack；两个 macOS target 和 Linux target 仍需在新提交上重新聚合。
- npm package version 不可覆盖；发布必须继续使用本阶段验证的同一批远端 tarball。
- 本阶段不提供旧 scoped import alias，因为它从未成功发布。

## 9. 下一阶段入口

推送当前 package identity 迁移，重新运行三平台 release candidate matrix，验证 11 个聚合 tarball 后按 native packages、core、adapters、facade 的顺序发布到 npm `beta` tag，并从 registry 做一次全新全局安装。

## 10. 文件索引

- `SPEC.md`
- `README.md`
- `packages/*/package.json`
- `packages/jixu/src/cli-targets.ts`
- `pnpm-lock.yaml`
- `scripts/package-artifacts.ts`
- `scripts/verify-package-portability.ts`
