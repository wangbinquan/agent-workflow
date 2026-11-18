# RFC-503 意图的平台清单、图校验与维护命令迁出 composition（RFC-294 S10 第十步）

- **状态**：Done（2026-11-17，落地 `448e40c78`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294
  总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话
  按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围列“integration、resource-catalog、system-operations、intent、runtime-management、digital-employee 的余项”，退出门要求组合层
  “无循环与 switch，`try` 与 `throw` 只出现在登记清单内”，各模块 `composition/` 的分支计数不高于经确认的上限。
- **前序**：[RFC-502](../RFC-502-integration-development-use-cases-out-of-composition/proposal.md)（S10 第九步，Done，`7953576df`）。
  S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只动 intent 的 `composition/platformInventory.ts`、
  `composition/graphValidation.ts`（两者删除）、`composition/maintenance.ts` 的一个函数、`composition/dispatch.ts` 的一行、intent
  `composition.ts` 的两条转出、bootstrap `daemonModules/intent.ts` 取这两个工厂的 import 与调用，以及按路径钉着 `platformInventory.ts` 的锁，
  不碰 `crewstation*`（RFC-370 余项）与 `composition/resourceCatalog.ts`。

## 1. 背景

RFC-502 之后，intent 的组合层控制流（F13 口径）实测 23 行：`platformInventory.ts` 9 行、`graphValidation.ts` 5 行、`maintenance.ts` 3 行、
`dispatch.ts` 1 行、`resourceCatalog.ts` 1 行，以及 RFC-370 余项的 `crewstationArtifacts.ts` 3 行与 `crewstationScratch.ts` 1 行。前四处都是
“用例写在 composition”：

- `platformInventory.ts`（144 行）整份是用例：把 development-automation 的配置操作、digital-employee 与 code-capability 的清单按资源类型
  汇成意图教学用的平台清单行（排序、发布状态与描述的拼法），没有任何装配。
- `graphValidation.ts`（50 行）整份是意图图校验端口的实现：候选定义交给 resource-catalog 的校验查询，另按 actor 可见的工作流找出引用了
  给定代理的工作流（两层循环）。
- `maintenance.ts` 的 `composeIntentMaintenanceCommands`：草稿目录清扫（跳过运行中的 turn、逐个删除并记日志、失败的排除在水位外）与开机
  恢复两条维护命令；同文件其余是按数据库与 app home 的装配。
- `dispatch.ts`：开机恢复排队工作集的入口在调用 application 前先判一次空列表，而 application 收到空列表本就什么也不做。

## 2. 目标

- **G1 用例归 application**：平台清单参与者原样迁入 `application/platformInventoryParticipant.ts`（`createIntentPlatformInventoryParticipant`），
  图校验端口的实现迁入 `application/workflowGraphValidationProvider.ts`（`createIntentWorkflowGraphValidation`），两条维护命令迁入
  `application/maintenanceCommands.ts`（`createIntentMaintenanceCommands`，时钟由装配传入）。
- **G2 composition 只装配**：`composition/platformInventory.ts` 与 `composition/graphValidation.ts` 删除，两个工厂经 intent 的 `composition.ts`
  转出给 bootstrap；`composeIntentMaintenanceCommands` 留在组合文件、只把进程时钟交给新工厂；`dispatch.ts` 去掉多余的空判断。四处不再有
  F13 口径的控制流。
- **G3 账本与锁**：取被迁名字的用例改取新位置；按路径钉着 `platformInventory.ts` 的边账本改钉新文件；`composition-control-flow-intent`
  按实测收紧；新增 RFC-503 用例。

## 3. 非目标

- `composition/resourceCatalog.ts`（解析 actor 时的 `throw` 是装配期的绑定守卫，文件取 `@/routes/operationAuthority`）、
  `crewstation*`（RFC-370 余项）与 intent 的其余组合文件；`maintenance.ts` 里回落到文件草稿目录的 `??`（S12）。
- `application/maintenance.ts` 里的旧函数、意图的其余模块与其他 context。
- 改写任何判据、拆分函数；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的新文件声明；两个组合文件不存在，没有文件从旧位置取名字；改名前的两个工厂名与平台清单的组合
  依赖接口名没有声明；`maintenance.ts` 与 `dispatch.ts` 没有 F13 口径的控制流。
- **AC-2**：同样输入下平台清单、图校验与两条维护命令的结果、日志与对端口的调用次序和参数与此前一致（迁移逐字，现有用例对拍）；bootstrap
  取到的平台清单参与者与图校验端口与此前是同一份实现；开机恢复排队工作集对空列表与非空列表的行为不变。
- **AC-3**：新文件只取本模块 domain / application / public 的类型、`@/auth/actor` 的类型与 development-automation、digital-employee、
  identity-access、resource-catalog 的 `public` 类型，不取 infrastructure、composition 与 IO 包，不用进程全局；跨 context 边、public surface
  不升；`composition-control-flow-intent` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
