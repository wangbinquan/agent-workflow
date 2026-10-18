# RFC-377 util/git 叶子化与 `KNOWN_VIOLATIONS` 清零（RFC-294 S8）

- **状态**：In Progress（2026-10-17 立项；用户授权设计完成后直接交 Codex 执行，免设计门与实现门，由本会话审核执行正确性）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S8（W5 的一部分）
- **基线**：HEAD `b76a88e70`（文中行号均按该提交，实施时以当时源码为准）
- **落位**：source-control 目标 context 的 git 原语层（`util/git` 只做叶子化，物理迁入 `modules/source-control/infrastructure` 属 W5 余项）；shared `outputKinds`；frontend `node-session`

## 1. 背景

`scripts/depcheck.ts` 的 `KNOWN_VIOLATIONS` 在 HEAD 有 7 条存量违规，后端值级 SCC 为 1、全仓值级 SCC 为 3（[status.md](../RFC-294-backend-layered-target-architecture/status.md) §1）：

| 条目 | 规则 | 来源 |
| --- | --- | --- |
| `services/gitRepoCache.ts → util/git.ts` | no-circular | git 环族 |
| `services/gitRepoCache.ts → services/gitVersion.ts` | no-circular | git 环族 |
| `services/gitSubmodule.ts → util/git.ts` | no-circular | git 环族 |
| `util/git.ts → services/gitSubmodule.ts` | no-util-to-upper | git 环族 |
| `util/git.ts → services/gitRepoCache.ts` | no-util-to-upper | git 环族 |
| `shared outputKinds/list.ts → registry.ts` | no-circular | shared |
| `frontend node-session/ConversationFlow.tsx → SubagentBlock.tsx` | no-circular | frontend |

三组环的根因：

- **git 环族**：`util/git.ts` 用 10 处 `await import('@/services/git…')` 反向取子模块能力。被取的 7 个符号里，6 个
  （`syncSubmodules`、`readDeclaredSubmodulePaths`、`attachSubmoduleFromPool`、`resolveSubmodulePool`、`snapshotSubmodule`、
  `subSlug`）本身就是只依赖 `runGit` / fs / shared 的 git 原语，只是为了避环才放在 `services/gitSubmodule.ts`
  （该文件 L167-173 的注释写明了这一点）；唯一真正的上层依赖是 `services/gitRepoCache.ts` 的 `resolveSubmoduleParams`
  ——它读 `config.json` 并读 `services/gitVersion.ts` 的进程内能力缓存。
- **shared**：`list.ts` 值引用 `registry.ts` 的三个函数，`registry.ts` 又默认导入 `list.ts` 的 handler 并注册；
  `listWire.ts:1-11` 记录过 `bun build --compile` 下 handler 数组看到 `undefined` 的初始化顺序事故。
- **frontend**：`ConversationFlow` 渲染 `SubagentBlock`，`SubagentBlock` 又渲染嵌套的 `ConversationFlow`，并从
  `ConversationFlow.tsx` 取 `RoleBadge`。

另有陈旧文字：RFC-294 plan / review 写「8 条」（RFC-370 `166e918bd` 改变环形状时已删去一条）；depcheck 头注释、
cruiser 注释里的计数与已被 RFC-308 删除的 `buildGitignoreBlock` 仍在被引用。

## 2. 目标

- **G1** `util/git.ts` 不 import `services/`、`modules/`、`platform/`、`bootstrap/`、`cli/`、`routes/` 等任何上层路径
  （值、类型、动态 import、re-export 都算），只依赖 `util/*` 与 `@agent-workflow/shared`。
- **G2** 后端值级 SCC = 0，全仓值级 SCC = 0。
- **G3** `KNOWN_VIOLATIONS` 删除上表 7 条，`.dependency-cruiser.cjs` 中对应的 `@ledger KNOWN_VIOLATIONS` 标记删除；
  清单里不再有任何 `no-circular` / `no-util-to-upper` 条目。
- **G4** 零行为变化：子模块策略的优先级（显式参数 → 设置 → 默认 → 能力钳制）、解析时机（含 `createWorktree`
  在解析抛错时的清理）、shared handler 的顺序与行为、前端 DOM / 类名 / 文案全部不变。
- **G5** 更正上述陈旧文字。

## 3. 非目标

- 不把 `util/git.ts` 物理迁入 `modules/source-control/infrastructure`（成本与理由见 design §5，属 RFC-294 W5 余项）。
- 不扩宽 `no-util-to-upper` 规则覆盖 `modules|platform|bootstrap`（留给 RFC-376 或后续）。
- 不处理 `isInlineMd` 三份重复（commons F3）。
- 不做任何安全相关改动（仓库硬规则）。

## 4. 用户故事

- 作为后端开发者，我修改 git 原语时不必再顾及「util 反向依赖 services」的惰性 import 约束，也不会再因初始化顺序踩坑。
- 作为架构维护者，我看到后端与全仓的值级 SCC 都为 0，`KNOWN_VIOLATIONS` 里不再有 W5 存量，RFC-294 §14 的两项终局判据
  达成。

## 5. 验收标准

- **AC-1** `util/git.ts` 不含任何指向上层路径的 import（含 type / dynamic / re-export），由新的锁测试断言，锁测试带负例。
- **AC-2** `bun run depcheck` 通过；`KNOWN_VIOLATIONS` 不含 `no-circular` / `no-util-to-upper` 条目；后端与全仓值级 SCC 为 0。
- **AC-3** 子模块策略注入：四个子模块感知入口各调用一次注入的 resolver，入参为调用方的 `submoduleMode` / `submoduleJobs`；
  `createWorktree` 在 resolver 抛错时仍执行清理；两处生产调用点传入 `gitRepoCache.resolveSubmoduleParams`；配置为
  `never` 与默认时的生产行为有测试。
- **AC-4** `services/gitSubmodule.ts` 门面再导出的函数与 `util/git.ts` 中是同一对象。
- **AC-5** shared：list handler 由 registry 注入构造；`PARAMETRIC_HANDLERS` 顺序与 list 行为不变。
- **AC-6** frontend：`SubagentBlock` 通过 `children` 渲染嵌套流，折叠时不渲染、展开后 DOM 与类名不变；`RoleBadge`
  抽为独立文件；现有 node-session 测试全绿。
- **AC-7** design §6 列出的既有测试全绿；推送后按 exact SHA 的 GitHub Actions 结论为准。

## 6. 能力影响

无。纯依赖方向重构，不收缩任何既有能力。
