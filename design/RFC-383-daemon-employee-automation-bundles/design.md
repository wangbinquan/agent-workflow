# RFC-383 设计：数字员工与开发自动化模块组

研究基线 HEAD `fddf8bf74`（RFC-382 已提交；行号以实施时源码为准）。

- `S:` = `packages/backend/src/cli/start.ts`（SQLite 会话 `composeSqliteProviderSession`，以及其中的 PostgreSQL 会话
  `composePostgresqlProviderSession`）
- `V:` = `server.ts`
- `P:` = `cli/postgresqlDaemonApplication.ts`
- `DE/` = `modules/digital-employee/`，`DA/` = `modules/development-automation/`，`TE/` = `modules/task-execution/`
- `DLP` = `cli/daemonLifecycleProgram.ts`，`T/` = `packages/backend/tests/`
- 其余路径相对 `packages/backend/src/`

## 1. 现状

### 1.1 数字员工组

| 成员 | S | V | P | SQLite / PG 实例数 |
| --- | --- | --- | --- | --- |
| `composeDigitalEmployee` | 3118（`employeeOs`） | 2331（`composeSqliteApiRouteMounts` 内，`AppDeps` 无注入字段，V:522-760） | 1260 | 2 / 1 |
| `composeReactionExecutionProvider` | 3147 | 2360 | 1216 | 2 / 1 |
| `composeDevelopmentEmployeeWorkspace` | 3098 | 2314 | 1157 | 2 / 1 |
| 平台工作项 | 3178 | 2402 | 1174 | 2 / 1 |
| `createEmployeeReactionRoundQueries` | 3102、3182 | 2318、2406 | 1156 | 4 / 1 |
| 输入存储（未选择时） | 3095 | 2240 | 1153 | 2 / 1 |
| 清单参与者 | 3247（意图启动派发） | 2551（HTTP 意图） | 1507 | 2 / 1 |
| 任务目录来源 | — | 2445 | 1582 | 1 / 1 |
| 内置工具目录 | 2766 → V（2794） | — | 1253 | 1 / 1 |
| 案例详情投影 | 2498 → V（2848） | 1824 仅测试 | 1287 | 1 / 1 |
| 执行合同 | 2735 → V（2806） | 1831 仅测试 | 819 | 1 / 1 |
| 路由持久化（定义在 V:2040-2192） | — | 2613 | 1412（值导入 `@/server`，P:336） | 1 / 1 |
| 活动操作 | — | 2451 | 1298 | 1 / 1 |
| 工作启动端口 | 2361（转发） | 2429；1776 仅测试 | 1090 | 2 / 1 |
| `digital-employee-os` 作业 | 3302 | — | S:1023 | 1 / 1 |

V 的实例在生产中可达（S:2773 → V:1515-1516 → V:1971）。状态（研究确认）：

- 创作服务：`#ready ??= #initialize()` 无重置（`DE/application/authoringService.ts:290`、`:331-338`），失败被缓存；覆盖表与升级重验
  表（`:287-289`）；`onAutomaticUpgradeIssue` 缺省为空操作（`:299`），S 记录日志（S:3125-3129），V 不记。生产中从不 `await` V 的
  `ready()`（V:2428 的 `trackReady` 因 S 不传作用域而无效），V 在第一次创作查询或第一次工作启动时初始化
  （S:2361-2363 → V:2429-2439 → `launchWork` → `ensureExecutionPolicyFromLimits` → `ready()`，`authoringService.ts:2942-2946`）。
  升级结算只在 S 的实例上跑（S:3635）。
- 运行服务：随机 `#workerId` 与 60 秒外发租约（`DE/application/runtimeService.ts:563-564`）；V 的 worker 只经
  `POST /api/employee-cases/worker/run-one`（`routes/digitalEmployees.ts:554-563` → `activityOperations.ts:30-44`）运行；遗留启动接管
  按实例备忘（`runtimeService.ts:542`、`:2756-2762`），幂等。
- 工具目录：`load()` 备忘（`TE/composition/digitalEmployeeBuiltinToolCatalog.ts:324-340`），未加载即使用会抛错。
- 其余（反应执行、工作区、写者切换、输入与程序存储、任务目录、路由持久化、OS 周期）无状态。

业务状态全部持久化；两个实例只多出缓存与备忘，统一不改变任何功能（预览令牌自带数据，`runtimeService.ts:3645-3651`）。

