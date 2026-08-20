# 阶段 04：M2.2 Package Portability Gate

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| Milestone | M2.2 — Package Portability Gate |
| 状态 | Completed and accepted；已进入 `main`（`e786be9`） |
| 关联需求 | `SPEC.md` §16 Package boundaries |
| 关联验收 | `JX-AC-017` |

## 1. 阶段目标与边界

### 要解决的问题

Jixu 的 source workspace 通过 pnpm symlink 和 TypeScript source 运行，不能证明用户安装 package
后仍能使用。旧 package export 指向 `.ts`，部分 adapter 还跨包引用 `../../core/src`；这些路径
在 monorepo 内存在，进入 `node_modules` 后不成立。

本阶段把 package portability 提前到 M2.2：构建一次真实 `.tgz` 集合，让 npm、pnpm、Yarn、
Bun 在四个隔离 consumer 中安装完全相同的文件，完成类型检查，并在最低支持 Node 版本上
执行普通 Harness/Thread public path。

### 本阶段完成

- 为 7 个当前 package 建立 TypeScript composite build graph，生成 ESM JavaScript 和 `.d.ts`；
- package export 只指向 `dist/*.js` 和对应 `dist/*.d.ts`；
- source workspace 保留 `workspace:*`，packed manifest 自动转换为普通 exact version；
- JSONL、SQLite、testkit 通过正式 `jixu-core` package boundary 导入；
- 同一 tarball 集依次进入 npm、pnpm、Yarn 4.18 和 Bun 临时 consumer；
- 每个 consumer 都检查 installed manifest、TypeScript public API，并完成 deterministic
  Harness/Thread smoke；
- 加入 Publint 与 Are the Types Wrong 检查；
- 增加 `pnpm run pack:packages`、`pnpm run test:packages` 和 `pnpm run check:release`。

### 本阶段明确不做

- 不启动本地或远程 package registry；
- 不执行 `npm publish` 或模拟发布；
- 不决定正式 version、dist-tag、provenance、2FA 或 release channel；
- 不宣称已经验证 public registry dependency graph；
- 不构建 standalone executable，不承诺 CommonJS；
- 不提交 build output、candidate tarball 或 consumer lockfile；
- 不增加 registry publication、authentication、examples 或 release automation。

## 2. 为什么这样设计

### Workspace green 不等于 package green

Node 不会替第三方 package 承担 `node_modules` 内 TypeScript source transpilation。更重要的是，
workspace 的相对 source 路径不会出现在独立 tarball 中。因此验收起点必须是真实 packed artifact，
不能只是 workspace import 或 source test。

### 一次 pack，四次 install

如果每个 manager 各自 build 或 pack，失败时无法判断是 installer 差异还是 artifact 差异。当前
流程先生成 7 个 tarball，记录每个 artifact 的 SHA-256，再把同一组 absolute `file:` URL 写入
四个临时 consumer。

不同验收运行之间暂不保证 gzip metadata 的 bit-for-bit reproducibility；M2.2 保证的是单次
验收内四个 manager 使用同一组 bytes。

### 未发布多包图需要 fixture resolver 映射

packed package 的内部依赖必须是普通 semver，例如
`jixu-llm -> jixu-core@0.0.0`。因为 `jixu-core@0.0.0` 尚未发布，严格 resolver 会正确地去
公共 registry 查询并得到 404。

为了只验证本地 tarball 安装能力，临时 consumer 将这些 semver 精确映射回本轮 tarball：

- npm 能自然复用顶层同版本 tarball；
- pnpm fixture 使用临时 `pnpm-workspace.yaml#overrides`；
- Yarn fixture 使用 `resolutions`；
- Bun fixture 使用 `overrides`。

这些映射只存在于系统临时目录，不进入 packed package，也不构成用户运行时路径。它诚实地验证
“四种 manager 能消费相同 artifact”，但不替代未来真实 registry publish/install 验收。

### Source manifest 是 release metadata 的单一来源

