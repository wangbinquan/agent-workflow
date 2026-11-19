# RFC-509 设计：开发自动化组合层的非 RFC-370 余项迁出 composition

## 1. 现状（HEAD `f07489c9c`，源码实读）

development-automation 组合层控制流（F13 口径，按语法树计数）102 行，RFC-370 的 `crewstation*` / `taskImage*` 占 80 行；其余 7 个文件 22 行，
都不在 `composition-forbidden-import-files` 里，已没有循环：

| 文件（`composition/` 下）         | 行数 | 控制流（行号）                                |
| --------------------------------- | ---- | --------------------------------------------- |
| `graphDeliveryLifecycle.ts`       | 290  | 6：第 62、168、208、221、239、265 行 `if`     |
| `activityOperations.ts`           | 46   | 5：第 33、35、39、40、42 行 `if`              |
| `graphDeliveryJob.ts`             | 178  | 4：第 62、103、114 行 `if`，第 104 行 `throw` |
| `evidenceStaging.ts`              | 61   | 3：第 38、40 行 `if`，第 41 行 `throw`        |
| `employeeCaseDetailProjection.ts` | 177  | 2：第 32 行 `if`，第 33 行 `try`              |
| `executionTerminalObserver.ts`    | 52   | 1：第 23 行 `if`                              |
| `repositoryFactsScanner.ts`       | 15   | 1：第 12 行 `if`                              |

（第 62、114 行的 `if` 与 `throw` 同一行，按一行计。）

**`graphDeliveryLifecycle.ts`**：第 1～14 行 import（zod、digital-employee public types 的四个类型、domain 的
`isMergeRequestLifecycleWorkItem`、组合层的登记对象 `developmentEmployeeTypePackage`、application 的 `issueHandlingContextSchema`、
`mergeRequestLifecycleDescriptor` 与 `mergeRequestLifecycleRuntimeCodec`）；第 16～18 行类型 `RuntimeCodec`；第 20～49 行 `recordSchema` 与
`coreDescriptorSchema`；第 51 行 `GRAPH_DELIVERY_EMPLOYEE_TYPE`；第 53～144 行 `composeGraphDeliveryLifecycleTypePackage(core)`（解析 graph@1 的
描述，缺 `deliver-result` 工作项时抛 `graph-delivery-work-item-missing`，并入 MR 生命周期的工作契约、区域、工作项、上下文、事件、关注与反应
规则、调用契约；契约夹具的校验按 `graph-development.` 前缀交给 `core` 或 `developmentEmployeeTypePackage`）；第 146～152 行三个 schema；
第 154～290 行 `composeGraphDeliveryLifecycleRuntimeCodec(core)`（按工作项分派给 MR 生命周期或 `core`；graph@2 的新案例给主上下文的请求记
`deliveryMode: 'merge-request'`；`deliver-result` 的结算在 MR 已发布且是 MR 交付时转去 `observe-mr`；被调用的案例在 graph@2 时经 MR
生命周期的入口再按图建案例）。使用方：bootstrap `daemonModules/digitalEmployee.ts`；本文件的 `GRAPH_DELIVERY_EMPLOYEE_TYPE` 另被
`graphDeliveryJob.ts` 取；用例 `rfc396-mr-job`、`rfc396-mr-lifecycle`、`rfc396-mr-runtime-wiring`。

**`graphDeliveryJob.ts`**：整个文件是实现：第 1～3 行 import（zod、digital-employee 的工具目录参与者类型、`GRAPH_DELIVERY_EMPLOYEE_TYPE`），
第 5～6 行两个作业 id，第 7～39 行三个 schema，第 41～178 行 `buildGraphDeliveryJobs(input)`（按工作项从目录取可选、已发布、类型与工作项相符的
工具并按 id 排序；缺工具抛 `graph-mr-job-tool-missing:<workItemRef>`，分类器没有路由或兜底不是恰好一条抛
`graph-mr-job-classifier-routes-missing`，某条路由没有修复者抛 `graph-mr-job-repair-route-missing:<routeRef>`；给出默认作业、流水线作业
草稿、配置链接与待配置项）。使用方：bootstrap `daemonModules/digitalEmployee.ts`；用例 `rfc396-mr-job`。

