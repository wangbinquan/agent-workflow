# RFC-509 开发自动化组合层的非 RFC-370 余项迁出 composition（RFC-294 S10 第十六步）

- **状态**：In Progress（2026-11-19）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推进RFC294」：本会话按
  2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。
  设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  退出门要求组合层“无循环与 switch，`try` 与 `throw` 只出现在登记清单内”的门对全部模块为绿，各模块 `composition/` 的分支计数不高于经确认的
  上限。
- **前序**：[RFC-508](../RFC-508-delivery-pipeline-evidence-and-mr-facts-out-of-composition/proposal.md)（S10 第十五步，`f07489c9c`）；
  development-automation 的前七步是 RFC-494～498、RFC-507 与 RFC-508。S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；
  本 RFC 改 development-automation `composition/` 下的 6 个文件，新增 application 下 4 个文件并给 application 的 2 个文件各增名字；所有装配入口
  的名字、签名、返回形状与位置不变，原有的转出名字照旧可取，bootstrap 与用例的 import 不改；不碰 `crewstation*` / `taskImage*`（RFC-370 余项）。

## 1. 背景

RFC-508 之后，development-automation 组合层的控制流（F13 口径）共 102 行，其中 RFC-370 的 `crewstation*` / `taskImage*` 占 80 行，其余
7 个文件 22 行，已没有循环。这 22 行里有 20 行是写在组合文件里的实现：

- `graphDeliveryLifecycle.ts` 6 行：graph@2 员工类型包（在 graph@1 的描述上并入 MR 生命周期的工作项、上下文与规则）与它的运行时编解码
  （按工作项分派给图或 MR 生命周期、给新案例记交付方式、交付结果在 MR 已发布时转去看护）。
- `graphDeliveryJob.ts` 4 行：从已加载的工具目录生成两个内建作业模板（MR 交付与完整 MR 看护），缺工具、缺分类路由或缺修复者时报错。
- `activityOperations.ts` 5 行：开发活动 worker 一个周期的先后次序（通道结果、outbox、派发、交付、反应规划、执行巡检）。
- `employeeCaseDetailProjection.ts` 2 行：开发员工案例详情的归一化投影（取最新的上下文、只认 1 版、解析失败时该部分留空）与它的参与者。
- `executionTerminalObserver.ts` 1 行：执行终态唤醒（找不到所属 mission 就不做；记一条唤醒提示再驱动 mission，驱动失败不外抛）。
- `evidenceStaging.ts` 3 行里的 2 行：选定内容的完整性核对（暂存工厂合格、文档写入器在场，否则抛错）。

另 2 行是装配期的选择：`evidenceStaging.ts` 按是否给了选定的暂存选择选定内容或本地内容，`repositoryFactsScanner.ts` 按工作区有无树操作选择
卷上扫描或进程内扫描。

## 2. 目标

- **G1 实现归位**（函数体逐字不变）：
  - 图交付生命周期迁入 `application/graph-development/deliveryLifecycle.ts`（`createGraphDeliveryLifecycleTypePackage`、
    `createGraphDeliveryLifecycleRuntimeCodec` 与 `GRAPH_DELIVERY_EMPLOYEE_TYPE`）；开发员工类型包的登记对象（组合层）由装配传入。
  - 内建作业模板迁入 `application/graph-development/deliveryJobs.ts`（`buildGraphDeliveryJobs` 与两个作业 id）。
  - 案例详情投影迁入 `application/employeeCaseDetailProjection.ts`（`projectDevelopmentEmployeeCaseDetail` 与参与者实现
    `createDevelopmentEmployeeCaseDetailProjection`）。
  - 活动周期迁入既有的 `application/activityOperations.ts`（`createDevelopmentActivityWorkerCycle` 与 worker 接口）。
  - 执行终态唤醒迁入 `application/executionTerminalObserver.ts`（`createMissionExecutionTerminalObserver`；id 与时钟由装配传入）。
  - 选定内容的完整性核对迁入既有的 `application/evidenceStaging.ts`（`selectedRequirementMaterializerContent`）。
- **G2 composition 只装配**：6 个组合文件保留各自的装配入口与转出的名字，从新位置取实现；只留两处装配期选择。
- **G3 账本与锁**：`composition-control-flow-development-automation` 102 → 82（按实测）；RFC-310 的 OS 架构清单随 import 的移动更新；钉着这些
  文件与装配根的既有用例仍通过（`rfc344-operation-catalog` 里读组合文件原文的一段随唤醒改读新位置，见 design D5）；新增 RFC-509 用例。

## 3. 非目标

- 两处装配期选择（`evidenceStaging.ts` 的选定或本地内容、`repositoryFactsScanner.ts` 的卷上或进程内扫描）：它们在装配时选实现，留在组合层，
  计入上限。
- `graphDevelopment.ts` 的 `detailProjection` 与 `digitalEmployeeWorkspace.ts`；`crewstation*` / `taskImage*`（RFC-370 余项）；其余模块。
- 改写任何判据、错误类型与错误串；任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的位置声明；6 个组合文件只留装配入口、转出与两处装配期选择，从新位置取实现；装配入口与转出的名字
  （含签名与交出的对象）不变。
- **AC-2**：同样输入下，图交付类型包与编解码、内建作业模板、案例详情投影、活动周期、执行终态唤醒与选定内容核对的结果、错误与对端口的调用和
  此前一致：错误文案逐字不变；活动周期的先后次序不变；终态唤醒的唤醒提示字段（id 与时刻取自装配传入的函数）不变。
- **AC-3**：新位置的依赖面是闭集：只取本模块的 domain、application 与 `application/ports`、zod，以及 digital-employee 的 public types（已在
  context DAG 上），不取 infrastructure、composition、bootstrap 与 IO 包，不用进程全局；public surface 不升；
  `composition-control-flow-development-automation` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
