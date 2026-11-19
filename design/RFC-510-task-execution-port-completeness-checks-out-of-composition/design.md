# RFC-510 设计：任务执行组合层的端口完整性核对迁出 composition

## 1. 现状（HEAD `0bf3116d2`，源码实读）

task-execution 组合层控制流（F13 口径）43 行：RFC-370 的 `crewstationSystemAgentRunFamily.ts` 1 行，其余 14 个文件 42 行。本 RFC 的 26 行都是端口的
装配期完整性核对（行号是 HEAD 的组合文件；同一行的 `if` 与 `throw` 按一行计）：

| 文件（`composition/` 下）  | 行                     | 核对                                                                                                                                          |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `portArtifacts.ts`         | 38、43；50、56；94、95 | `requirePortArtifactContentEffects`（22～45）、`requirePortArtifactOperations`（47～58）、`selectPortArtifactReader` 里读取器的核对（94～96） |
| `taskDeletionEffects.ts`   | 11、17；31、32；35、41 | `requireTaskDeletionContentEffects`（8～19）、`selectedTaskDeletionEffects` 里删除效果与仓库参与者的核对（31～42）                            |
| `nodeRunPrompts.ts`        | 16、23；30、36         | `requireNodeRunPromptContentEffects`（13～25）、`requireNodeRunPromptOperations`（27～38）                                                    |
| `taskRunSelection.ts`      | 40、56；70、75         | `requireTaskRunRootSelection`（38～58，文件内函数）、`bindTaskRunRootSelection` 的 `bind` 里配置引用的核对（70～76）                          |
| `portOutputValidation.ts`  | 23、29                 | `composePortOutputContentValidation` 里内容接收方的核对（23～30）                                                                             |
| `launchConfiguration.ts`   | 25、31                 | `composeTaskLaunchConfiguration` 里启动配置读取器的核对（25～32）                                                                             |
| `localTaskRunSelection.ts` | 148、149               | `bindProviderTaskRunParticipantsInput` 里选定运行绑定的核对（148～150）                                                                       |

使用方：`requireTaskDeletionContentEffects` 另被 `infrastructure/taskDeleteRecovery.ts` 从组合文件取；其余 `require*` 只在各自的组合文件里用。
`bindTaskRunRootSelection`、`selectPortArtifactReader`、`selectedTaskDeletionEffects`、`composePortOutputContentValidation`、
`composeTaskLaunchConfiguration` 与 `bindProviderTaskRunParticipantsInput` 被 bootstrap、路由、基础设施与用例取用（`TaskRunRootSelection`、
`TaskRunDriveBinding`、`TaskRunRootBinding` 三个接口声明在 `composition/taskRunSelection.ts`，同样被取用）。按错误串断言的用例：
`rfc370-port-output-validation`、`rfc370-task-launch-configuration-closure`。读这些组合文件原文的锁：`envelope-prefix-swap-source`（把
`composition/portOutputValidation.ts` 与 `application/portOutputValidation.ts` 等拼在一起断言）、`rfc370-port-artifact-bindings`（读
`localTaskRunSelection.ts` 里 `input.taskAgentRunsFor` 的调用与 `portArtifactsFor` 的那一行），本 RFC 不动它们读的内容。

## 2. 机制与落位

### D1 核对落 application

核对只看交入的值是否满足端口的形状，不做 IO，是端口合同的一部分；与 RFC-508 的 `assertEvidenceStagingFactory` 一样放 application，挨着各自的
策略：

- `application/portArtifacts.ts`（增）：`requirePortArtifactContentEffects`、`requirePortArtifactOperations`（HEAD 第 22～45、47～58 行逐字），
  `requirePortArtifactReader(reader)`（函数体是 HEAD 第 94～96 行逐字）。
- `application/taskDeletionEffects.ts`（新）：`requireTaskDeletionContentEffects`（HEAD 第 8～19 行逐字）、`requireTaskDeletionEffects(effects)`（函数体
  是 HEAD 第 31～42 行逐字）。
