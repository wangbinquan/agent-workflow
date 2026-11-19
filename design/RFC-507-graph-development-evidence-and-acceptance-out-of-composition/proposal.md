# RFC-507 开发自动化的图开发执行端口、证据与验收迁出 composition（RFC-294 S10 第十四步）

- **状态**：In Progress（2026-11-18）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294
  总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话
  按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  退出门要求组合层“无循环与 switch，`try` 与 `throw` 只出现在登记清单内”的门对全部模块为绿，各模块 `composition/` 的分支计数不高于经确认的
  上限。
- **前序**：[RFC-506](../RFC-506-password-reset-and-catalog-actor-binding-out-of-composition/proposal.md)（S10 第十三步，Done，`88011e010`）；development-automation
  的前五步是 RFC-494～498。S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只改 development-automation 的
  `composition/graphDevelopment.ts`，新增 `application/graph-development/` 下两个文件；装配入口 `composeGraphDevelopment` 的名字、签名、
  返回形状与位置不变，bootstrap、路由与用例的 import 不改；不碰 `crewstation*` / `taskImage*`（RFC-370 余项）。

## 1. 背景

RFC-506 之后，development-automation 组合层的控制流（F13 口径）共 133 行，非 RFC-370 的部分是 10 个文件 53 行；其中**循环只有 4 处**、
`try` 4 处，S10 的门不允许它们留在组合层。`graphDevelopment.ts` 一个文件就占 14 行（3 处 `for`、1 处 `try`、3 处 `throw`），
因为装配入口 `composeGraphDevelopment` 里内联写着几组用例：

- 设计执行端口（`GraphDesignExecutionPort`）的实现：读执行事实映射为已提交的产物、核对材料可读（逐个比对文件路径与摘要，缺一个就抛
  `graph-material-unreadable:<path>`）、从员工案例的投影里解析目标分支再解析仓库基线、取续作工作区的基线；
- 验证档案的两种列表（交给员工工作区的带内容，交给路由的只带摘要）；
- 证据与验收：最近一次完成的验证、当前证据目标（暂存候选、读环境摘要、`finally` 里清理候选）、证据投影（汇总已发布档案与已批准工作钉住的
  档案修订的摘要）、人工验收（候选与依据不符、义务无效时抛错，已完成的记录直接返回，否则写验收产物、证据链接并结束记录）、请求验证与导出依据。

其余是装配：建 store、产物、命令、查询、规划、验证、交付桥与平台工作项，并把它们交给路由与员工工作区。员工案例详情投影
（`detailProjection`）没有 F13 口径的控制流，它依赖的 `employeeCaseDetailProjection.ts` 与 `digitalEmployeeWorkspace.ts` 仍在组合层，随
后继一并处理。

## 2. 目标

- **G1 用例归位**（函数体逐字不变）：
  - 设计执行端口的实现迁入 `application/graph-development/designExecution.ts`（`createGraphDesignExecution`）；装配后才建的执行消费、员工工作区
    与交付桥由装配以转发函数交入（与现有的 `continuationWorkspace: (designId) => care.continuationWorkspace(designId)` 同一做法）。
  - 证据、验收与两种档案列表迁入 `application/graph-development/evidenceAcceptance.ts`（`createGraphEvidenceAcceptance` 与
    `listGraphVerificationProfileContents`）。
- **G2 composition 只装配**：`graphDevelopment.ts` 保留装配入口，从新位置取实现，不再有 F13 口径的控制流；交给路由的对象字段名与签名不变。
- **G3 账本与锁**：`composition-control-flow-development-automation` 133 → 119（按实测）；钉着交付桥装配字段的 RFC-498 用例不改且仍通过；
  新增 RFC-507 用例。

## 3. 非目标

- `detailProjection` 与它依赖的 `employeeCaseDetailProjection.ts`、`digitalEmployeeWorkspace.ts`；development-automation 其余非 RFC-370
  文件（`pipelineEvidence.ts`、`developmentDelivery.ts` 等，后继）；`crewstation*` / `taskImage*`（RFC-370 余项）；其余模块。
- 改写任何判据、错误类型与错误串；任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的新位置声明；`graphDevelopment.ts` 没有 F13 口径的控制流，从新位置取实现；装配入口与它交出的
  对象（字段名与签名）不变。
- **AC-2**：同样输入下，执行端口、证据、验收、请求验证与档案列表的结果、错误与对端口的调用和此前一致：
  - 材料核对缺一个文件或摘要不符就抛同一个错误，全部可读时不抛；
  - 证据投影的档案摘要表与此前相同（已发布档案按 id 与 `id@修订` 两种键，已批准工作钉住的修订按原修订）；
  - 验收：候选或依据不符、义务为空或不是人工义务时抛同样的错误；同一请求已完成时返回原记录而不再写；
  - 当前证据目标在候选暂存成功时总会清理，读环境摘要失败也一样。
- **AC-3**：新位置的依赖面是闭集：两个新文件只取 shared、zod、本模块的 domain、application 与 `application/ports`、source-control 的 public
  类型，不取 infrastructure、composition、bootstrap 与 IO 包，不用进程全局；public surface 不升；`composition-control-flow-development-automation`
  收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