### 1.2 开发自动化组

| 成员 | S | V | P | 实例数 |
| --- | --- | --- | --- | --- |
| `composeDevelopmentAdmissionLookup`（无状态） | 2392 → 2446、→ V（2808 → 1875） | 1849-1850 仅测试 | 1302 → 1364、1404 | 1 / 1（每个自动化另建一个不用的，`DA/composition.ts:470`，被 `:289` 覆盖） |
| `createDevelopmentMissionExecutionTerminalObserver` | 2393-2413（带日志的 drive 包装） | 1449-1452 仅测试、无日志 | 1309-1329（同 S） | 1 / 1 |
| 宿主环境与执行器 | 2415-2430、2468-2495（S 的环境也给数字员工反应执行用，S:3153-3156） | 1428-1443、1490-1499 仅测试 | 1330-1348、1386-1398 | 1 / 1 |
| `composeDevelopmentAutomation` | 2431-2497 | 1453-1501（`composeFallbackDevelopmentAutomation` V:1421-1503，仅当 `runtimeDeps.developmentAutomation` 缺省，S 总是注入 S:2813） | 1349-1399 | 1 / 1 |
| `composeDevelopmentMissionOperations` | — | 1871-1880（无条件，SQLite 的生产实例；V:2455 → 路由 V:2824-2829，HTTP 与 MCP 共用） | 1400-1409 → 1438-1440 → V:1332-1336 | 1 / 1 |
| `composeMissionInputUploadOperations` | — | 2625-2630（生产） | 1442-1447 | 1 / 1 |

S 与 P 的 `composeDevelopmentAutomation` 选项除宿主环境外相同。死代码：`effectiveDeps.developmentAutomation`（V:1893，类型 V:853）
写入后无人读取。构造时读取 `developmentPurposeRoot.evidenceArtifacts`（S:2441、P:1359）会建目录
（`DA/infrastructure/local/fileEvidenceStore.ts:66-70`；V:3194-3196），幂等。

### 1.3 写者切换与生命周期

写者切换 `composeDigitalEmployeeWriterCutoverFor`（`DE/composition.ts:127-134`）无状态，`activate()` 总是写
`legacyAdmissionsEnabled=false`（`DE/composition/writerCutover.ts:41-51`），所以门控实际表示「没有未完成的遗留任务」。实例：

- SQLite：S:2386（周期刷新 S:3074、启动步骤 S:3572，结果存进 `let employeeWriterState` S:2387 供恢复门控 S:3620-3623）、
  V:1878（任务操作门控）。
- PostgreSQL：P:1295（启动步骤 P:2019，结果丢弃）、P:1407（任务操作门控）；以 `runtime.employeeWriterCutover` 导出（P:563、2115），
  无人读取。
- 两边：每个迁移状态请求另建一个（`DE/composition.ts:1151`）。

生命周期（DLP 顺序）：

| 步骤 / 作业 | 阶段 | SQLite | PostgreSQL |
| --- | --- | --- | --- |
| `daemon-identity` | prepare | 不适用（S:3456） | P:1904（DLP:36-43 仅 PostgreSQL） |
| `event-catalog` / `employee-agent-templates` / `employee-tool-catalog` / `employee-authoring-ready` | prepare | S:3559 / 3562 / 3565 / 3568 | P:2006 / 2009 / 2012 / 2015 |
| `employee-writer-state` | prepare | S:3571-3574（保存并记日志） | P:2018-2020（丢弃） |
| `legacy-mission-recovery` | execution-recovery | S:3619-3633 | 不适用（P:2063；DLP:66-72 `providers: ['sqlite']`） |
| `employee-upgrade-settlement` | execution-recovery | S:3634 | P:2064 |
| 作业 `development-wake`（30 秒）、`digital-employee-os`、`event-center` | initialize 之后 | S:3070-3087、3302、3663-3665 | S:1012-1021、1023、1284-1286 |

### 1.4 守护身份与宿主任务环境

- SQLite 每次调用准入：S:2418-2422、V:2369-2373（`digital-employee-host-identity-not-admitted`），S:3159-3174、V:2383-2398
  （`digital-employee-catalog-authority-not-admitted`），开发 Agent 查询 S:2472-2476、2486-2490。
