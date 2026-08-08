# 阶段 35：npm README 与 facade-only 修复发布

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-21 |
| Milestone | First npm beta follow-up |
| 状态 | In progress |
| 关联需求 | `JX-CLI-001`、`JX-CLI-005` |
| 关联验收 | `JX-AC-050`、`JX-AC-051` |

## 1. 阶段目标与边界

### 要解决的问题

`jixu-ai@0.1.0-beta.0` 的 tarball 没有 README，npm package page 因而无法展示安装和使用说明。仓库根 README 不属于 `packages/jixu` package root，原 release acceptance 也没有把 README 作为必需文件。

### 本阶段完成

- 为 `jixu-ai` 增加简洁、独立且适合 npm 展示的英文 README。
- 将 README 纳入 facade package files，并把缺失检查加入正式 pack pipeline。
- 仅升级 facade，精确复用已经发布和验证的 `0.1.0-beta.0` Framework 与 native packages；最终 README projection 修复版本为 `0.1.0-beta.2`。
- 将公开 facade import 实际需要的 `jixu-tools-jina` 与 `jixu-tools-node` 从开发依赖提升为 runtime dependencies。

### 本阶段明确不做

- 不改变 `jixu` executable、支持平台、Agent Framework API 或 durable semantics。
- 不增加 Windows target，不改变 macOS beta 的 ad-hoc 签名政策。

## 2. 为什么这样设计

### 核心判断

npm package page 必须由实际发布 tarball 自足地提供 README，不能依赖 monorepo 根目录的隐式行为。已发布版本不可原地修改，因此需要新 immutable version。

### 考虑过的替代方案

- 只依赖仓库根 README：npm 从 package root 打包，不会自动包含。
- 重新写入 `beta.0`：npm 不允许覆盖已发布的相同 name/version。
- 整套 11 包升级：安全但会为纯 README 修复重复构建和发布未变化的 native bytes。

### 主要 trade-off

facade 与 native package version 不再强制相同；代价是 `jixu --version` 表示实际执行的 native artifact version，而 npm facade 有自己的 packaging version。所有依赖仍使用 exact version，native 变化仍强制完整矩阵。

## 3. 架构与概念

README 只描述既有 `jixu-ai -> bin.jixu -> native package` 入口，不增加运行时概念。各 package manifest 是自身版本权威，packer 机械解析 workspace dependencies 为对应 dependency manifest 的 exact version。

## 4. 实现方式

- `packages/jixu/README.md` 提供 npm package 文档。
- `packages/jixu/package.json` 显式声明 README。
- `scripts/package-artifacts.ts` 在正式 tarball inspection 中 fail closed。
- facade-only pack path 不构建 native bytes，只发布 `jixu-ai` candidate，并针对公开的 exact dependency set 做干净 npm 安装验收。

## 5. 使用的技术

npm package files、Publint pack inspection、SHA-256/SHA-512 artifact manifests、fixed-version prerelease policy。

## 6. 验证证据

待本地 release suite、三平台 matrix、npm write 和公开 metadata 验收完成后补充。

## 7. 遇到的问题与经验

README 是公开包的核心入口，必须像 executable、types 和 licenses 一样成为 release-blocking artifact assertion，不能只依赖仓库页面人工检查。

原全套 portability fixture 会同时安装所有 workspace tarballs，因此掩盖了 facade 的未声明 runtime imports。facade-only acceptance 必须只安装 facade candidate，让其余依赖从真实 registry 按 packed exact versions 解析。

## 8. 已知限制与风险

- macOS beta native packages继续使用 ad-hoc signature。
- Windows 不在支持范围内。

## 9. 下一阶段入口

完成 facade-only `beta.2` 发布后，从 npm public metadata 确认 README、版本、dist-tags 和 tarball integrity。

## 10. 文件索引

- `packages/jixu/README.md`
- `packages/jixu/package.json`
- `scripts/package-artifacts.ts`
- `package.json`
- `packages/*/package.json`
