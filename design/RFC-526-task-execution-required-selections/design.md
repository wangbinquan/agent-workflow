# RFC-526 设计：任务执行的适配器回落改为必填注入

## 1. 现状（HEAD，源码实读）

RFC-521 门登记的 16 处（路径在 `packages/backend/src/modules/task-execution/composition/` 下）：

| #     | 位置                                                                                   | 回落                                                                                         | 生产调用方                                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `bootRecovery.ts` `runTaskExecutionBootRecovery`                                       | 不给 `recoveryEffects` → 本机执行恢复工厂                                                    | daemon 应用总给部署选择的 `bootExecutionRecovery`                                                                                                                 |
| 2     | `commitPushBinding.ts` `readCommitExcludePatterns`                                     | 不给 `operationConfiguration` → 按运行参数的 `configPath` 造本机配置文件实现（空则没有配置） | 没有任何调用方给 `operationConfiguration`：两种部署每次提交都由回落按 `configPath`（`Paths.config`）读本机配置文件                                                |
| 3     | `digitalEmployeeExecution.ts`（私有的 `digitalEmployeeExecutionPorts`）                | 不给 `programs` → 应用根目录下的本机程序工具源；`appHome` 只为它存在                         | daemon 的数字员工装配总给部署选择的程序工件源；`composeDigitalEmployeeExecutionCore` 没有生产调用方                                                               |
| 4～6  | `launchConfiguration.ts` `composeTaskLaunchConfiguration`                              | `selectedQueries === undefined ? 本机读取 : 选定查询`，`selectedQueries` 由 `kind` 推出      | daemon 启动按应用配置的绑定显式选 `local-sync` 或 `selected`——不是回落，写法让它像回落                                                                            |
| 7、8  | `nodeRunPrompts.ts` `selectNodeRunPromptOperations` / `composeNodeRunPromptOperations` | 不给 → 运行目录（缺省 `Paths.runsDir`）下的本机提示内容                                      | 单机部署自己的选择就是 `composeNodeRunPromptOperations(undefined, <appHome>/runs)`；`select*` 的三个调用方（task-execution infrastructure）在 daemon 里都拿到选择 |
| 9～11 | `portArtifacts.ts` 两个 `select*` 与 `composePortArtifactOperations`                   | 不给 → 应用根目录（缺省 `Paths.root`）下的本机端口工件内容                                   | 单机部署的选择是 `composePortArtifactOperations(undefined, appHome)`，托管给托管内容；`selectPortArtifactReader`（public）的两个调用方在 daemon 里都拿到选择      |
| 12    | `providerRuntime.ts` `composeTaskExecutionProviderRuntime`                             | 不给 `workspaceExcludeProfilesFor` → 本机工作区排除档案                                      | daemon 总给（选择里 `Required<…>`）                                                                                                                               |
| 13    | `runtimeConfigFreeze.ts` `freezeBinaryConfig`                                          | 同 #2：按 `configPath` 造本机配置文件实现                                                    | 单机的本机 agent 运行族每次冻结运行时可执行文件都走回落                                                                                                           |
| 14    | `taskArchiveMaintenance.ts` `createDrizzleTaskArchiveMaintenanceCommand`               | 第三个参数缺省 `{}`，不给 `content` → 本机归档内容                                           | provider 运行期总给部署选择的；维护 worker 交 `workerEffects?.taskArchive`，单机为 `null`——一直由回落造                                                           |
| 15    | `taskDeletionEffects.ts` `selectedTaskDeletionEffects`                                 | 不给 → 本机删除效果（运行文件 + git 工作树）                                                 | 四个调用方都在 task-execution infrastructure，daemon 都拿到部署选择；其中一处只在内容效果没给时走到，而它唯一的调用方总给                                         |
| 16    | `taskExecutionPersistence.ts` `createTaskRuntimeLifecyclePersistence`                  | 第二个参数缺省 `{}`，不给 `workspacePresence` → 本机文件存在性                               | daemon 的任务执行装配给部署选择的；维护 worker、数字员工执行里的任务取消与人审停靠都不给——一直是本机文件判断                                                      |

补充事实：

- **操作配置的通路已经在**：运行参数（`RunTaskOptions.operationConfiguration`，注释写着“bootstrap 每次驱动都给，子任务也给，不进子任务的运行
  配置”）、驱动参与者的输入与本机运行族的绑定都有这一项，只是 daemon 从来不给。生产里唯一的驱动入口是驱动参与者的 `drive`
  （`infrastructure/taskExecutionRuntimeParticipants.ts`），它把输入里的 `operationConfiguration` 并进每次驱动的参数，再交给运行族的绑定。本机
  配置文件实现每次读取时才 `loadConfig(configPath)`，不缓存。`configPath` 本身在可继承的运行配置键里（子任务与续跑照旧带它），不删。