**`activityOperations.ts`**：第 3～10 行接口 `DevelopmentActivityWorker`；第 12～26 行装配说明（RFC-359 W11：worker 是必填实参）；第 27～46 行
`composeDevelopmentActivityOperations(worker)`，返回冻结的 `runOneWorkerCycle`：依次问通道结果、outbox、派发、交付、反应规划，第一个不空闲
的就返回，都空闲时返回执行巡检的结果。使用方：bootstrap `daemonModules/digitalEmployee.ts`；用例 `rfc344-operation-catalog`、
`rfc359-w11-composition-root-lexical-binding`（后者钉住本文件运行时只导出 `composeDevelopmentActivityOperations`）。
`application/activityOperations.ts` 已有 `DevelopmentActivityOperations`、`DevelopmentActivityResult` 与操作定义。

**`evidenceStaging.ts`**：第 1～13 行转出 infrastructure 的本地暂存与端口类型，第 61 行转出两个文档写入器工厂；第 28～59 行
`composeRequirementMaterializerContent(input)`：给了 `staging`（选定内容）时核对暂存工厂（`assertEvidenceStagingFactory`）与文档写入器
（`writeDocument` 不是函数时抛 `requirement-selected-content-incomplete:documentCommands`）后原样交出；否则用给定的或本地的文档写入器与本地暂存
工厂。使用方：本模块 `composition.ts`（对象字面量入参）。

**`employeeCaseDetailProjection.ts`**：第 1～15 行 import；第 17～58 行类型 `DetailContext` 与三个辅助函数（`latestContext` 取同类型里最新的
上下文；`parseVersionOneContext` 只认 1 版，解析失败返回 null；`unknownInput`）；第 60～161 行 `projectDevelopmentEmployeeCaseDetail(input)`；
第 163～177 行参与者 `composeDevelopmentEmployeeCaseDetailProjection(workspaces)`（解析输入、读案例的工作区、投影后序列化）。使用方：
bootstrap `daemonModules/digitalEmployee.ts`（参与者）、本模块 `composition/graphDevelopment.ts`（投影）；用例 `rfc337`（投影）、
`rfc310-employee-case-runtime`（参与者）。

**`executionTerminalObserver.ts`**：第 9～12 行接口 `DevelopmentMissionExecutionTerminalObserver`；第 14～40 行 `observer(deps)`：按执行引用找
mission，找不到就返回；记一条唤醒提示（`id: ulid()`、`source: 'agent-execution'`、`deliveryKey: <前缀>:<执行引用>`、`now: Date.now()`），再
驱动 mission，驱动的拒绝被吞掉；第 42～52 行 `createDevelopmentMissionExecutionTerminalObserver({ db, drive })` 用 Mission 持久化与执行引用读面
装配它。使用方：bootstrap `daemonModules/developmentAutomation.ts`；本模块 `composition.ts` 转出入口与接口；用例 `rfc359-w14`；夹具
`rfc359-p0-mutations` 按本文件路径替换装配入口。

**`repositoryFactsScanner.ts`**：工作区有树操作时返回在卷上跑 `repository-facts-scan` 的扫描函数，否则返回 undefined（进程内扫描）。

## 2. 机制与落位

### D1 实现落 application

这些实现只做 JSON 与 zod 的变换、对本模块端口的编排与判断，没有 IO，是 application 的内容：

- 两个图交付文件放 `application/graph-development/`，与 RFC-498 的 `deliveryBridge.ts` 同处（同属 graph@2 的 MR 交付）。
- 活动周期并入 `application/activityOperations.ts`（周期的结果类型与操作接口已在这里）；选定内容的核对并入 `application/evidenceStaging.ts`
  （`assertEvidenceStagingFactory` 已在这里）。
- 案例详情投影与执行终态唤醒各成一个新文件。

### D2 装配期选择留在组合层

`evidenceStaging.ts` 第 38 行按是否给了选定暂存选实现，`repositoryFactsScanner.ts` 第 12 行按工作区有无树操作选扫描方式：两处都在装配时决定
用哪个实现，是组合层的本职，计入 S10 的上限（design §8）。

### D3 新位置

- **`application/graph-development/deliveryLifecycle.ts`**（新）：原第 16～51 行与第 146～152 行逐字（`RuntimeCodec` 仍是文件内类型，另导出别名
  `GraphDeliveryLifecycleRuntimeCodec`）；`createGraphDeliveryLifecycleTypePackage(core, development)` 的函数体是原第 57～143 行，唯一的替换是
  `developmentEmployeeTypePackage` → `development`（类型 `Pick<EmployeeTypePackageRegistration, 'validateContractFixtureJson'>`，装配传入的就是
  原来那个登记对象，方法的接收者不变）；`createGraphDeliveryLifecycleRuntimeCodec(core)` 的函数体是原第 159～289 行逐字。
