# RFC-593 `util/git` 的仓库语义整体归 source-control（RFC-294 W5 余项第五步，`util/git` 收口）

- **状态**：Done（2026-11-25，落地 `f48df41c2`，补正 `4e03ecce4`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：沿 RFC-591 裁定的方案（b）
  收口，本会话自行裁定落位（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §8 / §15 与 plan W5；前两步见
  [RFC-591](../RFC-591-git-process-runner-into-platform/proposal.md)、[RFC-592](../RFC-592-git-queries-and-collaboration-rollback-port/proposal.md)。

## 1. 背景

RFC-591 把通用运行器、RFC-592 把两个只读查询放进 platform，并断开了 collaboration 与 runtime-management 对 `util/git` 的取用。`util/git.ts`（3723 行）剩下的都是
仓库语义——工作树的建与清、快照与回滚、子模块、合并树、差异与文件列表——只 import platform 与 shared。它的生产读者只剩 source-control 自己（22 个文件）、
task-execution（3 个文件取 4 个名字：`rollbackToSnapshot`、`reclaimStaleRefLocks`、`withWorktreeRegistryLock`、`worktreeFilesChanged`）与装配根（取
`rollbackToSnapshot` 交给 collaboration）。

## 2. 目标

- **G1**：`util/git.ts` 整份逐字迁入 `modules/source-control/infrastructure/local/gitRepository.ts`，旧位置不留转出。
- **G2**：其他模块要的能力按已有的规则取：task-execution 的节点回滚与规范差异、装配根（交给 collaboration 的评审门回滚）取
  `rollbackToSnapshot`、`worktreeFilesChanged`，经 source-control 的 `public/participants`（DAG 上 task-execution → source-control 是
  offered-consumption）；task-execution 的延后准备照 RFC-447 / RFC-478 的规则不直接取 source-control——它要的持锁 `worktree prune` 与陈旧 ref
  锁清理成为它自有的准备绑定（`TaskRepositoryPreparationBinding`）的两个方法，由 source-control 的绑定实现给出。新文件里四段纯逻辑 / 数据（内部提交
  身份、工作树清理来源、子模块的过滤与排序）进 source-control 的 `domain/`，application 层从那里取——应用层不取 infrastructure。
- **G3**：`legacy-horizontal-files` 55 → 54；计数不升；DAG 之外的边不增加；行为不变。W5 的 `util/git` 收口。

## 3. 非目标

- `util/` 下暂缓的安全相邻一族（`gitHardening`、凭据、文件信任、Windows ACL、OIDC、脱敏、安全路径、`gitRef`）。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：`util/git.ts` 不存在，全部源码、用例与脚本不再取它；新文件与它逐字相同，只差文件头说明与迁进 `domain/gitRepositoryModel.ts` 的四段
  纯逻辑 / 数据。
- **AC-2**：source-control 之外只经 `public/participants`（两个名字）或 task-execution 自有的准备绑定取；source-control 的 application 层不取
  infrastructure；行为不变：git / 工作树 / 快照 / 子模块相关用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 55 → 54；`public-surface-deviations` 不升（28 → 27）；`module-layer-violations` 保持 0；未消费 public 符号
  0；DAG 之外的边与跨 context 内部文件对不增加；新增 RFC-593 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