- **工作区存在性只在复活转移时查询**：`DrizzleTaskRuntimeLifecyclePersistence.set` 只在 `allowTerminal` 且从终态转到非终态时检查工作区是否还在；
  任务取消的目标是终态 `canceled`，人审停靠从运行态转入等待人审，都不是复活转移，存在性在这几条路径上不会被查询。
- **人审停靠的调用方在 collaboration**：澄清与评审的两处 `parkPreparedHumanGate` 调用经 task-execution 的 public 命令进来，它们已经持有 bootstrap 交
  入的 `TaskExecutionParticipantBindings`（`bootstrap/crossContextClosure.ts` 的 `composeTaskExecutionParticipantBindings` 装配）。
- **provider 运行期的旧版一支**：`bindProviderTaskRunParticipantsInput` 在没给 `taskRunBinding` 时用调用方给的 `taskAgentRunsFor` /
  `taskScriptRunsFor` 装旧版绑定，节点提示与端口工件缺了就取 provider 运行期交的缺省（`composeNodeRunPromptOperations(undefined, …)` 与
  `composePortArtifactOperations(undefined, …)`）。daemon 总给 `taskRunBinding`，这一支只有用例走。
- `composition/humanGate.ts` 的 `settleManualQuestionParkObligations` 没有任何调用方（生产与用例都没有）。

## 2. 机制与落位

### D1 启动恢复与数字员工执行

- `TaskExecutionBootRecoveryInput.recoveryEffects` 必填（application 的端口类型）；`runTaskExecutionBootRecovery` 只取给的工厂。
- 数字员工执行的 `programs` 必填，只为回落存在的 `appHome` 删去（daemon 的装配随之不再交它）。

### D2 操作配置

- daemon 的任务执行装配把 `operationConfiguration: createFileTaskOperationConfiguration(configPath)` 交给 provider 运行期的驱动参与者输入（模块根组合层
  已经转出这个本机实现；`configPath` 就是此前回落用的那一个），于是每次驱动（根任务、子任务、续跑）都带上同一份，读取仍在每次提交与每次冻结
  时发生。
- `readCommitExcludePatterns` 与 `freezeBinaryConfig` 只取给的配置：没给就是“没有操作配置”，与此前没给 `configPath` 一样；删去按 `configPath` 造本
  机实现的两支。本机运行族绑定的请求里只为回落存在的 `configPath` 删去。

### D3 启动配置

- `composeTaskLaunchConfiguration` 按 `input.kind` 显式装配两支：`local-sync` 一支每次读调用方给的同步读取，`selected` 一支每次读选定的查询（含
  准备配置）；返回的形状、`selectedQueries` 与 `continuationQueries` 不变。

### D4 节点提示、端口工件与删除效果

- `composeNodeRunPromptOperations(content)` 与 `composePortArtifactOperations(content)` 只收必填的内容效果（删去缺省目录参数）；两个组合层转出本机内
  容实现（`createFileNodeRunPromptContent` / `createFilePortArtifactContent`），单机部署在 `bootstrap/standalone.ts` 用同一组参数显式构造。
- 删去 task-execution 内部的 `selectNodeRunPromptOperations`、`selectPortArtifactOperations` 与 `selectedTaskDeletionEffects`：调用方（infrastructure
  里的会话树读取、任务路由操作、任务删除与删除恢复）的选择改为必填，在原来的位置照旧用 application 的 `require*` 核对。
- public 的 `selectPortArtifactReader` 保留名字，`selected` 必填、只做核对（删去缺省目录参数）；collaboration 的评审与端口工件路由的选择改为必填
  （daemon 一直给）。
- 任务删除恢复里“内容效果没给就取本机的”一支的唯一调用方总给内容效果，改为必填。

### D5 provider 运行期与归档

- `workspaceExcludeProfilesFor` 与 `archive` 必填（daemon 都给）。旧版一支的节点提示与端口工件改为必填，删去 `bindProviderTaskRunParticipantsInput`
  的缺省参数。
- `createDrizzleTaskArchiveMaintenanceCommand` 的第三个参数必填、`content` 必填；维护 worker 写 `workerEffects?.taskArchive ?? { content:
createFileTaskArchiveContent() }`（组合层已经转出它；单机部署的选择本来就是这一项）。

### D6 运行生命周期的工作区存在性

- `TaskExecutionPersistenceDependencies.workspacePresence` 与 `createTaskRuntimeLifecyclePersistence` 的依赖必填（删去缺省参数）。
- 维护 worker 显式给本机文件存在性（经 source-control 组合层，与此前回落相同的对象，两种部署照旧）。
- 任务取消：`composeTaskCancellation` 与数字员工执行的 `composeDatabaseDigitalEmployeeExecutionPorts` 收必填的 `workspacePresence`，daemon 的数字员工装
  配交部署选择的。