- **`application/graph-development/deliveryJobs.ts`**（新）：原第 5～178 行逐字；`GRAPH_DELIVERY_EMPLOYEE_TYPE` 改取 `./deliveryLifecycle`。
- **`application/employeeCaseDetailProjection.ts`**（新）：原第 17～161 行逐字；参与者实现 `createDevelopmentEmployeeCaseDetailProjection(workspaces)`
  的函数体是原第 165～176 行逐字。
- **`application/activityOperations.ts`**（增）：`DevelopmentActivityWorker`（原第 3～10 行逐字）与 `createDevelopmentActivityWorkerCycle(worker)`
  （函数体是原第 30～45 行逐字）。
- **`application/executionTerminalObserver.ts`**（新）：`DevelopmentMissionExecutionTerminalObserver`（原第 9～12 行逐字）、依赖接口
  `DevelopmentMissionExecutionTerminalObserverDependencies`（原 `observer` 的三个依赖加 `newId: () => string`、`now: () => number`）与
  `createMissionExecutionTerminalObserver(deps)`（函数体是原第 19～39 行，替换两处：`ulid()` → `deps.newId()`、`Date.now()` → `deps.now()`）。
- **`application/evidenceStaging.ts`**（增）：`selectedRequirementMaterializerContent(input)`，入参是 `{ staging, documentCommands }`，函数体是
  原第 39～43 行逐字。

### D4 composition 只装配

- `graphDeliveryLifecycle.ts`：转出 `GRAPH_DELIVERY_EMPLOYEE_TYPE`；`composeGraphDeliveryLifecycleTypePackage(core)` 返回
  `createGraphDeliveryLifecycleTypePackage(core, developmentEmployeeTypePackage)`；`composeGraphDeliveryLifecycleRuntimeCodec(core)` 返回
  `createGraphDeliveryLifecycleRuntimeCodec(core)`。签名不变（入参与返回的类型与原来结构相同）。
- `graphDeliveryJob.ts`：只转出 `GRAPH_MR_JOB_ID`、`GRAPH_MR_PIPELINE_JOB_ID` 与 `buildGraphDeliveryJobs`。
- `activityOperations.ts`：转出 `DevelopmentActivityWorker` 类型；装配说明与 `composeDevelopmentActivityOperations(worker)` 保留，返回
  `createDevelopmentActivityWorkerCycle(worker)`。运行时仍只导出这一个函数。
- `evidenceStaging.ts`：选定分支改为 `return selectedRequirementMaterializerContent({ staging: input.staging, documentCommands: input.documentCommands })`；
  本地分支与转出不变。
- `employeeCaseDetailProjection.ts`：转出 `projectDevelopmentEmployeeCaseDetail`；`composeDevelopmentEmployeeCaseDetailProjection(workspaces)`
  返回 `createDevelopmentEmployeeCaseDetailProjection(workspaces)`。
- `executionTerminalObserver.ts`：转出接口；`createDevelopmentMissionExecutionTerminalObserver({ db, drive })` 交入 Mission 持久化、执行引用读面、
  `drive`、`newId: () => ulid()` 与 `now: () => Date.now()`。
- 不再用到的 import 删去。`repositoryFactsScanner.ts` 不改。

### D5 锁与账本

- `architecture/counts.json`：`composition-control-flow-development-automation` 102 → 实测（预计 82）。`guard-manifest.json` 登记 RFC-509 用例
  （`assertsAbsence: true`）。
- `design/RFC-310-rule-driven-development-digital-employee/os-architecture-manifest.json`：digital-employee 的 `externalImports` 是取它的文件的
  精确清单（`rfc310-digital-employee-os-architecture` 逐条比对）。增三个新文件取 `public/types` 的条目，删 `composition/graphDeliveryJob.ts`
  的条目（它只剩转出）；`composition/employeeCaseDetailProjection.ts` 与 `composition/graphDeliveryLifecycle.ts` 的签名仍用 digital-employee 的
  类型，条目保留。
