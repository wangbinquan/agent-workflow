# RFC-508 开发自动化的流水线证据端口与 MR 事实采集迁出 composition（RFC-294 S10 第十五步）

- **状态**：Done（2026-11-19，落地 `f07489c9c`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294
  总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话
  按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  退出门要求组合层“无循环与 switch，`try` 与 `throw` 只出现在登记清单内”的门对全部模块为绿，各模块 `composition/` 的分支计数不高于经确认的
  上限。
- **前序**：[RFC-507](../RFC-507-graph-development-evidence-and-acceptance-out-of-composition/proposal.md)（S10 第十四步，Done，`fa4398837`）；
  development-automation 的前六步是 RFC-494～498 与 RFC-507。S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只改
  development-automation 的 `composition/pipelineEvidence.ts` 与 `composition/developmentDelivery.ts`，新增 application 下两个文件，并在
  `application/ports/reconcilerPorts.ts` 增一个端口类型；四个装配入口的名字、签名、返回形状与位置不变，bootstrap 与用例的 import 不改；
  不碰 `crewstation*` / `taskImage*`（RFC-370 余项）。

## 1. 背景

RFC-507 之后，development-automation 组合层的控制流（F13 口径）共 119 行，非 RFC-370 的部分是 9 个文件 39 行；**循环只剩一处**，在
`pipelineEvidence.ts`。这个文件与 `developmentDelivery.ts` 合占 17 行，都是开发交付的依赖在装配入口里内联的实现：

- `pipelineEvidence.ts` 9 行：装配入口 `composeSelectedDevelopmentPipelineEvidence` 先逐个核对 collect / trigger / rerun 三个暂存工厂
  （`for`），再交出流水线证据端口（`PipelineEvidencePort`）的实现：每个操作先分配一份暂存、核对它属于该工厂的命名空间，带着暂存引用调用
  integration 选定的执行面；collect 失败时关闭暂存再返回失败，成功时把暂存交给调用方并附上清理函数；trigger 与 rerun 在 `try` 里调用、
  `finally` 里关闭暂存。
- `developmentDelivery.ts` 8 行：`composeDevelopmentDeliveryDeps` 里的 MR 事实读取（失败原样返回，成功时映射快照、数未解决且不是自己的
  评审线程）；`composeDevelopmentMrFactsCollector` 里的 MR 事实采集（没有 MR 认领、认领或任务不存在、仓库没有代码托管绑定、采集失败各抛
  一条原文错误；成功时算快照摘要、投影事实格并给线程算摘要）。

其余是装配：仓库远端端口转给交付 provider、MR effects 原样交出、按是否给了暂存选择流水线证据的旧实现或选定实现。

## 2. 目标

- **G1 实现归位**（函数体逐字不变）：
  - 流水线证据端口的选定实现迁入 `application/selectedPipelineEvidence.ts`（`createSelectedPipelineEvidence`）；它要的 integration 执行面在
    `application/ports/reconcilerPorts.ts` 以结构同形的端口类型 `SelectedPipelineEvidenceRunnerPort` 表达，本模块的 application 不取
    integration。
  - MR 事实的读取与采集迁入 `application/developmentMrFacts.ts`（`createDevelopmentMrFacts` 与 `createDevelopmentMrFactsCollector`）；采集用的
    时钟由装配传入。
- **G2 composition 只装配**：两个组合文件保留四个装配入口，从新位置取实现，不再有 F13 口径的控制流；交出的对象字段名与签名不变。
- **G3 账本与锁**：`composition-control-flow-development-automation` 119 → 102（按实测）；钉着这两个文件与装配根的 RFC-471、RFC-321、
  RFC-349、RFC-370 用例不改且仍通过；新增 RFC-508 用例。

## 3. 非目标

- development-automation 其余非 RFC-370 文件（`graphDeliveryLifecycle.ts`、`activityOperations.ts`、`graphDeliveryJob.ts`、
  `evidenceStaging.ts`、`employeeCaseDetailProjection.ts`、`executionTerminalObserver.ts`、`repositoryFactsScanner.ts`，后继）；
  流水线证据的旧实现（`infrastructure/local/legacyPipelineEvidence.ts`）；`crewstation*` / `taskImage*`（RFC-370 余项）；其余模块。
- 改写任何判据、错误类型与错误串；任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的位置声明；两个组合文件没有 F13 口径的控制流，从新位置取实现；四个装配入口与它们交出的对象
  （字段名与签名）不变。
- **AC-2**：同样输入下，流水线证据端口、MR 事实读取与采集的结果、错误与对端口的调用和此前一致：
  - 三个暂存工厂任一不合格时，装配就抛同样的错误；
  - collect：执行面失败时先关闭暂存再返回原失败，成功时交出原 envelope、暂存、输出预算与清理函数；trigger / rerun 成功、失败与抛错时都关闭
    暂存一次，返回的字段与此前相同；
  - MR 事实读取：失败原样返回；成功时字段映射与未解决线程的计数与此前相同；
  - MR 事实采集：四条错误文案逐字不变；快照摘要、事实格投影（没有头提交时为空）与线程摘要与此前相同。
- **AC-3**：新位置的依赖面是闭集：两个新文件只取本模块的 domain、application 与 `application/ports`，以及 `@/util/hash`，不取 infrastructure、
  composition、bootstrap、其他模块与 IO 包，不用进程全局；public surface 不升；`composition-control-flow-development-automation` 收紧到实测，
  其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
