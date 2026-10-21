# RFC-384 设计：意图模块组

研究基线 HEAD `64a15d085` 加 RFC-383 工作树（行号以实施时源码为准）。

- `S:` = `packages/backend/src/cli/start.ts`（SQLite 会话，以及其中的 PostgreSQL 会话组合）
- `V:` = `server.ts`
- `P:` = `cli/postgresqlDaemonApplication.ts`
- `I/` = `modules/intent/`，`DLP` = `cli/daemonLifecycleProgram.ts`，`T/` = `packages/backend/tests/`
- 其余路径相对 `packages/backend/src/`

## 1. 现状

### 1.1 构造清单

| 成员 | S（SQLite 工作者图） | V（SQLite HTTP 图） | P | SQLite / PG |
| --- | --- | --- | --- | --- |
| 资源目录 `catalogFor`（含 WeakMap） | 2954-2981 | 2108-2135 | 1160-1187 | 2 / 1 |
| 授权持久化 | 2987-2990 | 2136-2139 | 1188-1191 | 2 / 1 |
| 上下文授权工厂 | 2989 | 2138 | 1190 | 2 / 1 |
| 维护快照里的普通持久化（`I/composition/maintenance.ts:66-76`） | 2557-2560 | — | 1243-1246 | 1 / 1 |
| 制品生命周期 | — | 隐式（`I/composition/apply.ts:133-143`） | 显式 1192-1196 | 1 / 1 |
| 应用引擎 | — | 1833-1847 | 1198-1210 | 1 / 1 |
| 图校验（无状态） | 3025 | 1840、2179 | 1205、1236、1262 | 3 / 3 |
| 清单参与者（数字员工清单来自 RFC-383 模块组的 `platformInventory`） | 2991-2996 | 2140-2145 | 1212-1217 | 2 / 1 |
| 转储辅助 | 2997-3012（实时包装） | 2146-2161（实时包装） | 1218-1222（构造时快照 :1220） | 2 / 1 |
| WebSocket 事件发布 | 3015 | 2166 | 1223 | 2 / 1 |
| 轮次运行时解析 | 3018（工作者族） | 2172（HTTP 族） | 1229（工作者）、1256（HTTP） | 2 / 2 |
| 路由输入与测试夹具 | — | 2163-2198，挂载 2452 | 1247-1285，挂载 V:1311 | 1 / 1 |
| 通知收件箱 | 2549 | — | — | 1 / 0 |
| 排队续跑 | 3032-3046 | — | S:716-725 | 1 / 1 |
| 维护快照（活动经 V:1915-1917 迟绑定） | 2557-2560 | — | 1243-1246 | 1 / 1 |

V 的实例在生产中可达（S:2641 → V:1379 → V:1851）。维护 Worker 线程里的 `composeIntentMaintenanceCommandsForDatabase`
（`platform/background/maintenanceWorker.ts:707`、`:823`）不在范围内；`applyIntentChangeset` 与 `convergeIntentApplyJournal`
（`I/composition/apply.ts:179-208`）没有生产调用方。

### 1.2 状态

- 应用引擎的 `active` 集合每个引擎一份（`I/application/intentApplyEngine.ts:213`、`:278`、`:549`、`:652`）；维护 Worker 的意图恢复
  跳过集合内的日志（`platform/background/maintenanceService.ts:518-520`、`intentApplyEngine.ts:584-585`），所以维护必须读路由使用的
  那个引擎。SQLite 经迟绑定取（S:2559 → V:1915-1917），PostgreSQL 直接取（P:1245）。
- 进程级状态：`applyLock`（`intentApplyEngine.ts:195`）、`intentSem(2)` 与 `liveTurnAborts`（`I/application/turnEngine.ts:127-128`），
  两套图本来就共享。
- 排队续跑持有 `pending` / `current`（`queuedResumption.ts:23-24`），只能启动一次（`:65`），启动前缓冲通知（`:56-61`、`:96-99`）；
  收件箱持有 `pending` / `consumer`，只能连接一次（`queuedNotifications.ts:9-10`、`:20`）。
- 运行时绑定按族隔离：每族一个 WeakMap（`runtime-management/infrastructure/local/systemAgentRuntimeBindings.ts:10`、`:24-28`）与
  保留内容（`systemAgentRetainedContents.ts:18-20`），所以每个轮次运行时解析必须与它的族配对。
- 其余无状态。