- 随代码改的锁（集中验证查出，见 §5）：`rfc344-operation-catalog` 有一段读 `composition/executionTerminalObserver.ts` 的原文，要求其中出现
  `missionIdOfExecutionRef` 与 `recordWakeHint`、不取 task-execution；`recordWakeHint` 随唤醒迁到 application 的新文件，这段改为同时读组合
  文件与新文件（组合文件里有 `missionIdOfExecutionRef`，新文件里有 `recordWakeHint`，两者都不取 task-execution），意图不变。
  `scripts/rfc359-p0-mutations.ts` 的指纹清单（变异运行前后核对目标文件未被改动，`rfc359-w14-p0-mutation-verdict` 断言每项存在）增
  application 的新文件，与 RFC-400、RFC-480 迁移时的做法一致；P0 夹具仍按组合文件路径替换装配入口，不改。
- 不改：RFC-396 的三个用例、`rfc337`、`rfc310-employee-case-runtime`、`rfc344` 的其余用例、`rfc359-w11`（运行时导出面）、`rfc359-w14`、
  `rfc359-p0` 夹具（按路径替换装配入口）、RFC-380 / RFC-317 / RFC-359 T3 读 bootstrap 原文的用例；`design/` 里的历史记述。

## 3. 清单（退出门）

| 位置（`packages/backend/src/modules/development-automation/` 下） | 声明并交出                                                                                                                                                  | 只声明不交出                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `application/graph-development/deliveryLifecycle.ts`（新）        | `GRAPH_DELIVERY_EMPLOYEE_TYPE`、`GraphDeliveryLifecycleRuntimeCodec`、`createGraphDeliveryLifecycleTypePackage`、`createGraphDeliveryLifecycleRuntimeCodec` | `RuntimeCodec`、`recordSchema`、`coreDescriptorSchema`、`typeRefSchema`、`initialRequestSchema`、`launchSchema` |
| `application/graph-development/deliveryJobs.ts`（新）             | `GRAPH_MR_JOB_ID`、`GRAPH_MR_PIPELINE_JOB_ID`、`buildGraphDeliveryJobs`                                                                                     | `exactRef`、`routeSchema`、`catalogToolSchema`                                                                  |
| `application/employeeCaseDetailProjection.ts`（新）               | `projectDevelopmentEmployeeCaseDetail`、`createDevelopmentEmployeeCaseDetailProjection`                                                                     | `DetailContext`、`latestContext`、`parseVersionOneContext`、`unknownInput`                                      |
| `application/executionTerminalObserver.ts`（新）                  | `DevelopmentMissionExecutionTerminalObserver`、`DevelopmentMissionExecutionTerminalObserverDependencies`、`createMissionExecutionTerminalObserver`          | —                                                                                                               |
| `application/activityOperations.ts`（增两个名字）                 | `DevelopmentActivityWorker`、`createDevelopmentActivityWorkerCycle`                                                                                         | —                                                                                                               |
| `application/evidenceStaging.ts`（增一个名字）                    | `selectedRequirementMaterializerContent`                                                                                                                    | —                                                                                                               |

允许的形状：6 个组合文件没有 for / while / do / switch / try / throw 语句；`if` 只有 `evidenceStaging.ts` 的选定或本地选择一处（另有不改的
`repositoryFactsScanner.ts` 一处）；它们只声明并导出原有的装配入口，转出原有的名字，从新位置取实现。

## 4. 用例

新增 `packages/backend/tests/rfc509-development-automation-composition-remainder-boundary.test.ts`（文件名带 `boundary`），登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字；6 个组合文件
  只声明并导出原有的装配入口，转出的名字不变（`activityOperations.ts` 运行时只导出装配入口）。
- ② 6 个组合文件的形状：控制流只剩 `evidenceStaging.ts` 的一处 `if`；不再出现迁走的代码要的名字（zod、`isMergeRequestLifecycleWorkItem`、
  `assertEvidenceStagingFactory`、三个上下文 schema 等）；`ulid` 与 `Date.now` 只在交给终态唤醒的两个函数里各出现一次；新入口在生产代码里只在
  各自的组合文件调用一次、实参逐字钉住；带负对照。
- ③ 新代码的依赖面是闭集：新文件与两个既有文件只取本模块的 domain、application、`application/ports`、zod 与 digital-employee 的
  `public/types`，不用进程全局；带负对照。
- ④ 行为（直接调用新位置，端口用内存替身）：活动周期的先后次序与“全空闲时返回执行巡检”；终态唤醒找不到 mission 时不记不驱动、记录的唤醒提示
  取装配传入的 id 与时刻、驱动失败不外抛；选定内容缺文档写入器时抛原文错误、齐全时原样交出；案例详情投影取最新上下文、只认 1 版、解析失败与
  没有议题时的留空；作业模板的三条错误文案与有无流水线连接时的两种形态；类型包缺交付工作项时的错误与契约夹具的分派；编解码的分派、
  新案例的交付方式与交付结算转去看护。