- PostgreSQL：`let systemActor`（P:707）由 `daemon-identity` 设置（P:1904-1908），在 P:1220、1236、1239、1332、1343 读取，未启动
  （测试）路径 P:2096 直接调用。
- 观测组另有一份准入（`cli/daemonModules/observation.ts:88-92`）。
- 宿主任务环境四份：`resolveActor`（S:2418、V:1431 仅测试、V:2369、P 的 `systemActor`）、`resourceAuthorityFor`（S:2423、V:1436、
  V:2374、P:1221/1333）、Agent 与工作流目录的 `get` 闭包（S:2470、2484、3159、3167；V:1864、2383、2391；P:1235-1240、1342）、
  取消（S:2428、V:1441 每次 `composeTaskCancellation(db)`；P:1339-1340 用会话的 `cancellation`，两个 provider 运行时都暴露它，
  `TE/composition/providerRuntime.ts:454`、`:686`、`:756`；在 SQLite 上两者到达同一个停止注册表，
  `TE/composition/taskCancellation.ts:31-43`、`TE/infrastructure/taskExecutionRuntimeParticipants.ts:229-231`）。
- 三个反应执行都已经经 RFC-382 的会话内核启动（S:2417 → S:3156；V:2379；P:1196/1226）。
- P 的 `hostWorkflow`（P:1229）、`resourceUsage`（P:1232-1234）、`executionMetadata`、`humanReview`（P:1244、1249）覆盖与缺省实现相同，
  且为取得它们把端口对象建了两次。

## 2. 行为统一

### 2.1 SQLite 的数字员工统一为一个实例（取舍 2）

数字员工组构造一次模块与全部卫星成员；S 的 OS 作业、启动步骤、意图启动派发与 V 的路由、MCP、工作启动、HTTP 意图使用同一实例。
`employee-authoring-ready` 启动步骤初始化的就是 HTTP 用的实例，删除 V 里无效的 `trackReady`。升级问题只记录一次（S 的日志口）。

回归：SQLite 上 V 的模块与 S 的是同一对象；启动后第一次创作查询不再调用初始化（初始化计数 1）；初始化失败时启动失败（同
PostgreSQL），不再出现「启动成功、HTTP 一直报错」的状态。

### 2.2 写者切换每会话一个实例（取舍 3）

数字员工组构造唯一的写者切换，传给 `composeDigitalEmployee`（替换 `DE/composition.ts:1151` 的每请求现建）、开发任务操作的门控、
启动步骤与周期门控；开发自动化组只取 `{ read, refresh }` 窄接口（避免在 RFC-310 OS 架构清单里新增边）。删除 P 未读取的
`runtime.employeeWriterCutover` 导出。

### 2.3 开发唤醒按写者状态门控（取舍 4）

SQLite 的现行逻辑（S:3073-3076）是正确一侧（`T/rfc310-digital-employee-writer-cutover.test.ts:38-95`、`:150-174`）。PostgreSQL 的缺陷链：

1. 已关闭未合并的遗留任务 MR 收到 Webhook，仍记录唤醒提示（`DA/domain/webhookWake.ts:24-28`、
   `DA/infrastructure/missionCodeHostEventContinuation.ts:18-52`，构造于 `cli/daemonModules/integration.ts:167`）。
2. PostgreSQL 的唤醒读取全部未消费提示（`DA/infrastructure/reconcilerReaders.ts:83-91`、`DA/application/missionWakeSweep.ts:30-33`）。
3. 对账走重开分支（`DA/application/missionReconciler.ts:614-631`）。
4. `reopenClosedMission` 新建继任遗留任务并重新占用 MR（`DA/application/commands/reopenMission.ts:107-208`）；写者行要到重启才计入它。

迁移状态的 `analyze()` 报告的是保存的模式与待排空数（`DE/composition/writerCutover.ts:52-65`），待排空列表却是实时构造
（`DE/infrastructure/writerCutoverPersistence.ts:134-180`），PostgreSQL 只在启动时写保存行，所以两者不一致到重启。

处置：development-automation 应用层新增门控函数（刷新写者状态，`os-active` 且不再接纳遗留任务时跳过唤醒，刷新失败与唤醒失败分开
记日志），开发自动化组以 `sweepWakesWhileDraining()` 暴露；两个会话的 `development-wake` 作业都只调用它。`adoptMergeRequest`
不加门控（`DA/composition/missionOperations.ts:656-699`，现状两边相同；SQLite 的下一次刷新会切回 `legacy-draining`，PostgreSQL 现在
也会）。