### 1.3 启动步骤与作业

DLP 对两个 provider 相同：启动步骤 `maintenance-boot-snapshot`（DLP:72；S:1222-1224、S:3368-3370，在启动时以 SQL 读取
`bootTurnIds`，不在构造时）；运行时作业 `intent-queued-resumption` 最先启动（DLP:84-90），早于 `task-execution` 与 `maintenance`（DLP:91）；
维护 Worker 作业 `intentRecovery`、`intentScratchGc`（`maintenanceService.ts:514-520`、`:570-575`；`maintenanceJobRunner.ts:385-416`）
产生的 `intent-queued` 增量喂给 `onIntentQueued`（`maintenanceService.ts:442`）。构造全部被动（`intentApplyEngine.ts:208-213`、
`queuedResumption.ts:22-24`，维护服务 `maintenanceService.ts:317-325`），调整构造顺序不改变运行顺序。

## 2. 形状统一

### 2.1 一套图、两个运行族（取舍 1、2）

模块组构造一次资源目录（含上下文授权工厂与 WeakMap）、授权持久化、图校验、制品生命周期、应用引擎、清单、转储辅助、事件发布；
`dispatch` 用工作者族的轮次运行时，`routes` 用 HTTP 族的轮次运行时与测试夹具。V 删除自建的应用引擎与路由图，改读注入实例。

### 2.2 维护与排队续跑（取舍 3）

两个会话都在 `createMaintenanceService` 之前构造意图组：维护的应用活动读模块组的 `maintenance`（就是路由使用的引擎），
`onIntentQueued` 直接调用模块组的排队续跑；删除收件箱与 `SqliteAppComposition.intentApplyActivity`。排队续跑启动前缓冲通知，
运行时作业 `intent-queued-resumption` 先于维护作业启动（DLP:84-91），所以删除收件箱不丢通知。

### 2.3 转储辅助的默认运行时（取舍 4）

`composeIntentDumpAuxiliaryQueries`（`I/.../auxiliaryQueries.ts:44-52`）把 `defaultRuntime?: string` 换成实时配置读取口；删除 S、V 的
两处实时包装与 P 的构造时快照（P:1220）。轮次照旧传入有效默认值（唯一调用方 `dispatcher.ts:122-123` → `turnEngine.ts:784-806`、
`:351-353`），读取口只是兜底（`I/application/dumpBuilder.ts:823-824`）。

### 2.4 制品生命周期、路由身份与日志（取舍 5、6）

- 制品生命周期在模块组内显式构造；托管的 `intentArtifacts` 选择经 `adapters` 进入（只有 `bootstrap/crewstation.ts:338` 设置）。
- 路由只收 `{ directAuthority }`（`intentSessionRoutes.ts:151` → `dispatcher.ts:233` 只读这一项）。
- 排队准入失败的日志统一为中立文字、字段 `error`（S:720-722 与 S:3042-3044 合一）。

### 2.5 composition 入口与 R1（取舍 7）

intent 补出 composition 入口：资源目录绑定（含 WeakMap）、`resumeQueuedIntentWorkingSets` 包装、路由依赖类型与挂载再导出。模块组与
入口根只经它取用，删除 `architecture/commons-debt.json` 中入口根到 intent `application/dispatcher`、`application/resourceCatalog`、
`inbound/intentSessionRoutes` 的 R1（今天 9 条：S 3、P 3、V 3，导入位于 S:147-150、S:276、P:234、P:292-294、V:297-300、V:314），
`inboundEdges` 随之下降（基线由 `T/architecture/rfc317-architecture-ledgers.test.ts:121` 精确校验）。

## 3. 构造函数 `composeDaemonIntentModules`（`cli/daemonModules/intent.ts`）

输入：

- `db`、`appHome`、`configuration`（实时读取）、`log`；
- `core`：`identityAccess` 的 `contexts`、`directAuthority`；
- `resources`：资源目录组（目录、`resourceCatalog.createQuery`、`persistence.identities`、`capabilityTemplateOperations`、
  `developmentConfigOperations`）；
- `observation`：`intentSystemAgentBinding`、`intentHttpSystemAgentBinding`；
- `digitalEmployee`：`platformInventory`（类型取 `DaemonDigitalEmployeeModules`，不新增 RFC-310 清单边）；
- `adapters?`：`intentArtifacts`（托管）、`httpTurnFixture`（直接 HTTP 测试，RFC-386 删除）。

