# RFC-592 两个只读 git 查询归 platform，协作的回滚经端口注入（RFC-294 W5 余项第四步：`util/git` 归 source-control 之前先断开 collaboration 与 runtime-management）

- **状态**：In Progress（2026-11-25）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：沿 RFC-591 裁定的方案（b），
  本会话自行裁定落位（见 design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §8 / §15 与 plan W5；上一步见
  [RFC-591](../RFC-591-git-process-runner-into-platform/proposal.md)。

## 1. 背景

`util/git.ts` 的仓库语义下一步整体归 source-control，但 DAG 里 collaboration 与 runtime-management 到 source-control 都没有边，而它们各取 `util/git` 的名字：
runtime-management 的两个代理材料构建器取 `gitMetaDirsFor`（一个工作树的共享 git 目录与 admin 目录，给沙箱放行）；collaboration 的回滚快照检查器取
`gitCommitExists`，评审门的工作区回滚执行器取 `rollbackToSnapshot`。

## 2. 目标

- **G1**：两个只读 git 查询——`gitMetaDirsFor`、`gitCommitExists`——逐字迁入 `platform/workspace/local/gitQueries.ts`（与 `gitVersion.ts` 同层，只经 RFC-591
  的运行器跑 git，不涉快照、工作树登记等仓库语义）；runtime-management、collaboration、task-execution、source-control 与 `util/git.ts` 自己改从那里取。
- **G2**：collaboration 的评审门回滚执行器不再取 `util/git`：`rollbackToSnapshot` 作为 `TaskExecutionParticipantBindings` 的一项（RFC-477 立的形状：
  collaboration 自有的工作区回滚能力由装配根经这组绑定交进来）传给执行器，装配根传 git 的实现；行为不变。
- **G3**：collaboration 与 runtime-management 的源码里没有任何对 `util/git` 的 import；计数不升；DAG 之外的边不增加。

## 3. 非目标

- `util/git.ts` 余下的仓库语义归 source-control（下一步）；回滚检查器的默认实现照旧（只是改用 platform 的查询）。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：两个查询只在新文件定义，`util/git.ts` 不再导出它们；新文件与原来那两段逐字相同；没有 import 再从 `util/git` 取它们。
- **AC-2**：collaboration 与 runtime-management 不 import `util/git`；评审门回滚执行器经注入的端口回滚，装配根与用例的装配都传了它；行为不变：评审回滚与
  沙箱放行的用例通过。
- **AC-3**：计数不升；DAG 之外的边不增加；新增 RFC-592 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