每个 package 的 `package.json` 同时定义开发 dependency、release metadata、`exports`、`files`、
`engines` 和 repository 信息。`pnpm pack` 负责标准 `workspace:` 转换；脚本不维护第二份手写
publication manifest，只检查 packed 结果与 source metadata 一致。

## 3. 架构与执行模型

```text
pnpm source workspace
  |
  +-- package.json + workspace:* dependencies
  +-- tsc composite build -> ignored dist/ + declarations
  `-- pnpm pack once -> 7 tarballs + SHA-256 manifest
                         |
             +-----------+-----------+-----------+
             |           |           |           |
            npm         pnpm        Yarn         Bun
             |           |           |           |
             `---- isolated temporary consumers --'
                              |
                   installed manifest + tsc
                              |
              minimum-Node Harness/Thread smoke
```

本阶段没有引入第二个 Thread authority。consumer smoke 仍走唯一执行模型：

```text
input Event -> Reducer -> model Effect -> deterministic Driver -> outcome Event
```

package manager、tarball、fixture resolution 和 lockfile 只决定代码如何抵达 `node_modules`，不参与
Harness、Agent、Thread、Event、State 或 Effect 语义。

## 4. 实现方式

### Build 与 artifact gate

- 根 `tsconfig.build.json` 通过 project references 按依赖顺序构建所有 package；
- 每个 package 的 `tsconfig.build.json` 使用相同 `tsconfig.release.json` 基线；
- `scripts/package-artifacts.ts` 调用 `@publint/pack` 的 pnpm pack 路径；
- unpack 后检查 release metadata、dependency 转换、exports、files 和敏感内容边界；
- 任意 `workspace:`、source export、缺失 `.js`/`.d.ts`、`src/`、`test/` 或 `.tsbuildinfo`
  进入 tarball 都会 fail closed；
- 每个 tarball 再经过 Publint 和 ATTW 的 ESM-only profile。

### 四 manager consumer

`scripts/verify-package-portability.ts` 为每个 manager 创建独立临时目录，写入：

- 指向本轮 exact tarball 的 dependencies；
- 只用于未发布内部包的本地 resolution；
- 独立 cache、lockfile 和空 `.npmrc`，避免继承用户 token；
- 相同的 `types.mts`、`tsconfig.json` 和 `smoke.ts`。

安装后脚本逐个读取 `node_modules/<package>/package.json`，确认 name、version 和无
`workspace:`。TypeScript consumer 覆盖所有 public package 与 testkit subpath；runtime smoke
实例化 JSONL、SQLite、Node Tools、unified LLM adapter 和 `jixu` facade，并完成普通
Harness/Thread path。

### Node floor

M2.2 验收时，runtime smoke 使用
`pnpm --package=node@22.18.0 dlx node` 解析 exact binary，并先断言 `process.version`，
证明当时的最低版本承诺。SPEC 0.4.2 后，当前 floor 已提高到 Node 22.19.0；现行
`scripts/verify-package-portability.ts` 会解析并断言精确的 22.19.0 binary。本文保留
22.18.0 作为历史验收事实，不把它表述为当前兼容性承诺。

### Failure path

- build、pack、Publint 或 ATTW 失败：立即停止，不进入 manager install；
- manager install 失败：保留 manager 原生命令、exit code、stdout/stderr；
- installed manifest、typecheck 或 Harness/Thread smoke 失败：报告对应 manager；
- 任一步骤结束后递归删除唯一临时 root；
- repository 只保留 canonical `pnpm-lock.yaml`，generated `dist/` 与 `.artifacts/` 被忽略。

## 5. 使用的技术

- TypeScript 6.0.3 composite project references、ESM 与 declaration emit；
- Node.js 24.14.0 负责编排；M2.2 验收使用 Node.js 22.18.0 执行当时的最低版本
  smoke，当前 gate 使用 Node.js 22.19.0；