### 2.4 遗留任务恢复与写者状态启动步骤（取舍 5）

`recoverMissions`（`DA/application/missionRecovery.ts:34-73`）是唯一扫描被围栏任务与过期世代预备效果的代码
（`DA/infrastructure/reconcilerReaders.ts:40-61`）。PostgreSQL 会有遗留任务：迁移复制 `development_missions`（KEEP，
`design/RFC-349-postgresql-provider-one-click-migration/schema-contract.json:15047`），`adopt-mr` 新建。PostgreSQL 崩溃后的缺陷：
先写围栏的 `cancel-pending`（`DA/application/commands/launchMission.ts:960-962`）不会再被驱动（策略以 `resumeAt:null` 等待，
`DA/engine/policy/evaluatePolicy.ts:110-121`；再次取消被拒为 `cancel-already-pending`，`DA/domain/mission.ts:166-168`）。

处置：开发自动化组暴露 `recoverWhileDraining()`（门控读 `writerCutover.read()`）；DLP 去掉 `legacy-mission-recovery` 的
`providers: ['sqlite']`，两个会话注册同一实现；`employee-writer-state` 两边都保存并记录日志，删除 S 的 `let employeeWriterState`。
它与 PostgreSQL 每 30 秒运行的唤醒使用同一套中立持久化、CAS 与乐观版本检查，失败策略为尽力而为。

### 2.5 类型包漂移策略（取舍 6）

策略在 S:1665-1670 计算，传给 S（S:3123）与 V（S:2849 → V:2336），PostgreSQL 会话丢弃（S:677-760，会话输入已有该键 S:1409）。
处置：数字员工组输入 `typePackageDriftPolicy`，两个会话都传入。回归：开启开发覆盖时 PostgreSQL 的 `employee-authoring-ready`
通过（此前 `employee-type-revision-drift`，`DE/infrastructure/authoringStore.ts:465-485`）。

### 2.6 守护身份（取舍 7）

provider 核心（`cli/daemonModules/providerCore.ts`，唯一允许导入 identity-access 的模块组文件）新增 `daemonActor()`：每次调用
`admitDaemonIdentity`，未准入时抛出调用方给定的错误码；数字员工组的目录授权、宿主任务的 `resolveActor`、观测组
（`observation.ts:88-92`）共用。删除 P 的 `let systemActor`；`daemon-identity` 启动步骤保留为 PostgreSQL 的启动检查（DLP 不改），
不再写持有者。

### 2.7 宿主任务环境（取舍 8）

任务执行组（`cli/daemonModules/taskExecution.ts`）新增输出 `hostTasks`：`{ db, launch: routeLaunch.workflow, resolveActor:
core.daemonActor, resourceAuthorityFor, cancelTask: cancellation, readModels }`，外加 Agent 与工作流目录的 `get`（由资源目录组的目录
与守护身份构造，替换三个根里的闭包）。数字员工反应执行与开发自动化执行器都取它；删除三个根里的 `hostActionEnvironment` 与
P 重复构造的端口对象（`hostWorkflow` / `resourceUsage` / `executionMetadata` / `humanReview` 用缺省）。

### 2.8 程序存储（取舍 9）

从选择推导一次程序存储，传给模块的 `programArtifacts`、反应执行的 `programs`、执行合同夹具的 `programs`（S 此前漏传后两处，
S:3147-3177、S:2741；P:1219、825-831）。只有 CrewStation 选择程序存储（`bootstrap/crewstation.ts:323-327`），单机行为不变。

### 2.9 路由持久化迁出 server.ts（取舍 10）

`composeDigitalEmployeeRoutePersistence`（V:2040-2192）移入 `cli/daemonModules/digitalEmployee.ts`，作为组输出 `routePersistence`：
身份依赖改为 `Pick<..., 'userDirectory'>`；名称检查改用资源目录授权的 `assertNameUnchangedForEditor`
（`modules/resource-catalog/application/resourceAuthorization.ts:145`，`services/resourceAcl.ts:38` 有再导出）。删除
`architecture/commons-debt.json` 中 `server.ts → resource-catalog/{application,domain}/resourceAccess` 两条 R1（:660-683）与 P 的
`@/server` 值导入（P:336）。

## 3. 构造函数