输出（冻结）：`persistence`、`resourceCatalogFor`、`graphValidation`、`dumpAuxiliary`、`events`、`applyOperations`（唯一引擎）、
`dispatch`（工作者族）、`routes`（HTTP 族与夹具）、`maintenance`、`queuedResumption`。

内部顺序：资源目录 → 持久化 → 图校验 → 制品生命周期 → 应用引擎 → 清单 → 转储辅助 → 事件发布 → `dispatch` → `routes` → `maintenance` →
排队续跑。

调用顺序：两个会话都是数字员工组 → 开发自动化组 → **意图组** → `createMaintenanceService`；SQLite 再 → `composeSqliteAppDeps({ intentModules })`；
P 以 `runtime.intentModules` 暴露，S 中的 PostgreSQL 会话在构造维护服务之前读取它。

## 4. server.ts

- `AppDeps` 增加 `intentModules`；S 注入。V 只在 `composeSqliteApplicationDeps` 内以 `deps.intentModules ?? composeDaemonIntentModules(...)`
  回退调用（结构守卫要求回退位于 `composeSqliteApplicationDeps`），删除 V:1833-1847、V:2106-2198、V:947-951、V:1915-1917。
- 同时收到注入的模块组与 `intentTestDependencies` 时抛错。

## 5. 测试策略

### 5.1 新增双引擎用例

1. 构造被动（无 SQL、无定时器，转储辅助构造时不读配置）、输出冻结且完整。
2. 单实例：SQLite 上 V 的应用引擎、资源目录、持久化与 S 的是同一对象；维护读取的活动集就是路由应用引擎的集合（路由发起的应用
   在维护的活动快照里可见）。
3. 两个运行族：工作者族的排队续跑与 HTTP 族的路由轮次使用各自的绑定；HTTP 夹具不进入排队恢复。
4. 排队通知：维护服务产生 `intent-queued` 增量时，排队续跑在启动前缓冲、启动后处理（两个 provider，同一路径）。
5. 转储默认运行时：配置变更后下一次兜底读取取到新值。
6. V 同时收到注入模块组与 `intentTestDependencies` 时抛错。

### 5.2 结构锁

扩展 `T/architecture/rfc380-daemon-module-bundles.test.ts`：`BUNDLES` 加意图组；`FACTORIES` 加意图工厂（含
`composeIntentContextResourceAuthorizationFactory`）；`RETIRED` 加收件箱；S 与 P 各调用一次、V 只在 `composeSqliteApplicationDeps` 的
`??` 回退中调用；两个会话都先意图组、后 `createMaintenanceService`。

### 5.3 旧锁（改指新位置，不放宽意图）

`T/rfc370-intent-queued-resumption.test.ts:458-528`（改锁模块组与「模块组先于维护服务」；`:31-80` 的收件箱行为用例随收件箱删除）、
`T/rfc349-intent-boot-resume-authority.test.ts:322-334`、`T/rfc370-root-background-bindings.test.ts:133-142`（P 的 `resumeIntentSessions`
配置快照改指模块组）、`T/architecture/rfc359-w5-t19b-composition-root-complete.test.ts:99`、`:104`、`:166`（三条 WeakMap 标记合为新文件
一条，`:404` 精确校验）、`T/rfc244-alert-resolved-boot-wiring.test.ts:72`（保留 SQLite 的属性写法）。

### 5.4 账本

`BOOTSTRAP_FILES`（`T/architecture/census.ts`）加新文件；R1 按 §2.5 删除并保持双向精确；`architecture/guard-manifest.json` 登记行数随
守卫更新；`architecture/counts.json` 不升。

## 6. 与 RFC-294 目标架构的对齐

- **落位**：bootstrap 唯一装配（S2b）；跨模块经 exact composition / public 合同。
- **本 RFC 承担的演进**：意图每会话构造一次；维护与意图的装配形状两边一致；入口根不再深入 intent 的 `application/` 与 `inbound/`，
  R1 净减。
- **留下的债**：维护 Worker 线程内的意图命令；维护快照与应用引擎各自现建的持久化 / MCP 事务生命周期（无状态，留待后续）；
  V 的回退与挂载表（RFC-386）。
- **偏离项**：构造函数放在 `cli/daemonModules/`（同 RFC-379～383），S2c 迁入 `bootstrap/`。
