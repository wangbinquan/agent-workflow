# RFC-593 技术设计

记号：`S/` = `packages/backend/src/`，`SC/` = `S/modules/source-control/`。数字取 HEAD `12d8cfb6c`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：仓库语义的本机实现进 `SC/infrastructure/local/gitRepository.ts`，与 `gitSubmodule.ts`、`nodeIsolation.ts`、
  `repositoryMirrorCache.ts` 同层；它只 import platform（运行器、两个查询、错误、日志、哈希、目录回收）、shared 与本模块 domain。其中四段纯逻辑 / 数据——
  `AW_INTERNAL_GIT_IDENTITY`、`WorktreeCleanupProvenance`、`usableSubmodules`、`bottomUp`——进 `SC/domain/gitRepositoryModel.ts`：source-control 的
  application 层（冲突合并、候选交付、仓库提交、工作区改动发布、工作区物化）只用到这四段，迁到 infrastructure 之后再从那里取就成了 application →
  infrastructure（`module-layer-violations` 上限为 0）。
- **对外**：只有两个名字经 `SC/public/participants` 转出——`rollbackToSnapshot`（task-execution 的节点回滚；装配根把它交给 collaboration 的评审门回滚）
  与 `worktreeFilesChanged`（task-execution 的规范差异），签名不带回调与平台类型。task-execution 的延后准备照 RFC-447 / RFC-478 只经它自有的
  `TaskRepositoryPreparationBinding` 取 source-control：绑定多两个方法——`pruneWorktreeRegistry(repoPath)`（持 registry 锁 `worktree prune`）与
  `reclaimStaleRefLocks(...)`——由 source-control 的 `infrastructure/repositoryPreparationBridge.ts` 实现（它本来就实现这组绑定）。带回调的
  `withWorktreeRegistryLock` 留在模块内。
- **偏离项**：无（沿 RFC-591 已记的方案（b），这一步正是 design §8 / §15 的“`util/git` 归 source-control”）。

## 1. 搬迁与读者

- 整份迁入新位置（搬迁脚本改写全部说明符；之后检查字符串夹具里被误改的说明符并还原）；四段纯逻辑 / 数据逐字迁入 `SC/domain/gitRepositoryModel.ts`，
  新文件改从那里取，读者（application 五个、infrastructure 四个、用例）改指 domain。
- `SC/public/participants.ts` 转出 `rollbackToSnapshot`、`worktreeFilesChanged`；task-execution 的节点回滚、规范差异与 `bootstrap/crossContextClosure.ts`
  改从那里取。
- task-execution 的 `TaskRepositoryPreparationBinding` 多 `pruneWorktreeRegistry`、`reclaimStaleRefLocks` 两个方法，source-control 的绑定实现给出；
  `deferredRepositoryPreparation.ts` 改调绑定，不再 import source-control。
- source-control 自己的其余读者改取新文件；用例改取新文件。

## 2. 门、用例与文档

- 架构报告归属表删 `util/git.ts` 一行；`counts.json` 的 `legacy-horizontal-files` 上限 55 → 54。
- 读 `util/git.ts` 源码的用例改读新文件（`rfc377` 的叶子锁、`rfc254` 的平台面与 Windows 锁、`rfc287`、`rfc210`、`rfc243` 等，按检索清单逐个核对）。
- 新增 `T/rfc593-util-git-into-source-control-boundary.test.ts`，登记 guard-manifest：① 旧路径不存在，全部说明符不再解析到它（带负对照）；② source-control
  之外的生产文件只经 `SC/public/participants` 取新文件里的名字（带负对照）；③ `public/participants` 转出那 2 个名字；④ 新文件只取 platform、shared、node
  内置与本模块 domain（带负对照）。延后准备的持锁 prune 由 `rfc287` 锁住：重试回收调绑定，source-control 的绑定实现持锁。

## 3. 失败模式

- **有人在 `util/` 下再放一份 git**：用例 ① 与 legacy 计数红。
- **task-execution 直接取 source-control 的内部文件**：用例 ② 红，跨 context 内部文件对的计数也红。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：仓库语义进 owner 模块，通用运行器与查询在 platform。**C12**：RFC-593 用例 ① ② 覆盖全部说明符与生产文件，③ ④ 只读两个文件。
  **C13**：`legacy-horizontal-files` 55 → 54。
- **W5 的 `util/git` 收口**；`util/` 余下的都是暂缓的安全相邻一族。
