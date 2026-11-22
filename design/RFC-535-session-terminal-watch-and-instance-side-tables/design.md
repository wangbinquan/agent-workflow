# RFC-535 技术设计

## 1. 现状（HEAD `252c54a28`，源码实读）

- **终态看门**（task-execution `infrastructure/executionWatch.ts`）：模块级 `const watchers = new Map<string, Set<Resolver>>()`（第 28 行）；
  `notifyTaskTerminal(taskId, to)` 在 `to` 是终态时取出并唤醒该任务的全部等待者；`watchTaskTerminal(source, taskId, opts)` 先读一次、登记、
  再读一次，另起平台定时原语的轮询（缺省 20 秒），中止给 `aborted`、行被删给 `missing`；`resetTaskTerminalWatchersForTests()` 清表。
  - 唤醒：daemon 会话的已提交事件消费者（`bootstrap/daemonSession.ts` 第 432 行，经 `composition.ts` 第 184 行转出的 `notifyTaskTerminal`）。
  - 等待：子调用节点 `composition/childCallNodeExecution.ts` 第 175 行（`state.opts.persistence.reads.statusProjection`）；动作执行
    `composition/actionExecutionEnvironment.ts` 第 79 行的 `awaitTerminal`（`deps.readModels.statusProjection`；依赖由 daemon 的开发自动化
    装配以 `...taskExecutionModules.hostTasks` 展开交入）。
  - 维护 Worker 不跑子调用节点与动作执行，不读写这张表。
- **执行参与者**（`infrastructure/local/agentExecutionEffect.ts`）：模块级 `const nativeTaskParticipants = new WeakMap<object, …>()`（第 206 行）；
  `bindLocalAgentExecutionParticipants(input)` 造一个冻结的空对象作参与者、记进表；`resolveLocalAgentExecutionParticipants(participants)` 查表，
  查不到抛 `agent-execution-task-participant-unavailable`。签发处是本机任务代理运行族（`local/taskAgentRunFamily.ts` 第 203 行），解读处是本机
  调用（`local/agentInvocation.ts` 第 112 行）。port 上它是不透明的品牌类型（`application/ports/agentExecutionBinding.ts`）。
- **迁移对照范围**（`infrastructure/migration/oracle/scope.ts`）：模块级 `const scopes = new WeakMap<readonly OracleRunRow[], OracleSnapshotScope>()`
  （第 14 行）；`bindOracleSnapshotScope(rows, scope)` 校验 `node` 范围后记表（`snapshot.ts` 第 73、79 行对快照自己建的每个任务行数组调它）；
  `requireSupersessionScope` / `requireTaskLabelScope` 查表（`pickers.ts`、`rows.ts` 共 8 处），没登记的数组按完整任务处理。
- **工作区读取能力**（`infrastructure/workspaceRead.ts`）：模块级 `const liveWorkspaceReads = new WeakSet<…>()`（第 21 行）；
  `bindTaskWorkspaceReadScope` 建能力时加入、`close()` 时删去；`assertBound` 判定 `!live || candidate !== capability || !liveWorkspaceReads.has(candidate)`。
  能力只在本作用域里建、只在 `close()` 时删，而 `close()` 同时把 `live` 置假：集合那一项从不单独决定结果。
- **材料引用**（runtime-management `infrastructure/local/agentMaterialCompiler.ts`）：模块级 `const nativeMaterialReferences = new WeakMap<object, string>()`
  （第 21 行）；编译器编出计划时记 `计划 → 引用`（第 146 行）；`bindNativeAgentMaterialReference(plan, sourcePlan?)` 先查计划、再查源计划、都没有
  时新发一个引用并记下。材料定义（`local/localAgentMaterialDefinition.ts`）的 `materialReference` 就是它；`drivers/index.ts` 另有一个只被用例
  用到的别名 `getNativeAgentMaterialReference`。每次运行由运行族调一次 `materialDefinitions(kind)` 取一份定义，同一份定义既建编译器、又查引用
  （`taskAgentRunFamily.ts` 的 `selectMaterial`、`nativeSystemAgentRun.ts` 第 230 / 293 / 362 行、`runtimeSmokeRunFamily.ts`、`systemAgentRunFamily.ts`）。
  遗留的 `compileLegacyNativeAgentMaterial`（`legacyAgentMaterialBinding.ts`）临时建一个编译器、只交出编好的计划。