- 人审停靠：`TaskExecutionParticipantBindings` 增一项 `workspacePresence`，由 `composeCrossContextClosure` 的调用方交入（daemon 交部署选择的，维护
  worker 交本机文件的）；澄清与评审的两处停靠从绑定里取。
- 取消与停靠不做复活转移，存在性不会被查询，改交部署选择的不改变行为；daemon 之外的形态（托管部署）此后在这几条路径上也拿到自己的存在性。

### D7 用例与测试助手

- 测试助手按此前回落逐项构造单机选择（只在用例没给时造）；tsc 列出的调用逐处改为显式给出（量大的按 AST 脚本改）；钉旧形状与回落原文的锁随
  改：按被删的名字、选项与回落原文片段扫描，再按被改文件的路径筛出读取其源码的全部用例（RFC-525 的教训）；改共享测试助手时不盖掉用例经展开
  传入的同名值。

### D8 门与锁

- RFC-521 门删去 16 条登记，适配器回落 35 → 19；`SUCCESSORS` 删去 task-execution。计数降的收紧到实测；新增 RFC-526 用例并登记 guard-manifest。

## 3. 清单（退出门）

| 名字                                                                                                                                                                                                                                                                   | 之后               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `selectNodeRunPromptOperations`、`selectPortArtifactOperations`、`selectedTaskDeletionEffects`（连同 infrastructure 的转出）、两个组合层入口的缺省目录参数、`bindProviderTaskRunParticipantsInput` 的缺省参数、数字员工执行的 `appHome`、本机运行族请求的 `configPath` | 删去               |
| `selectPortArtifactReader`                                                                                                                                                                                                                                             | 保留名字，选择必填 |
| `TaskExecutionParticipantBindings.workspacePresence`、两个组合层对本机内容实现的转出                                                                                                                                                                                   | 新增               |

## 4. 用例

新增 `packages/backend/tests/rfc526-task-execution-required-selections-boundary.test.ts`，登记 guard-manifest：

- ① 选项必填：逐个钉住各入口的入参成员（可选标记一并钉）。
- ② bootstrap 不取 task-execution 的 infrastructure；删去的名字与选项在生产代码里不再出现（语料下限 3,000，先按名字文本筛、给语料用例时限）。
- ③ 装配处的显式构造逐处钉住：daemon 交给驱动参与者的操作配置、单机部署的节点提示与端口工件、维护 worker 的归档内容与工作区存在性、取消与人审
  停靠的工作区存在性。
- ④ 行为：启动配置两支各自只读调用方给的读取；操作配置在每次读取时才读配置文件；测试助手只在没给时构造、给了原样交出。
- ⑤ 负对照。

## 5. 失败模式

- **改变构造时机或参数**：本机实现在原来回落发生的位置、用同一组参数构造；操作配置每次读取时才读文件，装配时构造一次与此前每次构造等价。
- **漏给驱动参数**：生产只有一个驱动入口，操作配置交在它的输入上；用例按 tsc 与被改文件的路径筛出。
- **按原文或按 AST 钉住旧形状的锁、共享测试助手盖掉用例的值**：RFC-524 / RFC-525 的教训（`docs/dev-gotchas.md`）。
- **移走或删去后成为不可达文件、未消费符号**：架构报告对照。

## 6. 取舍（可推翻）

1. **操作配置保留可选**：没给就是“没有操作配置”（只用运行参数里的排除模式、不折入配置文件的可执行文件），是一种合法选择而不是回落；生产由 daemon
   每次驱动都给。改为必填会让每个直接驱动的用例都要造一份配置，收益不抵改动面。
2. **取消与停靠改交部署选择的存在性**，而不是照搬本机文件：这几条路径不查询存在性，行为不变；部署选择才是这一项应有的来源。维护 worker 没有部署
   选择的存在性，照旧显式给本机文件的。
3. **public 的 `selectPortArtifactReader` 保留名字**：public 合同不改名，消费方只需不再依赖缺省；task-execution 内部的 `select*` 直接删去。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只装配；单机选择经组合层交出，bootstrap 选择。
- **C11**：public 不新增符号；`selectPortArtifactReader` 的签名收紧。
- **C12**：RFC-526 用例覆盖全部生产文件里的同名选项与 bootstrap 的取用；RFC-521 门覆盖全部组合层。
- **C13**：计数不升，降的收紧到实测；适配器回落 35 → 19。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 1 项第六步；task-execution 的组合层不再替调用方造适配器；task-execution infrastructure 不再为取选择而回头导入组合层的 `select*`。
- **留下**：bootstrap 里的单机选择与维护 worker 的单机效果一并收进 `bootstrap/standalone.ts`（另立后继）；`composition/humanGate.ts` 里没有调用方的
  `settleManualQuestionParkObligations`（本 RFC 只随类型收紧，删除留给清理）；第 1 项最后一步：source-control（19）。
