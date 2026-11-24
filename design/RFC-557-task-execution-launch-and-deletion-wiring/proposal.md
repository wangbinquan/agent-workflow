# RFC-557 工作组启动资源面归 resource-catalog，本地删除选择由 bootstrap 装配（RFC-294 S9 第十二步）

- **状态**：In Progress（2026-11-23）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9 第 5 项（跨 context 内部文件对）与 design §14
  “跨 context 内部文件对 → 0”、“bootstrap 唯一装配”；工作组那半沿用 [RFC-470](../RFC-470-workflow-facades-retirement/proposal.md)（代理启动资源面
  迁入 resource-catalog）与 [RFC-556](../RFC-556-provider-ports-through-designated-adapters/proposal.md)（provider 经指定 adapter 取 consumer 的
  required-ports）。

## 1. 背景

跨 context 内部文件对（10 条）里 task-execution 还剩三条：

| #   | 文件                                                                 | 取的内部                                                                  |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | task-execution `infrastructure/workgroupLaunchResourceOperations.ts` | resource-catalog `composition/resourceAcl`（`canViewResource`）           |
| 2   | 同上                                                                 | resource-catalog `infrastructure/legacy/workgroups`（`getWorkgroupById`） |
| 3   | task-execution `composition/taskDeletionEffects.ts`                  | source-control `composition`（`createGitTaskDeletionRepositoryEffects`）  |

1、2 是工作组启动的资源面：读工作组行、按 ACL 判可见、查名册成员是否存在——全是 resource-catalog 的能力，实现却放在 task-execution；它的代理孪生
（`agentLaunchResourceOperations.ts`）已由 RFC-470 迁入 resource-catalog、由装配根交给 task-execution。两条也是 `rfc328` 的 provider-bridge 精确债务。
3 是 standalone 部署的删除效果选择：task-execution 的 composition 自己去 source-control 的 composition 拿 git 工作区参与者，而跨 context 的选择应由
bootstrap 装配。

## 2. 目标

- **G1**：工作组启动资源面原样迁入 resource-catalog（`infrastructure/workgroupLaunchResourceOperations.ts` 与 `composition/workgroupLaunchResources.ts`，
  与代理那份并排）；端口仍归 task-execution，经 task-execution 的 `composition/required-ports.ts` 交出，resource-catalog 只在新增的指定 adapter
  `application/adapters/task-execution-adapter.ts` 里按类型取它；bootstrap 与用例改从 resource-catalog 的 composition 取。
- **G2**：`composeLocalTaskDeletionEffects` 改为接收仓库参与者；standalone bootstrap 把 source-control 的 git 参与者交进去；用例经新的测试助手
  `composeStandaloneTaskDeletionEffects()` 取同一对组合。
- **G3**：目标 DAG 与 RFC-294 design §3.1 的 Mermaid 同批登记虚线边 resource-catalog implements `WorkgroupRouteLaunchResources` → task-execution。
- **G4**：跨 context 内部文件对 10 → 7；`rfc328` 的 provider-bridge 债务销去两条；精确清单与减速带随之降低，其余计数不升。
- **G5 结局不变**：同样的读法、ACL 判据与名册检查；standalone 的删除效果仍是本地运行文件加 git 工作区 / 快照引用。

## 3. 非目标

- 其余 7 条跨 context 内部文件对（code-capability → resource-catalog 两条、integration → task-execution 的源终止能力两条、integration → event-center、
  intent → resource-catalog 两条）；代理启动资源面那份自写的端口形状（RFC-470）改走 required-ports（另案）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 不再取 resource-catalog 与 source-control 的非 public 文件，只有指定 adapter 按类型取它们的 required-ports；工作组启动资源面
  在 resource-catalog；`composeLocalTaskDeletionEffects` 不再取 source-control。
- **AC-2**：行为与装配结局不变（工作组启动、定时 / webhook 委派启动与删除恢复的既有用例照常通过）。
- **AC-3**：目标 DAG 与 design 的 Mermaid 同批登记新虚线边；跨 context 内部文件对 10 → 7，`rfc328` 债务、精确清单、`counts.json`、design 边总数与读旧
  路径的用例随之更新；新增 RFC-557 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
