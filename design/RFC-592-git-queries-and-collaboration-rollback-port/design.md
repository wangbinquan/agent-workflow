# RFC-592 技术设计

记号：`S/` = `packages/backend/src/`，`CO/` = `S/modules/collaboration/`。数字取 HEAD `992ae6140`。不改行为。

## 0. 落位裁定（RFC-294 第 8 条）

- **两个只读查询进 platform**：`gitMetaDirsFor`（`rev-parse --git-common-dir / --git-dir`）与 `gitCommitExists`（`cat-file -e <sha>^{commit}`）只回答“这个工作树
  的 git 目录在哪”“这个对象在不在”，不认识快照的形状、工作树登记或分支——和 `gitVersion.ts` 一样是“经通用运行器问 git 一句话”，放
  `S/platform/workspace/local/gitQueries.ts`。runtime-management 由此不需要到 source-control 的边；collaboration 的快照检查器（含它的默认实现）也一样。
- **回滚经装配绑定交进来**：`rollbackToSnapshot`（先查快照在不在，再 `reset --hard`、`clean -fd`、`stash apply`）是工作区快照的语义，跟
  `snapshotFullState` 一起下一步归 source-control。collaboration 已有现成的形状：RFC-477 把节点回滚做成 collaboration 自有的端口，由装配根经
  `TaskExecutionParticipantBindings` 交进来（`createNodeRunWorkspaceRollback`）。评审门回滚执行器要的只是“把这个工作树回滚到这个快照”，同样作为这组绑定的
  一项（`rollbackWorkspaceToSnapshot`）由装配根给出——`composeGateContinuationSupport` 本来就收这组绑定（执行器的 `executionPermits` 也取自它），调用方
  不用改；collaboration 不认识任何 git 模块。
- **偏离项**：无（沿 RFC-591 已记的方案（b））。

## 1. 改动

- **`S/platform/workspace/local/gitQueries.ts`**：逐字收下 `gitMetaDirsFor`（连同说明）与 `gitCommitExists`（连同说明），只 import RFC-591 的 `runGit`。
- **`S/util/git.ts`**：删掉这两段，`rollbackToSnapshot` 等要用的 `gitCommitExists` 改从新文件取；不留转出。
- **读者**：从 `util/git` 取这两个名字的 import 拆开改指新位置（runtime-management 的两个代理材料构建器、collaboration 的快照检查器、task-execution、
  source-control 与用例）。
- **`CO/infrastructure/taskExecutionParticipantBindings.ts`**：绑定多一项
  `rollbackWorkspaceToSnapshot: (worktreePath: string, snapshot: string) => Promise<void>`。
- **`CO/infrastructure/gateWorkspaceRollbackExecutor.ts`**：构造参数多一项回滚函数，回滚改调它；不再 import `util/git`。
- **`CO/composition.ts`**：`composeGateContinuationSupport` 把 `input.taskExecutionParticipants.rollbackWorkspaceToSnapshot` 传给执行器（输入形状不变）。
- **装配**：`bootstrap/crossContextClosure.ts` 的 `composeTaskExecutionParticipantBindings` 给出 `rollbackWorkspaceToSnapshot: rollbackToSnapshot`（暂取自
  `util/git`，下一步改取 source-control）；用例的绑定 helper 与 `rfc359-w55` 的两份手写绑定同样补上这一项。

## 2. 门、用例与文档

- 新增 `T/rfc592-git-queries-and-collaboration-rollback-port-boundary.test.ts`，登记 guard-manifest：① 两个查询只在新文件定义，`util/git.ts` 不再导出它们；
  ② `src` / `tests` / `scripts` 里没有任何 import 从 `util/git` 取这两个名字（判据带负对照）；③ `CO/` 与 `S/modules/runtime-management/` 下没有任何文件
  import `util/git`（判据带负对照）；④ 执行器经绑定里的回滚函数回滚，`composeGateContinuationSupport` 把它传给执行器，装配根的绑定给出了实现。

## 3. 失败模式

- **有人在 collaboration 里又直接 import `util/git`**：用例 ③ 红（下一步 `util/git` 进 source-control 之后，跨 context 的规则也会红）。
- **装配漏给回滚函数**：绑定类型要求它，tsc 报错；用例 ④ 也锁着装配根那一处。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：通用查询进 platform，协作经装配绑定取回滚。**C12**：RFC-592 用例 ② ③ 覆盖全部说明符与两个模块目录，① ④ 只读相关文件。**C13**：计数不升。
- **留下的债**：`util/git.ts` 的仓库语义整体归 source-control（下一步），装配根届时改从 source-control 取 `rollbackToSnapshot`；task-execution 取的
  `withWorktreeRegistryLock`、`worktreeFilesChanged`、`rollbackToSnapshot`、`reclaimStaleRefLocks` 届时经 source-control 的 public（DAG 有这条边）。
