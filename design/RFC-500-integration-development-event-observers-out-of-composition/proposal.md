# RFC-500 集成的开发员工事件观察者迁出 composition（RFC-294 S10 第七步）

- **状态**：Done（2026-11-16，落地 `81bb9a42b`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  S10 的范围列“integration、resource-catalog、system-operations、intent、runtime-management、digital-employee 的余项”，退出门要求各模块
  `composition/` 的分支计数不高于经确认的上限；proposal D16、review-2026-11-09 R11 / F13。
- **前序**：[RFC-499](../RFC-499-source-control-transport-and-preparation-effects-into-infrastructure/proposal.md)（S10 第六步，Done，
  `797bd884e`）。S10 与 S12 共用模块 composition 文件（同一文件同批只允许一个）；本 RFC 只动 integration 的
  `composition/digitalEmployeeEventObserver.ts` 与 bootstrap `daemonModules/integration.ts` 里取它的 import、一处类型与一处调用，不碰
  `taskImage*` / `crewstation*`。

## 1. 背景

RFC-499 之后，integration 的组合层控制流实测 101 行：`digitalEmployeeEventObserver.ts` 27 行，是余下最多的一个；其余是
`webhookAdmission.ts` 17 行、`taskImageDevelopmentAdapter.ts` 13 行（RFC-370 余项，避让）、`developmentAdapterConfigOperations.ts` 12 行、
`codeHostEffects.ts` 11 行、`approvalGateway.ts` 10 行等。

`digitalEmployeeEventObserver.ts`（428 行）是事件中心的开发员工观察者：代码托管观察者按 MR 取事实快照，投影成生命周期、检视、冲突与
门禁复核四类事实，按游标去重后产出观察；外部审批观察者按审批主题读审批网关的回执，状态变化时产出两条观察；分派器按来源把请求交给
其中一个。文件里只有纯投影、游标的 schema 与推进和这三个用例，没有装配：唯一的装配方是 bootstrap `daemonModules/integration.ts`，它把
部署选定的代码托管绑定与审批网关交给三个 `compose…` 函数。用例离开 composition 只差三处缺省：时钟 `input.now ?? Date.now`（两处）与
激活标识 `input.activationRef ?? randomUUID`。

## 2. 目标

- **G1 观察者归 application**：纯投影、游标与三个用例原样迁入 `application/developmentEventObservers.ts`；三个用例改名为
  `createDevelopment…EventObserver`，时钟与激活标识改为必填。
- **G2 composition 只装配**：`composition/digitalEmployeeEventObserver.ts` 只留装配函数 `composeDevelopmentEmployeeEventObserver`——收部署
  选定的代码托管绑定与审批网关，交进程时钟与 `randomUUID`，建两个观察者与分派器；bootstrap 改为调这一个函数。
- **G3 账本与锁**：取纯函数与审批观察者的用例改取新位置；`composition-control-flow-integration` 按实测收紧；新增 RFC-500 用例。

## 3. 非目标

- integration `composition/` 的其余文件（`webhookAdmission.ts`、`developmentAdapterConfigOperations.ts`、`codeHostEffects.ts`、
  `approvalGateway.ts`、`digitalEmployeeToolConnections.ts` 等）与其他模块；`taskImage*` / `crewstation*` 一族（RFC-370 余项，逐个避让）。
- 把纯投影与游标拆到 domain（它们取 application 的 `MrFactsSnapshot`，见 design §6）；改写观察者；S10 的全模块门。
- 任何行为变化、接口、错误码、事件与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在清单列的文件声明；`composition/digitalEmployeeEventObserver.ts` 只有装配函数、没有控制流语句；
  没有文件从旧位置取迁走的名字；bootstrap 只取装配函数、恰好调用一次。
- **AC-2**：同样输入下三个观察者的返回（游标与观察的内容和次序）与错误和此前一致（迁移逐字，现有用例对拍）；装配交的时钟与激活标识
  与此前的缺省相同。
- **AC-3**：新文件只取 shared、zod、`@/util/hash`、development-automation 的 `public/types` 与本模块 application，不取 infrastructure、
  composition、IO 包与进程全局；跨 context 边、public surface 不升；`composition-control-flow-integration` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