### 3.1 `composeDaemonDigitalEmployeeModules`（`cli/daemonModules/digitalEmployee.ts`）

输入：

- `db`、`appHome`、`configuration`（重试上限实时读取）、`log`、`typePackageDriftPolicy`；
- `core`：`daemonActor`、`userDirectory`、`directAuthority`；
- `resources`：`digitalEmployeeAgentTemplates`、Agent 与工作流目录、`resourceCatalog.authorization`、`digitalEmployeeAcl`；
- `repository`：交付 provider、发布传输、工作区仓库准备；
- `integration`：`eventCenter`、`developmentToolConnections`、`developmentApprovalGateway`；
- `taskExecution`：`hostTasks`、`routes.tasks`、`readModels`、`resources`；
- `developmentPurposeRoot`（`pipeline.staging`）与工作区选择（自动化工作区效果、冲突合并效果、仓库候选效果、仓库基线、证据工件）；
- `adapters?`：`employeePrograms`、`employeeInputArtifacts`、`employeeCaseWorkspaceEffects`、`programFixtureProcess`，以及仅 V 回退用的
  `platformTools`（RFC-386 删除）。

输出：`module`、`executionContracts`、`platformTools`（可加载）、`writerCutover`、`workStart`、`taskCatalogSource`、`platformInventory`、
`caseDetailProjection`、`activityOperations`、`routePersistence`、`reactionExecution`。

### 3.2 `composeDaemonDevelopmentAutomationModules`（`cli/daemonModules/developmentAutomation.ts`）

输入：`db`、`appHome`、`log`；选择（`verificationCommands`、`repositoryBaselines`、`evidenceRead`、`attemptContext`、
`repositoryCandidateEffects`、`conflictMergeWorkspaceEffects`、`missionInputBlobs`、`evidenceArtifacts`、托管的
`actionWorkspaceEntries`）；根计算的工作区效果与 `developmentPurposeRoot`；`repository`（交付 provider、发布传输）；`integration`
（`developmentApprovalGateway`）；`hostTasks` 与 Agent 目录（来自任务执行组）；`writerCutover: { read(); refresh() }`（来自数字员工组）。

输出：`admissionLookup`、`automation`、`missionOperations`、`missionInputUploads`、`sweepWakesWhileDraining()`、`recoverWhileDraining()`。
内部顺序：准入查询 → 终止观察者（闭包引用后面的 `automation` 常量）→ 自动化 → 任务操作 → 输入上传；删除每个自动化里那个
不用的准入查询。

### 3.3 调用顺序与循环

两个会话：任务执行 → 定时任务 → 融合 → 集成（工作启动以词法作用域的转发闭包延迟绑定，同 S:2361、P:1090 现状）→ 数字员工组 →
开发自动化组 → `composeSqliteAppDeps`（注入）/ P 的路由装配 → 意图 → 生命周期。构造函数均为被动构造（`DE/composition.ts:793-1153`），
启动步骤顺序不变。

### 3.4 适配器表

本批没有真正的 provider 差异，不加 `adapters.ts` 条目；托管选择经 `adapters?` 输入进入（同 RFC-381 `integration.ts:92-104`）。

## 4. server.ts

- `AppDeps` 增加 `digitalEmployeeModules`、`developmentAutomationModules`；S 注入。V 只在 `deps.x ?? compose…(...)` 回退中调用两个构造函数
  （直接 `createApp` 的测试），删除 `composeFallbackDevelopmentAutomation` 与 V 自建的数字员工、反应执行、工作区、平台工作项、输入存储、
  任务目录来源、活动操作、路由持久化、开发任务操作、输入上传。
- V 继续接收 S 转发但已不读取的 `verificationCommands`、`attemptContext`、`evidenceRead`，留到 RFC-386 一并清理（避免锁的反复改动）。
- 删除写入后无人读取的 `effectiveDeps.developmentAutomation`。

## 5. 测试策略

### 5.1 新增双引擎回归

1. 构造：两个构造函数被动（无 SQL、无定时器）、输出冻结且完整；会话内成员同一（V 拿到的模块、写者切换、任务操作与 S 的是同一对象）。
2. 单实例：SQLite 启动后第一次创作查询不再初始化（初始化计数 1）；初始化失败使启动失败。
3. 写者切换：迁移状态在周期刷新后反映新的模式与待排空数（PostgreSQL 此前陈旧）。
4. 唤醒门控：`os-active` 且无遗留接纳时，已关闭未合并的遗留任务 MR 重开的提示不被消费、不新建遗留任务（PostgreSQL 此前新建）；
   排空期间照常唤醒。