行为另由现有用例对拍：`rfc396-mr-job`、`rfc396-mr-lifecycle`、`rfc396-mr-runtime-wiring` 经装配入口走类型包、编解码与作业模板，`rfc337` 走投影，
`rfc310-employee-case-runtime` 走参与者，`rfc344` 与 `rfc359-w11` 走活动周期，`rfc359-w14` 走终态唤醒。

## 5. 失败模式

- **用例走样**：函数体逐字迁移；判断次序、错误串与对端口的调用次序原样保留；替换只有 D3 列出的四处（登记对象、两处进程全局与核对函数的入参）。
- **登记对象的接收者**：契约夹具的校验原来以 `developmentEmployeeTypePackage` 为接收者调用，现在以装配传入的同一个对象为接收者，`this` 不变。
- **晚绑定**：选定内容的核对原来从装配入参读三次 `input.staging`、两次 `input.documentCommands`，现在在组合文件读一次交入。唯一的调用方
  （`composition.ts`）传对象字面量，读的次数不同不可观察。时钟与 id 在每次唤醒时调用，与原来的时机相同。
- **导出面走样**：`rfc359-w11` 钉住 `activityOperations.ts` 运行时只导出装配入口；转出的 worker 接口只是类型，不进运行时导出面。
  `rfc359-p0` 夹具按组合文件路径替换终态唤醒的装配入口，入口留在原文件。
- **清单漏改**：RFC-310 的 OS 架构清单随 import 的移动改三增一删（D5）。
- **遗留引用**：装配入口与转出不变，使用方不改；迁移后按名字、路径片段与代码里的字符串字面量全仓再扫，另按全部文件类型扫一遍。
- **按原始文本扫的锁误计**：新文件的注释不写组合文件的路径（RFC-506 的教训）。
- **读原文的锁随代码走**：有的锁按原文读组合文件，要求迁走的调用仍出现在组合文件里。D5 起初只清点了按名字与路径取用组合文件的用例，
  漏了 `rfc344-operation-catalog` 读 `composition/executionTerminalObserver.ts` 找 `recordWakeHint` 的一段；首批里它只在候选一边红，
  已改为同时读新文件（D5）。迁移前按组合文件路径全仓扫用例里的 `readFileSync`，逐条核对它们要的文本是否随代码迁走。
- **账本漏标**：guard-manifest 条目标 `assertsAbsence: true`（RFC-507 的教训）。

## 6. 取舍（可推翻）

1. **一步收完非 RFC-370 余项**：7 个文件都是小块实现，彼此独立、改法相同；用户 2026-11-19 要求加速，一步做完省掉五轮文档与验证。
2. **装配期选择留在组合层**：两处 `if` 选实现，是组合层的本职；把它们改写成三元式只会躲开计数，不改变形状。
3. **图交付放 `application/graph-development/`**：与 RFC-498 的交付桥同处；文件名去掉 `graph` 前缀（目录已表明）。
4. **登记对象由装配传入**：application 不取组合层；只要它的契约夹具校验方法，以 `Pick` 写出。
5. **id 与时钟由装配传入**：与 RFC-505、RFC-506、RFC-508 的做法一致，新位置不读进程全局。
6. **组合文件保留转出**：使用方（bootstrap、`graphDevelopment.ts` 与用例）的 import 不改，与 RFC-507、RFC-508 的做法一致。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是图交付生命周期、作业模板、案例详情投影、活动周期、终态唤醒与选定内容核对，都落 application；6 个组合文件只装配，只留装配期
  选择；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-509 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读 6 个组合文件与 6 个新位置；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-development-automation` 收紧到实测；其余触及的计数不升（`off-dag-offered-file-context-pairs` 不变：
  development-automation 取 digital-employee 的 public types 在 DAG 上）。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 development-automation 的第八步：组合层的非 RFC-370 实现清零，只剩两处装配期选择（`evidenceStaging.ts`、
  `repositoryFactsScanner.ts` 各 1 行）。development-automation 的上限按实测登记；S10 收口时这两行按装配期选择计入经确认的上限。
- **留下**：`graphDevelopment.ts` 的 `detailProjection` 与 `digitalEmployeeWorkspace.ts`（没有控制流，随 S10 收口复核）；`crewstation*` /
  `taskImage*` 待 RFC-370 余项；task-execution、source-control、resource-catalog 等模块的余项与 S10 收口另立。