- 架构报告的模块级可变单例清单里这五个文件各 1 条（`resetTaskTerminalWatchersForTests`、`bindLocalAgentExecutionParticipants`、
  `bindOracleSnapshotScope`、`bindTaskWorkspaceReadScope`、`bindNativeAgentMaterialReference`），全仓 66 条。

## 2. 机制与落位

### D1 终态看门由会话构造

- `executionWatch.ts` 删去模块级表与三个函数，改为 `createTaskTerminalWatch(): TaskTerminalWatch`（`notify(taskId, to)` 与
  `watch(source, taskId, opts?)`；逻辑逐字搬进闭包，每份看门一张表）。`composition.ts` 改转出工厂与类型（不再转出 `notifyTaskTerminal`）。
- 构造：`bootstrap/daemonModules/taskExecution.ts` 在子任务预算旁建一份；同一个对象进运行期参与者（`BoundRunTaskOptions.terminalWatch`，
  子调用节点读它）、`hostTasks`（开发自动化的动作执行依赖 `ActionExecutionEnvironmentDependencies.terminalWatch` 经展开取到）与模块集合
  （daemon 会话的已提交事件消费者调 `terminalWatch.notify`）。
- 字段都必填：运行期选项与动作执行依赖不再有“取进程级那一份”的路径。测试拓扑与动作执行的用例助手各建一份（需要唤醒的用例拿到同一份）。

### D2 参与者自带解读

- `agentExecutionEffect.ts` 删去模块级表：参与者是本文件里一个类的实例，私有字段装着本机持久化与节点执行；签发即构造（冻结），解读按
  `#native in reference` 判定后取私有字段，不是本类实例的照旧抛 `agent-execution-task-participant-unavailable`。只有本文件能读私有字段，
  “只由签发它的本机实现解读”不变；port 上的不透明品牌类型不变。

### D3 对照范围随行数组走

- `scope.ts` 删去模块级表：范围记在快照自己建的行数组上（模块常量的符号作键、`Object.defineProperty` 不可枚举、不可写）；两个 `require*`
  从数组本身读，没有这个属性的数组照旧按完整任务处理。`node` 范围的逐行校验不变。`snapshot.ts` 的两处调用不变（函数改名为
  `scopeOracleSnapshotRows`，表明它给数组盖范围）。

### D4 能力登记表归读取作用域

- `workspaceRead.ts` 删去模块级的 `liveWorkspaceReads`：每个读取作用域建一张私有的 `WeakSet`，作用域发出的能力记进去、`close()` 时删去，
  `assertBound` 照旧判“未关闭、是同一个对象、在登记表里”。RFC-294 的能力伪造门要求能力的工厂所在文件有私有的运行期登记表
  （`new WeakMap` / `new WeakSet`），登记表因此挪进作用域、不删（补正：初版把它当成多余删了，CI 的能力伪造门红，见 plan 的 CI 一节）。

### D5 材料引用归材料定义

- `agentMaterialCompiler.ts` 删去模块级表与 `bindNativeAgentMaterialReference`，导出 `createNativeAgentMaterialReferences()`（一张引用表：
  `reference(plan, sourcePlan?)` 的取值规则逐字搬入，另有编译器用的 `record(plan, materialRef)`）；`createLocalAgentMaterialCompiler` 的输入加
  必填的 `references`，编出计划时记进它。
- `selectLocalAgentMaterialDefinition(kind)` 每份定义建一张表：`materialReference` 查它、`createCompiler` 把它交给编译器——同一次运行里编译与
  查引用走同一份定义，取值与此前相同。遗留编译 `compileLegacyNativeAgentMaterial` 自建一张（它只交出计划，正常消费者留的是引用而不是计划）。
  删去 `drivers/index.ts` 只被用例用到的别名。

### D6 用例与锁

- 新增 `tests/rfc535-session-terminal-watch-and-instance-side-tables-boundary.test.ts`，登记 guard-manifest：① 五个文件顶层没有 `let` 与
  `new Map / Set / WeakMap / WeakSet`，没有导出的 `set*` / `bind*` / `register*` / `reset*` 写模块状态；生产代码不再引用删去的名字；daemon 的
  task-execution 装配建一份看门并交给运行期参与者、`hostTasks` 与模块集合，会话的已提交事件消费者调 `terminalWatch.notify`（语料下限
  3,000）；② 行为：两份看门互不唤醒；参与者只认本类实例；对照范围记在数组上、没盖范围的数组按完整任务；关闭后的工作区读取能力被拒；两份
  材料定义的引用表互不相通、同一份定义里编译与查引用一致；带负对照。
