# RFC-591 技术设计

记号：`S/` = `packages/backend/src/`。数字取 HEAD `3f07d748a`。不改行为。

## 0. 架构落位与偏离项（RFC-294 第 8 条）

- **落位**：通用 git 进程运行器进 `S/platform/execution/local/gitProcess.ts`——与 `process.ts`（管道读取上限）、`platformExec.ts`（平台 spawn 选项）同层，
  它们本来就是 `runGit` 的依赖；它不认识仓库、工作树或快照，只管“以加固过的参数与非交互环境跑一次 git、能超时、能取消”。仓库语义（快照、回滚、工作树、
  子模块、合并树……）留在 `util/git.ts`，下一步整体归 source-control。
- **偏离项（经用户 2026-11-25 授权裁定，记为已确认）**：RFC-294 design §8 / §15 写 `util/git` 整份归 source-control；本 RFC 把其中的进程运行器放进
  platform。理由：它是厂商命令行客户端，不是仓库语义；platform 自己的版本探测、工作树备份与启动升级环境也要跑 git，而 platform 不依赖模块；整份归
  source-control 会逼出三条新 DAG 边（runtime-management、collaboration、system-operations → source-control）并把 platform 的三处挪到不属于它们的模块。
- **不动**：`util/gitHardening.ts`（暂缓的安全相邻一族），新文件照旧 import 它；`AW_INTERNAL_GIT_IDENTITY`、`initScratchRepo` 等仓库语义留在 `util/git.ts`。

## 1. 搬迁

- 新文件逐字收下 `util/git.ts` 里的 `GitRunResult`、`nonInteractiveGitEnv`（连同两段说明）、`runGit`（连同说明）与两个退出码常量，import 只带它们用到的
  `hardenGitArgs`、`platformSpawnOptionsForHost`、`raceWithFallback`。
- `util/git.ts` 删掉这几段，改从新文件取它自己要用的名字；不留转出。
- 读者：从 `util/git` 取这五个名字的 import 拆开，这五个改从新位置取（`@/` 别名的读者用别名，相对路径的读者用相对路径），其余名字照旧。

## 2. 门、用例与文档

- 读 `util/git.ts` 源码来断言运行器内容的用例改读新文件（超时 / 取消的那段逐字锁、spawn 站点账本、非交互环境、加固参数的接线、`util/git` 叶子锁的
  import 清单）。
- 新增 `T/rfc591-git-process-runner-into-platform-boundary.test.ts`，登记 guard-manifest：① 五个名字只在新文件定义，`util/git.ts` 不再导出它们；
  ② `src` / `tests` / `scripts` 里没有任何 import 从 `util/git` 取这五个名字（判据带负对照）；③ 新文件只 import platform 与 `util/gitHardening`，不取任何
  模块（判据带负对照）；④ 新文件里的运行器与 `util/git.ts` 旧版逐段相同的锚点（加固参数、非交互环境、进程组杀法）。

## 3. 失败模式

- **有人在 `util/git.ts` 里再写一份运行器**：用例 ① 红；`rfc284-git-twin-textlock` 也会要求两份逐字一致。
- **新文件取了模块**：用例 ③ 红，platform 的单向依赖规则也红。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：通用能力进 platform，仓库语义留给下一步归 source-control。**C12**：RFC-591 用例 ② 覆盖全部说明符，① ③ ④ 只读两个文件。**C13**：计数不升。
- **留下的债**：`util/git.ts` 余下的仓库语义整体归 source-control（下一步；其中跨模块的 6 个名字——`gitMetaDirsFor`、`withWorktreeRegistryLock`、
  `worktreeFilesChanged`、`gitCommitExists`、`rollbackToSnapshot`、`reclaimStaleRefLocks`——要定 collaboration 与 runtime-management 怎么取）。
