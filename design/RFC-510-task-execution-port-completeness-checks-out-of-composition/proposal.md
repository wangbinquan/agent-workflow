# RFC-510 任务执行组合层的端口完整性核对迁出 composition（RFC-294 S10 第十七步）

- **状态**：Done（2026-11-19，落地 `90c631993`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09、
  2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推进RFC294」：本会话按
  2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。
  设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S10（`composition/` 只装配：全模块收口）——
  退出门要求组合层“无循环与 switch，`try` 与 `throw` 只出现在登记清单内”的门对全部模块为绿，各模块 `composition/` 的分支计数不高于经确认的
  上限。
- **前序**：[RFC-509](../RFC-509-development-automation-composition-remainder/proposal.md)（S10 第十六步，Done，`de25526b7`）：development-automation
  组合层的非 RFC-370 实现已清零。本 RFC 是 task-execution 在 S10 的第一步，只改 task-execution `composition/` 下的 7 个文件，给 application 的
  4 个文件各增名字、新增 application 下 2 个文件，并把 3 个运行选择接口挪到 `application/ports/taskRunSelection.ts`；所有装配入口的名字、签名、
  返回形状与位置不变，原有的转出名字照旧可取，bootstrap、基础设施与用例的 import 不改；不碰 `crewstation*`（RFC-370 余项）。

## 1. 背景

RFC-509 之后，task-execution 组合层的控制流（F13 口径）共 43 行，RFC-370 的 `crewstationSystemAgentRunFamily.ts` 占 1 行，其余 14 个文件 42 行。
其中 26 行是同一种东西：**端口的装配期完整性核对**——装配时检查交入的实现（内容收发、操作、读取器、删除效果、运行选择、启动配置读取器、运行
绑定）是否齐全，不齐就抛一条原文 `TypeError`：

- `portArtifacts.ts` 6 行：内容收发与操作的两个 `require*`、只读读取器的核对；
- `taskDeletionEffects.ts` 6 行：内容收发的 `require*`、删除效果与仓库参与者的核对；
- `nodeRunPrompts.ts` 4 行：内容收发与操作的两个 `require*`；
- `taskRunSelection.ts` 4 行：运行选择的核对与每次驱动时配置引用的核对；
- `portOutputValidation.ts`、`launchConfiguration.ts`、`localTaskRunSelection.ts` 各 2 行：内容接收方、启动配置读取器与运行绑定的核对。

这些核对判断的是端口的合同（方法齐不齐、命名空间对不对），与 RFC-508 迁到 application 的 `assertEvidenceStagingFactory` 同类。其余 16 行是装配期
选择与几处运行时绑定（引擎应用、DAG 执行的旁表等），另立后继。

## 2. 目标

- **G1 核对归位**（函数体逐字不变）：7 组核对迁入 task-execution 的 application：`portArtifacts.ts`、`nodeRunPrompt.ts`、`portOutputValidation.ts`、
  `launchConfiguration.ts` 增名字，新增 `taskDeletionEffects.ts` 与 `taskRunSelection.ts`；核对要的 3 个运行选择接口（`TaskRunRootSelection`、
  `TaskRunDriveBinding`、`TaskRunRootBinding`）挪到 `application/ports/taskRunSelection.ts`。
- **G2 composition 只装配**：7 个组合文件保留装配入口、选择与转出的名字，从新位置取核对；这 26 行不再在组合层。
- **G3 账本与锁**：`composition-control-flow-task-execution` 43 → 17（按实测）；`rfc423-composition-assembly-only` 的 throw 账本随核对迁走
  收紧（design D4）；钉着这些文件的其余用例仍通过；新增 RFC-510 用例。

## 3. 非目标

- 装配期选择（选定或本地的实现、排除配置的来源、归档位置）；运行时绑定与引擎（`taskEngineApplication.ts`、`localTaskRunSelection.ts` 的本地
  配置桥、`launchConfiguration.ts` 的本地启动配置、`humanGate.ts`、`digitalEmployeeExecution.ts`、`nodeExecution.ts` 与
  `executionWorkspaceBinding.ts` 的旁表、`sqliteTaskExecutionContext.ts`），另立后继；`crewstation*`（RFC-370 余项）；其余模块。
- 改写任何判据、错误类型与错误串；任何行为变化、接口与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：design §3 清单里的名字只在各自的位置声明；7 个组合文件不再有这 26 行核对，从新位置取核对；装配入口与转出的名字（含签名与交出的对象）
  不变。
- **AC-2**：同样输入下，每个核对接受与拒绝的输入、抛出的错误类型与文案与此前一致；核对的先后与时机（装配时或每次驱动时）不变。
- **AC-3**：新位置的依赖面是闭集：只取本模块的 application 与 `application/ports`（既有文件原有的 import 不变），不取 infrastructure、composition、
  bootstrap 与其他模块，不用进程全局；public surface 不升；`composition-control-flow-task-execution` 收紧到实测，其余计数不升。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