5. 遗留恢复：`cancel-pending` 被围栏的任务在重启后的恢复中被驱动，过期世代预备效果失效（PostgreSQL 此前不跑）；门控读
   `writerCutover.read()`。
6. 漂移策略：开发覆盖开启时 PostgreSQL 的 `employee-authoring-ready` 通过。
7. 守护身份：未准入时两种错误码；P 不再有持有者；`daemon-identity` 仍是 PostgreSQL 的启动检查。
8. 宿主任务：取消经会话 `cancellation`（SQLite 上停到同一注册表）；反应执行与开发执行器用同一 `hostTasks`。
9. 程序存储：选择的程序存储被反应执行与合同夹具读取。

### 5.2 结构锁

扩展 `T/architecture/rfc380-daemon-module-bundles.test.ts`：`BUNDLES` 加两个文件；S 与 P 各调用每个构造函数恰好一次、`server.ts` 只在
`??` 回退中调用；三个入口根不直接调用 AC-1 列出的工厂；两个文件遵守模块组规则（不导入 identity-access、不值导入入口根）；
`legacy-mission-recovery` 两个 provider 都适用。

### 5.3 旧锁（改指新位置，不放宽意图）

`T/rfc317-work-start-bind.test.ts`（重写文件头的两实例决定与顺序断言）、`T/rfc349-digital-employee-platform-tools-wiring.test.ts:107-171`、
`T/rfc370-employee-input-root-bindings.test.ts:30-64`、`T/rfc370-program-evidence-root-wiring.test.ts:74-121`、
`T/rfc370-storage-and-worker-root-bindings.test.ts:65-117`、`:263-285`、`:343-432`、`T/rfc370-evidence-artifact-root-bindings.test.ts:51-71`、
`T/rfc370-verification-command-family.test.ts:700-738`、`T/rfc370-attempt-context-root-wiring.test.ts:61-84`、
`T/rfc370-mission-input-capture-roots.test.ts:29-69`、`T/rfc344-operation-catalog.test.ts:797-800`、
`T/rfc359-t3-action-execution-runners.test.ts:512-582`、`T/rfc338-maintenance-architecture.test.ts:58-60`、
`T/rfc349-development-admission-postgresql-adapter.test.ts:85-101`、`T/rfc321-repository-publication-ratchet.test.ts:280-282`、
`T/rfc349-postgresql-daemon-system-identity.test.ts:103-138`、`T/rfc310-architecture-lock.test.ts:46-53`（`COMPOSITION_CONSUMERS`）、
`T/rfc310-digital-employee-os-architecture.test.ts:120-144`（OS 架构清单的精确边）、`T/fixtures/rfc359-p0-mutations.ts:225-262`
（保留 composition 桶导入）、`T/rfc379-daemon-lifecycle.test.ts`（若步骤声明断言 providers）、`T/rfc359-w4-d6c-bootstrap-idempotency.test.ts`。

### 5.4 账本

`BOOTSTRAP_FILES`（`T/architecture/census.ts`）加两个文件；R1 删除 §2.9 的两条并按实际增删；`architecture/guard-manifest.json` 登记
行数随守卫更新；`design/RFC-310-rule-driven-development-digital-employee/os-architecture-manifest.json` 随构造位置更新；
`architecture/counts.json` 不升。

## 6. 与 RFC-294 目标架构的对齐

- **落位**：bootstrap 唯一装配（S2b 每模块每会话构造一次）；跨模块经 exact `public` / composition 合同；provider 差异只经适配器表
  （本批无）。
- **本 RFC 承担的演进**：数字员工与开发自动化每会话构造一次；写者切换门控落到 development-automation 应用层；宿主任务环境归
  任务执行组；守护身份收进 provider 核心；路由持久化离开 `server.ts`，删除两条 R1。
- **留下的债**：意图（RFC-384）；每次调用的协调器（RFC-385）；V 的回退与挂载表（RFC-386）；构造时建证据目录（取舍 11）。
- **偏离项**：构造函数放在 `cli/daemonModules/`（同 RFC-379～382），S2c 迁入 `bootstrap/`。
