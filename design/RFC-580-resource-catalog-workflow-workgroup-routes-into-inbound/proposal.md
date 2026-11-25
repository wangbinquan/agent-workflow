# RFC-580 resource-catalog 的工作流、工作组任务房间与资源包路由归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第五批）

- **状态**：In Progress（2026-11-25）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」，2026-11-25「继续」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；
  不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2 与 plan §4.6 W9-D；前四批见 RFC-576～RFC-579
  （[RFC-579](../RFC-579-collaboration-development-automation-routes-into-inbound/proposal.md)）。

## 1. 背景

RFC-579 之后 `routes/` 还剩 29 个文件，其中 resource-catalog 的路由最多（八个）。按 RFC-578 design §3 的口径推算，八个一起迁要撤回 92 个 public 符号
（五层），其中 86 个是 public 文件里的**声明**，不是转出行——要给它们在模块里找落位。本 RFC 先做工作流、工作组任务房间与资源包三个
（`workflows`、`workgroupTasks`、`resourcePackages`），撤回 22 个，全是声明：工作流的操作描述合同及其四个输入、两个回执（7 个），工作组任务房间的
模块合同、命令 / 查询端口及其 11 个提交 / 回执类型（14 个），`PackageResourceKind`（domain 里本来就有一份相同的声明）。

**暂留的 `workgroups`**：工作组路由取 task-execution `public/commands` 的 `WorkgroupRouteTaskLaunchOperations`（从工作组启动任务）。它留在
`routes/` 时是 legacy 入边；迁进 resource-catalog 就成了 resource-catalog → task-execution 的 offered 消费，而 RFC-294 design §3.1 的 DAG 里这一对只有
required-implementation（resource-catalog 实现 task-execution 要的端口），`rfc294-review-offered-edge-dag` 会红。要么补 DAG 边、要么改成 consumer-owned
端口、要么换落位，是总纲层面的决定，留给用户确认（第一次实施时迁了它，集中验证里撞上这条门，退回）。代理、MCP、技能与插件四个路由同样取
task-execution 的 `public/commands`，一并等这个决定。

## 2. 目标

- **G1**：三个路由原样迁入 `modules/resource-catalog/inbound/http/`（`workflowRoutes.ts`、`workgroupTaskRoutes.ts`、`resourcePackageRoutes.ts`），挂载
  函数经模块的 `composition.ts` 转出，`server.ts` 改从那里取；旧位置不留转出。
- **G2**：22 个只被这些路由（及其连带）用的 public 声明移进模块内部（design §1 的三个落位），public 文件不再声明它们，读者改取新位置。
- **G3**：`legacy-horizontal-files` 77 → 74；其余计数不升（未消费 public 符号保持 0）；行为不变。

## 3. 非目标

- `workgroups` 与代理、MCP、技能、插件的路由（§1）；task-execution 的路由；identity-access 与凭据相邻的路由；task-catalog；路由传输工具归位；改动被
  移动的声明的形状。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：三个旧路径不存在，全部源码、用例与脚本不再取它们；新文件与原文件只差 import 说明符。
- **AC-2**：行为不变：`server.ts` 的挂载调用与顺序不变；路由清单与既有路由用例通过；22 个声明逐字移动，形状不变。
- **AC-3**：`legacy-horizontal-files` 上限 77 → 74；未消费 public 符号保持 0；public 类型偏差不变；DAG 之外的边不增加；架构报告的归属表删去三行；
  新增 RFC-580 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
