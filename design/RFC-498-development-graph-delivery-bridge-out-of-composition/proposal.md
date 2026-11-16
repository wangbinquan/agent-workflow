# RFC-498 开发自动化的图交付桥用例迁出 composition（RFC-294 S10 第五步）

- **状态**：Done（2026-11-15，落地 `1aafddf1c`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围点名“`missionOperations.ts` / `configOperations.ts` / `graphDeliveryBridge.ts` 的命令处理按层归位”，退出门要求“上面点名的
  文件不再位于 `composition/`”；proposal D16、review-2026-11-09 R11 / F13。
- **前序**：[RFC-497](../RFC-497-development-mission-and-config-operations-out-of-composition/proposal.md)（S10 第四步，Done，`b01642940`）。
  S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只动 development-automation 的 `composition/graphDeliveryBridge.ts`
  （删除）与 `composition/graphDevelopment.ts` 里取它的一条 import 和一处调用，不碰 `taskImage*` / `crewstation*`。

## 1. 背景

RFC-497 之后，development-automation 的组合层控制流实测 195 行：`graphDeliveryBridge.ts` 62 行，是余下最多的一个；RFC-370 余项逐个
避让的 `taskImage*` / `crewstation*` 共 80 行；其余是 `graphDevelopment.ts` 14 行、`pipelineEvidence.ts` 9 行等。

`graphDeliveryBridge.ts`（704 行）只有一个用例 `createGraphDeliveryBridge`：图设计的数字员工 Case 验证通过后，把同一个工作区交给 MR
照看。它在 application 的 MR 照看（`createGraphMrCare`）之上组装交付的四个方法——准备交付（取冻结的实现依据，暂存并复核候选树，登记
工作区与候选，把图的临时上传搬进需求目录）、接续中断的交付、发布内容不变时复用已发布的交付、为后续验证给出已发布候选的原始父基线——
经 source-control 的参与方、本模块的持久化端口、图设计的存储 / 命令 / 执行端口与验证用例工作。唯一的装配方是同目录的 `graphDevelopment.ts`，它装配的
其余图开发用例（设计命令与查询、视图规划、执行消费、验证、局限复核、工作项）早就都在 `application/graph-development/`。

用例要离开 composition，只差两样：临时上传的搬运经 infrastructure 的 `withAutomationWorkspaceEffects` 开作用域（它先把传入的工厂再选定
一次）；默认时钟 `deps.now ?? Date.now`。

## 2. 目标

- **G1 用例归 application**：`createGraphDeliveryBridge` 连同它的类型与两个辅助函数原样迁入 `application/graph-development/deliveryBridge.ts`；
  开作用域改用 application 已有的 `withSelectedAutomationWorkspaceEffects`（传入的就是 bootstrap 选定的工厂）；时钟改为必填，由装配给。
- **G2 composition 不再有这个文件**：`composition/graphDeliveryBridge.ts` 删除；`graphDevelopment.ts` 与装配其余图开发用例一样直接从
  application 取这个用例，并交出默认时钟。S10 点名的这个文件由此不再位于 `composition/`。
- **G3 账本与锁**：取它的用例改取新位置；`composition-control-flow-development-automation` 按实测收紧；新增 RFC-498 用例。

## 3. 非目标

- `graphDeliveryLifecycle.ts` / `graphDeliveryJob.ts`（类型包一族，前者仍取 RFC-494 留在 composition 的登记对象）、`graphDevelopment.ts`
  其余的装配与控制流、`activityOperations.ts` 与 development-automation `composition/` 的其余文件；其他模块的 composition；S10 的全模块门。
- infrastructure 的 `createGraphEmployeeWorkspace` 与它的开作用域；`taskImage*` / `crewstation*` 一族（RFC-370 余项，逐个避让）。
- 拆分或改写交付用例；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在 `application/graph-development/deliveryBridge.ts` 声明；`composition/graphDeliveryBridge.ts` 不存在，
  没有文件从旧位置取名字；`graphDevelopment.ts` 从新文件取用例、恰好调用一次并交出默认时钟。
- **AC-2**：同样输入下交付四个方法与照看方法的返回、错误码、持久化与外部调用的次序和参数和此前一致（迁移逐字，现有用例对拍）；临时
  上传的搬运用的仍是装配时交来的同一个工厂。
- **AC-3**：新文件只取 shared、source-control 的 `public/types`、`@/util/gitRef` 与本模块的 domain / application，不取 infrastructure、
  composition、IO 包与进程全局；跨 context 边、public surface 不升；`composition-control-flow-development-automation` 收紧到实测，其余
  计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