- npm 11.9.0、pnpm 11.12.0、Yarn 4.18.0、Bun 1.3.14；
- `@publint/pack`、Publint、`@arethetypeswrong/cli`；
- Node `child_process`、`fs/promises`、`crypto`、file URL 和系统临时目录；
- Node test runner 与现有 OpenTUI/Bun renderer regression。

## 6. 验证证据

最终验收命令：

```text
node --check scripts/package-artifacts.ts
node --check scripts/verify-package-portability.ts
pnpm run check:release
pnpm peers check
git diff --check
```

结果：

- 7 个 package 的 build、pack、Publint、ATTW 全部通过；
- npm、pnpm、Yarn、Bun clean install 全部通过；
- 四个 installed-package TypeScript consumer 全部通过；
- 四个 Node 22.18.0 ordinary Harness/Thread smoke 在当时全部通过；
- targeted Store contract tests：14 passed，0 failed；
- 完整 Node regression：44 passed，0 failed；
- OpenTUI renderer smoke passed；
- architecture lint、typecheck、`git diff --check` passed；
- peer check 仅保留已知 OpenTUI 间接依赖对 TypeScript `^5` 的声明告警。

## 7. 遇到的问题与经验

### pnpm 不会用顶层 file dependency 自动替代 transitive semver

npm 能把顶层 `jixu-core` tarball 复用于同版本内部依赖；pnpm 11 会严格解析 transitive
`jixu-core@0.0.0` 并访问 registry。第一轮因此得到预期 404。pnpm 11 还明确不再读取
`package.json#pnpm.overrides`，所以 fixture 的 override 必须放在临时 `pnpm-workspace.yaml`。

这说明 package-manager portability 不能只测顶层安装成功，也必须覆盖内部 package graph。

### Module identity 不适合作为跨 package contract

完整回归曾发现同一个公开 Store conflict error 在 source 与 dist package instance 间具有不同
prototype。错误语义完全相同，但 `instanceof` 依赖 module identity。Store contract 改为检查
稳定公开 `code`，既保留 typed failure 语义，也能跨 package instance 和 realm 工作。

### Yarn cache 与 age gate 必须隔离

Yarn fixture 使用独立 local/global cache 和 `node-modules` linker。Jixu tarball 是本地文件，不再
需要对 Jixu package 做 age preapproval；只有当前外部 dependency `openai@7.5.0` 保留 exact
preapproval。未来若正式发布，registry age 行为需要在独立 release boundary 内重新验证。

## 8. 已知限制与风险

- 当前只验证 ESM import，不验证 CommonJS `require()`；
- `openai@7.5.0` 仍从公共 registry 获取，因此不是完全 offline acceptance；
- local resolution 证明 installer 能消费 tarball，不证明真实 public registry metadata、dist-tag、
  provenance 或权限配置；
- package version 仍为 workspace 阶段的 `0.0.0`；
- standalone TUI executable 与 public installation command 不在本轮范围；
- 未来若进入 registry publication，仍需对真实发布后的 bytes、dependency graph 和 install
  experience 做独立验收；当前 local tarball gate 不替代它。

## 9. 下一阶段入口

M2.2 已由维护者验收并通过 `e786be9` 进入 `main`。后续 package 工作继续以本地 tarball gate
验证 npm、pnpm、Yarn 与 Bun consumer；registry publication、standalone executable、正式
versioning 与 release automation 仍是独立边界，不能由本阶段结果代替。

## 10. 文件索引

- `SPEC.md`：§16 Package boundaries、`JX-AC-017`；
- `tsconfig.release.json`、`tsconfig.build.json`、各 package `tsconfig.build.json`：build graph；
- `scripts/package-artifacts.ts`：一次 build/pack 与 artifact gate；
- `scripts/verify-package-portability.ts`：四 manager、types、minimum-Node smoke；
- `packages/*/package.json`：单一 release metadata 与 package boundary；
- `packages/testkit/src/store-contract.ts`：跨 package instance 的稳定错误语义断言；
- `README.md`：M2.2 使用方式与未发布边界。
