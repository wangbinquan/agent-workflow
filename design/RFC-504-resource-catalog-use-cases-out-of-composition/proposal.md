# RFC-504 资源目录的内建工作流、资源包暂存、任务房协作、意图上下文授权与 MCP 测试失效迁出 composition（RFC-294 S10 第十一步）

- **状态**：In Progress（2026-11-17）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294
  总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话
  按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围列“integration、resource-catalog、system-operations、intent、runtime-management、digital-employee 的余项”，退出门要求组合层
  “无循环与 switch，`try` 与 `throw` 只出现在登记清单内”，各模块 `composition/` 的分支计数不高于经确认的上限。
- **前序**：[RFC-503](../RFC-503-intent-use-cases-out-of-composition/proposal.md)（S10 第十步，Done，`448e40c78`）。S10 与 S12 共用模块
  composition 文件（同一文件同批只允许一个）；本 RFC 只动 resource-catalog 的 `composition/builtinWorkflowCatalog.ts`（删除）、
  `composition/intentContextAuthorization.ts`、`composition/mcpOperations.ts`、`composition/resourcePackageOperations.ts`、
  `composition/workgroupTaskRoom.ts` 与 resource-catalog `composition.ts` 的一条转出，改 bootstrap `daemonModules/digitalEmployee.ts` 与
  `daemonHttpComposition.ts` 取这些工厂的 import 与调用，以及按路径或文本钉着这几个文件的锁；不碰 `taskImage*` / `crewstation*`（RFC-370
  余项）与 `composition/resourceAcl.ts`。

## 1. 背景

RFC-503 之后，resource-catalog 的组合层控制流（F13 口径）实测 92 行：RFC-370 余项的 `taskImagePlugin.ts` 35 行、
`crewstationMcpDiagnostics.ts` 25 行、`crewstationArtifacts.ts` 8 行、`crewstationNativePlugin.ts` 4 行，其余 20 行在 9 个文件里。其中 5 个
文件的 15 行是“用例或 IO 写在 composition”：

- `builtinWorkflowCatalog.ts`（56 行）整份是一个带 IO 的用例：读已有的内建工作流、按内容比对（不符就抛
  `builtin-workflow-content-conflict:<id>`）、缺失时以系统身份在资源目录事务里建行并广播，没有装配。
- `resourcePackageOperations.ts`（227 行）的 `composeResourcePackageOperationsFromAdapters` 里，大半是资源包的一次性暂存：两张内存表、
  按句柄取走一次、种类核对、可打包种类检查、导出包取走一次（7 行控制流）；装配只有取缺省的 id、建应用与操作描述符几行。
- `workgroupTaskRoom.ts` 的 `composeWorkgroupTaskRoomDynamicWorkflow` 是动态工作流“确认前复核”与“另存为工作流”的用例（三层校验，任一层有
  error 级问题就以 `dw-generated-def-stale` 打回）；`composeWorkgroupTaskRoomActiveUsers` 按状态筛在岗用户。它们实现的两个端口接口声明在
  infrastructure。
- `intentContextAuthorization.ts` 的私有 `currentAuthorityResolver`：每次读都核对传入的授权上下文是不是这次会话的那一份，不是就抛
  `foreign-intent-context-resource-authority`；同文件的工厂只是把它与 infrastructure 的读端口接到 application 的会话上。
- `mcpOperations.ts` 的 `mcpAclRuntimeTestLifecycle`：实现 infrastructure 的 ACL 写事务生命周期接口，只对 MCP 的变更在同一事务里转移运行时
  测试；同文件其余是装配。

## 2. 目标

- **G1 用例与 IO 归位**（函数体逐字不变）：
  - 资源包暂存迁入 `application/package/stagedExecution.ts`（`createResourcePackageStagedExecution`，id 由装配传入）；
  - 任务房的两个端口实现迁入 `application/workgroups/taskRoomCollaborators.ts`（`createWorkgroupTaskRoomActiveUsers`、
    `createWorkgroupTaskRoomDynamicWorkflow`），它们实现的两个端口接口迁入 `application/workgroups/ports.ts`；
  - 意图上下文的授权核对迁入 `application/participants/intentContextResourceAuthorization.ts`
    （`createIntentContextCurrentAuthorityResolver`，与它实现的接口同文件）；
  - 内建工作流目录迁入 `infrastructure/builtinWorkflowCatalog.ts`（`createBuiltinWorkflowCatalog`）；
  - MCP 的 ACL 运行时测试失效迁入 `infrastructure/mcpRuntimeTestTransitions.ts`（名字不变）。
- **G2 composition 只装配**：`composition/builtinWorkflowCatalog.ts` 删除，工厂经 resource-catalog 的 `composition.ts` 转出给 bootstrap；其余
  四个组合文件只留装配入口与转出。五处不再有 F13 口径的控制流。
- **G3 账本与锁**：改取被迁名字的 bootstrap 与用例；按路径或文本钉着这几个文件的锁改读新文件；`composition-control-flow-resource-catalog`
  按实测收紧；新增 RFC-504 用例。

## 3. 非目标

- `composition/resourceAcl.ts`（348 行，带缓存与按数据库句柄的读写，被 infrastructure 反向取用，另立）；
  `composition/resourcePackageMaintenance.ts` 的装配期冲突守卫（登记清单的事）；`composition/skillContentBinding.ts` 与
  `composition/skillVersionCommit.ts` 的缺省选择（S12 的必填注入）；`taskImage*` / `crewstation*`（RFC-370 余项）与其余组合文件。
- 合并 `composition/resourcePackageExecution.ts` 里那份私有的资源包执行输入类型与执行适配器接口（design §8）。
- 改写任何判据、拆分函数；任何行为变化、接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的新位置声明（design §3 列的同名类型除外，原样钉住）；`composition/builtinWorkflowCatalog.ts`
  不存在，没有文件从它取名字；改名前的四个工厂名没有声明；四个组合文件没有 F13 口径的控制流，各自从新位置取实现。
- **AC-2**：同样输入下内建工作流的确保、资源包的暂存与取走、任务房的复核与另存、意图上下文的授权核对与 MCP 的 ACL 测试失效的结果、错误与
  对端口的调用和此前一致（迁移逐字，现有用例对拍）；bootstrap 取到的是同一份实现；资源包暂存的句柄与应用的 id 仍是同一个来源。
- **AC-3**：新位置的依赖面是闭集：application 的新代码只取本模块 domain / application / public、`@agent-workflow/shared`、`@/auth/actor` 的
  类型、`@/util/errors` 与 `@/util/hash` 和 identity-access 的 `public` 类型，不取 infrastructure、composition 与 IO 包，不用进程全局；跨
  context 边、public surface 不升；`composition-control-flow-resource-catalog` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