- 读旧形状的用例随改：`rfc243-call-workflow`、`rfc243-executor-facade`、`rfc359-w8-task-route-capability-parity`、`rfc456-services-single-owner-placement`、
  `rfc359-t3-action-execution-runners`、`tests/helpers/executionTerminal.ts` 与 `tests/architecture/rfc359-w5-dual-engine-predicate-gaps` 改用看门实例；
  构造运行期参与者的测试拓扑（`taskExecutionTestTopology`、`eachProviderTaskExecution`、`providerHttpApplication` 等，RFC-533 加子任务预算的
  同一批）补看门；材料引用的用例（`rfc370-*`、`rfc489`、`rfc491`、`tests/helpers/nativeRuntimeSmoke.ts`）改用定义或引用表；参与者的用例
  （`rfc370-agent-invocation-binding`、`tests/helpers/nativeTaskAgentRun.ts`）照旧经签发函数取得。

## 3. 清单（退出门）

| 名字                                                                                                | 之后                                                        |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `watchers` / `notifyTaskTerminal` / `watchTaskTerminal` / `resetTaskTerminalWatchersForTests`       | 删去；`createTaskTerminalWatch()`，每会话一份               |
| `nativeTaskParticipants`                                                                            | 删去；参与者是带私有字段的实例                              |
| `scopes` / `bindOracleSnapshotScope`                                                                | 删去；`scopeOracleSnapshotRows` 把范围盖在数组上            |
| `liveWorkspaceReads`                                                                                | 删去；每个读取作用域一张私有登记表                          |
| `nativeMaterialReferences` / `bindNativeAgentMaterialReference` / `getNativeAgentMaterialReference` | 删去；`createNativeAgentMaterialReferences()`，每份定义一张 |

## 4. 用例

- ① ～ ② 见 D6；既有用例覆盖调用子工作流的等待与唤醒（`rfc243-*`）、动作执行的终态回调（`rfc359-t3-action-execution-runners`）、本机调用的
  参与者解析（`rfc370-agent-invocation-binding`）、迁移对照（`rfc359-*-oracle*`、`rfc395-*`）、工作区读取（`rfc359-w8-task-route-capability-parity`）
  与材料编译（`rfc370-agent-material-compiler`、`rfc370-execution-effect`、`rfc489`、`rfc491`）。

## 5. 失败模式

- **漏交看门**：字段必填，`tsc` 管住类型检查得到的装配点；以 `as unknown as` / `as never` 伪造运行期选项或依赖的用例按 `docs/dev-gotchas.md`
  全仓搜一遍补上。
- **唤醒与等待用了两份看门**：RFC-535 用例钉 daemon 把同一份看门交给运行期参与者、`hostTasks` 与模块集合，且会话的消费者调的是模块集合上的
  那一份；漏唤醒时仍有轮询兜底（语义不变），但用例按唤醒断言。
- **跨定义查材料引用**：生产里同一次运行只用一份定义；用例里跨定义比较引用的断言改为同一份定义内比较，并加“两份定义互不相通”的负对照。

## 6. 取舍（可推翻）

1. **看门随子任务预算走同一条路**：两者都是会话级、都要进运行期选项与模块集合，沿用 RFC-533 的交入路径，不另开依赖链。
2. **参与者用私有字段而不是每族一张表**：签发与解读都在本文件，私有字段就是“只有签发者能读”的语言级表达；每族一张表要把表从运行族一路交到
   本机调用，徒增接线。
3. **对照范围盖在数组上而不是改签名**：八个取行助手都以行数组为参数，没盖范围的数组按完整任务是既有约定；把范围改成显式参数要改全部助手
   与调用方。数组是快照自己建的，盖一个不可枚举的符号属性不改变它的内容与相等性。
4. **材料引用表归定义而不是会话**：编译与查引用的配对单位是“一次运行取到的一份定义”，归会话反而要把表穿过运行族的提供者。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只把依赖往下交（daemon 的 task-execution 装配多建一份看门）。**C11**：各模块 public 不变；task-execution 的 composition 改转出
  看门的工厂与类型。**C12**：RFC-535 用例覆盖。**C13**：计数不升，模块级可变单例 66 → 61。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第三步（终态看门与四张按对象挂的侧表，5 条）。
- **留下**：其余 61 条（`transport-projections` / ws 的登记、配置生效监听、平台持久化的 schema 绑定、platform / util 的进程级缓存；后者需要保留
  的由后继 design 提出、经用户确认后修订 §14 口径）。
