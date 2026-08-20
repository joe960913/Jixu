# 阶段 34：`jixu-ai` 入口包身份修正

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-21 |
| Milestone | First npm beta |
| 状态 | Completed（本地验收） |
| 关联需求 | `JX-CLI-001`、`JX-CLI-005` |
| 关联验收 | `JX-AC-017`、`JX-AC-050`、`JX-AC-051` |

## 1. 阶段目标与边界

### 要解决的问题

三个 native packages 和七个独立 Framework packages 已成功发布到 npm
`beta`，但 registry 在真正写入时以 package-similarity protection 拒绝了
unscoped `jixu` facade，指出该名称与已有包过于相似。dry-run 和 404
availability probe 都没有提前暴露这项远端策略。

### 本阶段完成

- 将 canonical npm facade 从 `jixu` 改为 `jixu-ai`。
- 保持产品名 Jixu 和 `bin.jixu` 不变；全局安装后仍输入 `jixu`。
- 保持已经发布的 `jixu-*` Framework 和 native package identities 不变。
- 让 package packer、四包管理器 consumer fixtures、launcher 错误提示和公开文档使用同一 facade identity。

### 本阶段明确不做

- 不重发或改名已经发布的十个依赖包。
- 不改变版本 `0.1.0-beta.0`、native bytes、平台集合或签名政策。
- 不改变 Agent、Thread、Event、State、配置或持久化 schema。

## 2. 为什么这样设计

### 核心判断

npm package identity 与安装后的 executable identity 是两个独立边界。
`jixu-ai` 解决 registry uniqueness，`bin.jixu` 继续维护用户已经确认的产品入口，
不需要把个人账号 scope 写进安装命令。

### 考虑过的替代方案

- `@22t/jixu`：registry 明确允许，但安装身份绑定个人账号。
- 继续重试 `jixu`：相同 immutable version 尚未创建，重复请求无法绕过服务端相似度策略。
- `jixu-agent`、`jixu-code` 等：可用候选，但 `jixu-ai` 更短，也不把 facade 限定为纯 CLI、TUI 或某一种 Agent 用途。

### 主要 trade-off

用户的安装和 ephemeral execution 命令需要写 `jixu-ai`；安装后的长期终端命令仍是最短的 `jixu`。

## 3. 架构与概念

### 概念关系

```text
jixu-ai                    -> facade + bin.jixu
  ├─ jixu-core             -> public Agent Framework
  └─ jixu-cli-<target>     -> exact-version optional native executable
```

### 权威与数据边界

`packages/jixu/package.json` 是 facade registry identity 与 `bin` mapping 的权威；
`cli-targets.ts` 继续作为 native target mapping 的权威；release manifest 继续绑定 tarball 与 native checksum。

### 执行时序

package manager 安装 `jixu-ai`，根据 optional dependency metadata 选择一个兼容的
`jixu-cli-*` 包，并将 facade 的 `bin.jixu` 链接为 `jixu`。launcher 只解析并执行该 native binary。

## 4. 实现方式

### 关键模块

- `SPEC.md`、`README.md`：canonical package identity 和 beta 安装命令。
- `packages/jixu/package.json`：`name: jixu-ai`，保留 `bin.jixu`。
- `scripts/package-artifacts.ts`：从 source manifest 校验 facade 与 native optional dependencies。
- `scripts/verify-package-portability.ts`：从真实 `jixu-ai` tarball 验证导入、类型和 `jixu` command。

### 关键算法或状态转换

本阶段没有运行时状态转换。只替换 registry identifier，并让发布验收继续从正式 package boundary 执行。

### Failure path

如果 tarball 回退到 `jixu`、缺少 `bin.jixu`、optionalDependencies 漂移，或任一包管理器无法生成 `jixu` executable，pack 或 clean-consumer acceptance 会失败。

## 5. 使用的技术

npm package metadata、pnpm workspace filters、exact-version optional dependencies、Publint、Are the Types Wrong，以及 npm、pnpm、Yarn、Bun 隔离消费者。

## 6. 验证证据

### Tests

- `node --test packages/jixu/test/cli-launcher.test.ts`：3/3 通过。
- `pnpm run check:release`：81/81 Node tests 与 OpenTUI smoke 通过。
- npm、pnpm、Yarn、Bun clean consumers 均从 `jixu-ai` tarball 安装，并通过 `jixu --version`、TypeScript 和 Node 22.19.0 smoke。

### Static checks

- build、typecheck、core architecture lint 和 `git diff --check` 通过。
- `JIXU_PUBLIC_RELEASE=1 pnpm run pack:packages` 生成 `jixu-ai@0.1.0-beta.0` host candidate，并保留相同的八个 host-visible `jixu-*` candidates。

### 关键断言

- facade registry name 是 `jixu-ai`。
- executable name 仍是 `jixu`。
- package version、native target names 和 Framework imports 没有变化。

## 7. 遇到的问题与经验

npm 的未注册查询与 `npm publish --dry-run` 都不足以证明一个 unscoped 新名称最终可写；package-similarity protection 只在真实 registry write 中返回。首次公开 facade 必须把真实 write 视为独立 acceptance boundary，并在失败后避免盲目重试。

## 8. 已知限制与风险

- 本地只能生成和执行 macOS arm64 candidate；macOS x64 与 Linux x64 必须继续由 target runners 重新聚合。
- `jixu-ai` 尚需通过真实 npm write；未注册状态不能替代发布成功证据。
- macOS beta native packages 保持 ad-hoc signature，不声明 Developer ID、notarization 或 Gatekeeper trust。

## 9. 下一阶段入口

推送当前提交，运行三平台 release candidate matrix。只发布聚合产物中的
`jixu-ai@0.1.0-beta.0` 到 `beta`，然后从 registry 做 clean install、`jixu --version`、
help 和 facade import 验收；已发布的十个依赖包不重复发布。

## 10. 文件索引

- `SPEC.md`
- `README.md`
- `package.json`
- `packages/jixu/package.json`
- `packages/jixu/src/cli-launcher.ts`
- `packages/jixu/test/cli-launcher.test.ts`
- `scripts/package-artifacts.ts`
- `scripts/verify-package-portability.ts`