- `application/nodeRunPrompt.ts`（增）：`requireNodeRunPromptContentEffects`、`requireNodeRunPromptOperations`（HEAD 第 13～25、27～38 行逐字）。
- `application/taskRunSelection.ts`（新）：`requireTaskRunRootSelection`（HEAD 第 38～58 行逐字，改为导出）、`requireTaskRunConfiguration(configuration)`
  （函数体是 HEAD 第 70～76 行，少缩进）、`requireTaskRunDriveBinding(selected)`（函数体是 HEAD `localTaskRunSelection.ts` 第 148～150 行，少缩进）。
- `application/portOutputValidation.ts`（增）：`requirePortOutputValidationContent(content)`（函数体是 HEAD 第 23～30 行逐字）。
- `application/launchConfiguration.ts`（增）：`requireTaskLaunchConfigurationInput(input)`（函数体是 HEAD 第 25～32 行逐字；入参类型写出核对读到的
  `kind` 与 `queries.read`）。

### D2 接口挪到端口

`requireTaskRunRootSelection` 与 `requireTaskRunDriveBinding` 要 `TaskRunRootSelection`、`TaskRunDriveBinding`；application 不能取组合层。三个接口
（HEAD `composition/taskRunSelection.ts` 第 14～31 行，连同 `TaskRunRootBinding`）逐字挪到 `application/ports/taskRunSelection.ts`（它们只引用端口里的
类型），组合文件以类型转出原名，使用方不改。

### D3 composition 只装配

- 组合文件改为从新位置取核对：`selectPortArtifactReader`、`selectedTaskDeletionEffects` 保留选择（三元式），核对改为调用；`bindTaskRunRootSelection`
  的 `bind` 里改为调用 `requireTaskRunConfiguration(configuration)`；`composePortOutputContentValidation`、`composeTaskLaunchConfiguration` 与
  `bindProviderTaskRunParticipantsInput` 的核对改为调用。
- 原来从组合文件导出的 `require*`（`requirePortArtifactContentEffects`、`requirePortArtifactOperations`、`requireTaskDeletionContentEffects`、
  `requireNodeRunPromptContentEffects`、`requireNodeRunPromptOperations`）照旧从组合文件转出。
- 装配入口的名字、签名与交出的对象不变；调用时机不变（装配时的仍在装配时，`bind` 里的仍在每次驱动时）。

### D4 锁与账本

- `architecture/counts.json`：`composition-control-flow-task-execution` 43 → 实测（预计 17）。`guard-manifest.json` 登记 RFC-510 用例
  （`assertsAbsence: true`）。
- 不改：`envelope-prefix-swap-source`（读的几个文件拼起来仍含同样的文本）、`rfc370-port-artifact-bindings`（读的调用与那一行不动）、按错误串断言的
  两个 RFC-370 用例、`rfc422-run-family-openers`；`design/` 里的历史记述。迁移前已按组合文件路径全仓扫用例里的 `readFileSync`（RFC-509 的教训）。

## 3. 清单（退出门）

| 位置（`packages/backend/src/modules/task-execution/` 下） | 声明并交出                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `application/portArtifacts.ts`（增）                      | `requirePortArtifactContentEffects`、`requirePortArtifactOperations`、`requirePortArtifactReader` |
| `application/taskDeletionEffects.ts`（新）                | `requireTaskDeletionContentEffects`、`requireTaskDeletionEffects`                                 |
| `application/nodeRunPrompt.ts`（增）                      | `requireNodeRunPromptContentEffects`、`requireNodeRunPromptOperations`                            |
| `application/taskRunSelection.ts`（新）                   | `requireTaskRunRootSelection`、`requireTaskRunConfiguration`、`requireTaskRunDriveBinding`        |
| `application/portOutputValidation.ts`（增）               | `requirePortOutputValidationContent`                                                              |
| `application/launchConfiguration.ts`（增）                | `requireTaskLaunchConfigurationInput`                                                             |
| `application/ports/taskRunSelection.ts`（增）             | `TaskRunRootSelection`、`TaskRunDriveBinding`、`TaskRunRootBinding`                               |

