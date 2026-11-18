# RFC-505 数字员工的内建作业、PostgreSQL 磁盘报告与运行时选择快照迁出 composition（RFC-294 S10 第十二步）

- **状态**：In Progress（2026-11-18）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294
  总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话
  按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围列“integration、resource-catalog、system-operations、intent、runtime-management、digital-employee 的余项”，退出门要求组合层
  “无循环与 switch，`try` 与 `throw` 只出现在登记清单内”，各模块 `composition/` 的分支计数不高于经确认的上限。
- **前序**：[RFC-504](../RFC-504-resource-catalog-use-cases-out-of-composition/proposal.md)（S10 第十一步，Done，`96e678719`）。S10 与 S12
  共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只改 digital-employee 的 `composition/builtinJobTemplates.ts`、
  system-operations 的 `composition/maintenanceDisk.ts` 与 runtime-management 的 `composition/runtimeSelection.ts`，新增 digital-employee 的
  `application/builtinEmployeeJobs.ts` 与 platform 的 `persistence/postgresqlStorageFootprint.ts`，扩充 system-operations 的
  `infrastructure/local/systemMaintenanceDisk.ts` 与 runtime-management 的 `application/runtimeSelection.ts`；三个装配入口的名字、签名与位置不变，bootstrap 与用例的 import 不改；不碰 `taskImage*` /
  `crewstation*`（RFC-370 余项）。

## 1. 背景

RFC-504 之后，三个模块的组合层控制流（F13 口径）：digital-employee 19 行（RFC-370 余项 `crewstationContent.ts` 13 行，
`builtinJobTemplates.ts` 6 行）；system-operations 28 行（RFC-370 余项 `crewstationDatabaseRestore.ts`、`crewstationDeployment.ts` 各
12 行，`maintenanceDisk.ts` 2 行，`daemonDatabase.ts` 与 `manualDatabaseMigration.ts` 各 1 行）；runtime-management 23 行（RFC-370 余项
`crewstationRuntimeManagement.ts` 11 行、`crewstationSystemAgentMaterial.ts` 7 行、`taskImageMaterial.ts` 4 行，`runtimeSelection.ts`
1 行）。其中三处是“用例或 IO 写在 composition”：

- `builtinJobTemplates.ts`（66 行）的 `composeBuiltinEmployeeJobs` 除建作者面持久化的一行外，整个是内建作业模板的确保用例：解析内容、读已有
  模板；`ensureDraft` 在类型引用不符时抛 `builtin-employee-job-type-conflict:<id>`、缺失时建草稿；`ensure` 在模板有 owner 或草稿内容不符时
  抛 `builtin-employee-job-content-conflict:<id>`、缺失时建行，未发布时经传入的 `publish` 发布。
- `maintenanceDisk.ts`（67 行）的 `composePostgresqlMaintenanceDiskOperations` 在组合层直接对 PostgreSQL 发 SQL（库大小与按 `n_dead_tup`
  估算的可回收字节），再经私有的 `nonNegativeInteger` 校验（不合法就抛 `maintenance disk metric is invalid: …`）；同文件的 SQLite 版只把
  `report` 交给 infrastructure 的 `reportDiskReclaimable`。
- `runtimeSelection.ts`（38 行）的 `composeRuntimeSelectionParticipantInTx` 里，冻结运行时的快照表（`retain` 存；`readSnapshot` 核对任务
  范围后按引用取，取不到就抛 `runtime-selection-reference-unavailable`，交出副本）是运行时选择的用例状态；其余是装配。

`daemonDatabase.ts` 与 `manualDatabaseMigration.ts` 的 `if` 是装配期在“安装端口”与“本地文件”两条准备路径间的选择（后者的
`options.configuration ?? createFileDatabaseConfiguration(...)` 属 S12 的缺省回落），不在本步。

## 2. 目标

- **G1 用例与 IO 归位**（函数体逐字不变）：
  - 内建作业模板的确保迁入 digital-employee 的 `application/builtinEmployeeJobs.ts`（`createBuiltinEmployeeJobs`；作者面持久化、`publish`
    与时钟由装配传入）；
  - PostgreSQL 的磁盘报告拆成两半：发 SQL 的那次读连同 `nonNegativeInteger` 迁入 platform 的 `persistence/postgresqlStorageFootprint.ts`
    （`readPostgresqlStorageFootprint`；provider 命名的文件只住 `platform/persistence/`，RFC-359 W5-T17），报告的拼装迁入 system-operations
    的 `infrastructure/local/systemMaintenanceDisk.ts`（`reportMeasuredDiskReclaimable`，不分引擎）；
  - 运行时快照表迁入 runtime-management 的 `application/runtimeSelection.ts`（`createRuntimeSelectionSnapshotsInTx`，与参与者同文件）。
- **G2 composition 只装配**：三个组合文件保留装配入口（名字、签名与位置不变），各自从新位置取实现，不再有 F13 口径的控制流。
- **G3 账本与锁**：三个模块的 `composition-control-flow-*` 按实测收紧；新增 RFC-505 用例。

## 3. 非目标

- `daemonDatabase.ts`、`manualDatabaseMigration.ts`（装配期的路径选择与 S12 的缺省回落）；`taskImage*` / `crewstation*`（RFC-370 余项）。
- identity-access `composition/userOperations.ts` 的改密用例、code-capability `composition/historyQueries.ts` 的未绑定缺省、integration
  `composition/webhookIngress.ts` 的可选装配（另立或随 S12）；其余模块。
- 改写任何判据、拆分函数；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的新位置声明（`nonNegativeInteger` 在 system-operations 与 platform/persistence 里只在新文件声明，
  collaboration 的三个同名私有函数不动）；三个组合文件没有 F13 口径的控制流，各自从新位置取实现；装配入口的名字、签名与位置不变。
- **AC-2**：同样输入下内建作业的确保（草稿与发布两种）、PostgreSQL 磁盘报告与运行时快照的存取的结果、错误与对端口的调用和此前一致（迁移
  逐字，现有用例对拍）；时钟仍在调用时取，每处取一次，与此前相同。
- **AC-3**：新位置的依赖面是闭集：digital-employee 的新文件只取本模块 domain、application 的端口类型与 `@agent-workflow/shared`，
  runtime-management 新增的函数只用该文件已取的类型，两者不取 infrastructure、composition 与 IO 包、不用进程全局；platform 的新文件只取
  同层的 PostgreSQL 运行时类型、不用进程全局，system-operations 新增的函数不新增 import；RFC-359 W5-T17 的 provider 命名文件账本与同文件
  双实现对账本不变；public surface 不升；三个模块的 `composition-control-flow-*` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