允许的形状：7 个组合文件里不再有清单里的声明与这 26 行核对；它们只从新位置取核对，转出原有的名字。

## 4. 用例

新增 `packages/backend/tests/rfc510-task-execution-port-completeness-checks-out-of-composition-boundary.test.ts`（文件名带 `boundary`），登记
guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字；7 个组合文件不再
  声明它们，转出的名字不变。
- ② 7 个组合文件里不再有这 26 行核对（`TypeError` 的构造只在新位置）；新核对在生产代码里只在各自的组合文件调用、实参逐字钉住；带负对照。
- ③ 新代码的依赖面是闭集：两个新文件只取本模块的 `application/ports`；既有文件的 import 除新增的端口类型外不变；都不用进程全局；带负对照。
- ④ 行为（直接调用新位置）：每个核对接受齐全的值、拒绝缺方法或缺字段的值并抛原文 `TypeError`；删除效果先核对效果对象再核对内容收发、最后核对
  仓库参与者；运行选择核对命名空间与两个运行族工厂；配置引用核对类型与引用。

行为另由现有用例对拍：`rfc370-task-deletion-effects`、`rfc370-port-artifact-content`、`rfc370-port-artifact-bindings`、`rfc370-port-output-validation`、
`rfc370-task-launch-configuration-closure`、`rfc370-task-run-root-selection`、`rfc370-task-run-root-content`、`rfc370-node-run-prompt-bindings`、
`rfc359-w8-runtime-participants-conformance` 经装配入口走这些核对。

## 5. 失败模式

- **核对走样**：函数体逐字迁移；判断的先后、短路次序与错误串原样保留；替换只有缩进与 D1 列出的入参名。
- **时机**：`bind` 里的配置核对仍在每次驱动时调用；其余仍在装配时调用。
- **类型挪动**：三个接口逐字挪到端口文件、组合文件转出原名，`tsc` 覆盖全部使用方。
- **读原文的锁**：迁移前已按组合文件路径扫用例（RFC-509 的教训），读到的两处不受影响（D4）。
- **按原始文本扫的锁误计**：新文件的注释不写组合文件的路径（RFC-506 的教训）。
- **账本漏标**：guard-manifest 条目标 `assertsAbsence: true`（RFC-507 的教训）。

## 6. 取舍（可推翻）

1. **只做核对这一类**：26 行同属端口合同的核对，改法一致；装配期选择留在组合层，运行时绑定与引擎牵涉 S6 留下的旁表，另立后继。
2. **核对挨着策略放**：既有的 application 文件已有对应端口的策略（内容、提示词、输出校验、启动配置），新增的两个文件按端口命名。
3. **接口挪到端口**：三个运行选择接口只引用端口类型，放端口文件比让 application 取组合层更合层次。
4. **组合文件保留转出**：使用方（bootstrap、路由、基础设施与用例）的 import 不改，与 RFC-507～509 的做法一致。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是端口的装配期完整性核对，落 application；组合文件只装配与选择；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-510 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读 7 个组合文件与新位置；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-task-execution` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 task-execution 的第一步：端口的装配期完整性核对离开 `composition/`（26 行）。
- **留下**：task-execution 组合层的其余 16 行（装配期选择 4 行；`taskEngineApplication.ts` 5 行、`humanGate.ts` 2 行与
  `localTaskRunSelection.ts` 的本地配置桥、`launchConfiguration.ts` 的本地启动配置、`digitalEmployeeExecution.ts`、`nodeExecution.ts`、
  `executionWorkspaceBinding.ts`、`sqliteTaskExecutionContext.ts` 各 1 行的运行时绑定），由后继承接；`crewstation*` 待 RFC-370 余项；
  source-control、resource-catalog 等模块的余项与 S10 收口另立。
