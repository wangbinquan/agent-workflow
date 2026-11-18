# RFC-505 设计：数字员工的内建作业、PostgreSQL 磁盘报告与运行时选择快照迁出 composition

## 1. 现状（HEAD `a1a5b70a1`，源码实读）

三个模块组合层控制流（F13 口径，按语法树计数）的非 RFC-370 部分：digital-employee 只有 `builtinJobTemplates.ts` 6 行；system-operations
是 `maintenanceDisk.ts` 2 行与 `daemonDatabase.ts`、`manualDatabaseMigration.ts` 各 1 行；runtime-management 只有 `runtimeSelection.ts`
1 行。三个目标文件都不在 `composition-forbidden-import-files` 里（那 12 个文件全是 `taskImage*` / `crewstation*`）。

**digital-employee `composition/builtinJobTemplates.ts`，66 行**：第 1～4 行 import（platform 的 `PersistenceDb` 类型、shared 的
`canonicalJson`、本模块 infrastructure 的 `createDigitalEmployeeAuthoringPersistence`、domain 的 `employeeJobTemplateContentSchema`）；第 7～66 行
`composeBuiltinEmployeeJobs(db, publish)`：第 11 行建作者面持久化，返回两个方法——

- `ensureDraft`（第 14～39 行）：解析内容（第 15 行）、读已有模板（第 16 行）；已有时类型引用不符就抛
  `builtin-employee-job-type-conflict:<id>`（第 17～22 行），否则交出已有的 id 与已发布修订号（第 23 行）；缺失时取一次 `Date.now()`
  （第 25 行）建一条未发布、无 owner、`public` 的草稿（第 26～37 行）。
- `ensure`（第 40～64 行）：解析、读已有；已有且有 owner 或草稿的规范 JSON 与内容不符就抛 `builtin-employee-job-content-conflict:<id>`
  （第 43～47 行）；缺失时建行（第 48～60 行，`createdAt` 与 `updatedAt` 各取一次 `Date.now()`）；已发布就交出已发布修订号，否则经传入的
  `publish({ id, actorUserId: null })` 发布（第 61～63 行）。

它用到的作者面持久化方法 `getJobTemplate`、`createJobTemplate` 声明在 `application/ports/authoringStore.ts` 第 194 行起的
`DigitalEmployeeAuthoringPersistence`（第 233、240 行）；infrastructure 的 `createDigitalEmployeeAuthoringPersistence` 交出它的扩展
`DigitalEmployeeAuthoringAdapter`。`employeeJobTemplateContentSchema` 在 `domain/model.ts` 第 1021 行。

**system-operations `composition/maintenanceDisk.ts`，67 行**：第 1～9 行 import（`@/db/client` 的 `DbClient` 类型、本模块 public 的
`MaintenanceDiskOperations` 类型、platform 的 `PostgresqlDatabaseRuntime` 类型、infrastructure `local/systemMaintenanceDisk.ts` 的
`cleanupRetiredStores`、`reportDiskReclaimable`、`reportRetiredRuntimeStores`，`@/util/paths` 的 `Paths`）；第 11～17 行私有的
`nonNegativeInteger`（不是安全的非负整数就抛 `maintenance disk metric is invalid: <detail>`）；第 19～31 行
`composeSqliteMaintenanceDiskOperations`（`report` 交给 `reportDiskReclaimable(db, appHome)`）；第 38～67 行
`composePostgresqlMaintenanceDiskOperations`：`report`（第 43～62 行）经 `runtime.providerPool().unsafe(...)` 查
`pg_database_size(current_database())` 与 `pg_stat_user_tables` 里按 `n_dead_tup` 估算的可回收字节（`agent_workflow` schema），交出冻结的
`{ items: [reportRetiredRuntimeStores(appHome)], dbFreelistBytes, dbFileBytes }`（两个数都经 `nonNegativeInteger`）；`cleanupRetiredStores`
交给 infrastructure。infrastructure 里 PostgreSQL 的实现文件平铺在 `infrastructure/postgresql*.ts`。

**runtime-management `composition/runtimeSelection.ts`，38 行**：第 12～38 行 `composeRuntimeSelectionParticipantInTx(transaction,
assertTaskScope)`：建读端口与注册表应用（第 16～17 行），第 18 行一张 `Map<FrozenRuntimeRef, ResolvedRuntime>`，第 19 行建能力，第 20～27 行
建参与者（`resolve` 交给注册表、`retain` 存进表），返回 `{ capability, participant, readSnapshot }`：`readSnapshot`（第 31～36 行）先
`assertTaskScope()`，取不到就抛 `runtime-selection-reference-unavailable`，交出 `structuredClone` 的副本。`application/runtimeSelection.ts`
（52 行）已有能力与参与者的两个工厂，只取 `ulid`、本模块 public 的 `FrozenRuntimeRef` 等类型与 domain 的 `ResolvedRuntime` 类型。

使用方（都只取装配入口，名字与路径不变）：

- bootstrap：`daemonModules/digitalEmployee.ts` 第 91 行取、第 444 与 461 行调用 `composeBuiltinEmployeeJobs`；`daemonModules/adapters.ts`
  第 6～8 行取、第 38 与 48 行调用两个磁盘维护装配；`daemonModules/taskExecution.ts` 第 30 行取、第 333 行把
  `composeRuntimeSelectionParticipantInTx` 交给 `composeNodeRunRuntimePersistence`。
- 用例：`rfc396-mr-job` 与 `rfc396-registration` 调用 `composeBuiltinEmployeeJobs`；`rfc349-maintenance-disk-provider` 调用两个磁盘维护装配
  （PostgreSQL 一段用带记录的运行时断言只读、不开本地库文件）；`helpers/nodeRunRuntime.ts` 取 `composeRuntimeSelectionParticipantInTx`。
- 按路径或名字钉着这几个文件的锁，断言的都是留下的装配入口：RFC-310 的 `os-architecture-manifest.json` 记的外部边
  `bootstrap/daemonModules/digitalEmployee.ts -> composition/builtinJobTemplates`（`rfc310-digital-employee-os-architecture` 只比对模块外
  进来的 import）；`architecture/rfc359-w5-same-file-provider-pairs` 第 109 行的同文件双实现对；`architecture/rfc380-daemon-module-bundles`
  的名字表；`rfc349-runtime-registry-provider` 第 173 行读 bootstrap 的那一行调用。没有锁按文本钉着要迁走的错误串、SQL 或函数体。
- 同名声明：`nonNegativeInteger` 另有 collaboration 的 `domain/clarifyGateOpen.ts`、`manualQuestionOpen.ts`、`reviewGateOpen.ts` 三个私有
  函数（签名不同）；新文件路径与三个新名字都未被占用。

## 2. 机制与落位

### D1 用例落 application，IO 落 infrastructure

内建作业的确保只经作者面持久化端口与传入的 `publish` 工作，快照表是纯内存状态：落 `application/`。PostgreSQL 磁盘报告直接发 SQL：落
`infrastructure/`，与 SQLite 版的 `local/systemMaintenanceDisk.ts` 对称。

### D2 新位置

- **digital-employee `application/builtinEmployeeJobs.ts`**（新）：`BuiltinEmployeeJobsDependencies`（`store` 为
  `Pick<DigitalEmployeeAuthoringPersistence, 'getJobTemplate' | 'createJobTemplate'>`、`publish`、`now(): number`）与
  `createBuiltinEmployeeJobs(deps)`；两个方法的函数体是原第 14～64 行，三处 `Date.now()` 改为 `deps.now()`（每处仍取一次），其余逐字。
- **system-operations `infrastructure/postgresqlMaintenanceDisk.ts`**（新）：`nonNegativeInteger` 原样迁入（私有）；
  `reportPostgresqlDiskReclaimable(runtime, appHome)` 的函数体是原第 44～61 行；`reportRetiredRuntimeStores` 从同层的
  `./local/systemMaintenanceDisk` 取。
- **runtime-management `application/runtimeSelection.ts`**：新增 `createRuntimeSelectionSnapshotsInTx(assertTaskScope)`，交出
  `{ retain, readSnapshot }`，表与两个方法的函数体是原第 18、24～26、31～36 行；不新增 import。

### D3 composition 只装配

- `composeBuiltinEmployeeJobs(db, publish)` 签名不变，只做
  `createBuiltinEmployeeJobs({ store: createDigitalEmployeeAuthoringPersistence(db), publish, now: () => Date.now() })`（进程时钟仍在调用时取，
  与 RFC-503 交时钟的做法相同）。
- `composePostgresqlMaintenanceDiskOperations` 的 `report` 改为交给 `reportPostgresqlDiskReclaimable(runtime, appHome)`，与 SQLite 版同形；
  `cleanupRetiredStores`、两个装配入口与缺省的 `Paths.root` 不变。
- `composeRuntimeSelectionParticipantInTx` 建快照表后把它的 `retain` 交给参与者、`readSnapshot` 放进返回值，其余装配不变。

### D4 锁与账本

- `architecture/counts.json`：`composition-control-flow-digital-employee` 19 → 实测（预计 13）、`composition-control-flow-system-operations`
  28 → 实测（预计 26）、`composition-control-flow-runtime-management` 23 → 实测（预计 22）。`guard-manifest.json` 登记 RFC-505 用例。
- 不改：使用方与现有的锁（装配入口不变）；`design/` 里的历史记述。

## 3. 清单（退出门）

| 新位置（`modules/` 下）                                               | 声明并交出                                                     | 只声明不交出         |
| --------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------- |
| `digital-employee/application/builtinEmployeeJobs.ts`（新）           | `BuiltinEmployeeJobsDependencies`、`createBuiltinEmployeeJobs` | —                    |
| `system-operations/infrastructure/postgresqlMaintenanceDisk.ts`（新） | `reportPostgresqlDiskReclaimable`                              | `nonNegativeInteger` |
| `runtime-management/application/runtimeSelection.ts`                  | `createRuntimeSelectionSnapshotsInTx`                          | —                    |

允许的形状：三个组合文件没有 if / for / while / do / switch / try / throw 语句，各自从新位置取实现；`composeBuiltinEmployeeJobs`、
`composeSqliteMaintenanceDiskOperations`、`composePostgresqlMaintenanceDiskOperations`、`composeRuntimeSelectionParticipantInTx` 仍在原文件
声明并导出；system-operations 里 `nonNegativeInteger` 只在新文件声明（collaboration 的三个同名私有函数不在本清单）。

## 4. 用例

新增 `packages/backend/tests/rfc505-employee-jobs-disk-report-runtime-snapshots-out-of-composition-boundary.test.ts`（文件名带
`boundary`），登记 guard-manifest：

- ① 清单里交出的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的新位置声明；`nonNegativeInteger` 在
  system-operations 里只在新文件声明；每个新文件恰好声明、交出清单列的名字，既有文件交出清单列的名字；四个装配入口仍在原文件声明并导出。
- ② 三个组合文件没有控制流语句、各自从新位置取实现（`createBuiltinEmployeeJobs` 恰好调用一次且时钟以函数交出，
  `reportPostgresqlDiskReclaimable` 恰好调用一次，`createRuntimeSelectionSnapshotsInTx` 恰好调用一次）；组合文件不再发 SQL、不再出现
  `new Map`；带负对照。
- ③ 新代码的依赖面是闭集：digital-employee 的新文件只取 `@agent-workflow/shared`、本模块 domain 与 `application/ports`，不取 infrastructure、
  composition、IO 与厂商包，不用进程全局；runtime-management 的文件 import 与此前相同，新函数不用进程全局；system-operations 的新文件不取
  composition；带负对照。

行为由现有用例对拍：内建作业经 `rfc396-mr-job`、`rfc396-registration` 与数字员工的开机用例；PostgreSQL 磁盘报告经
`rfc349-maintenance-disk-provider`（两种 provider）；运行时快照经 `rfc349-runtime-registry-provider`、`rfc359-w9` 与走 `helpers/nodeRunRuntime`
的各条节点运行用例。

## 5. 失败模式

- **用例走样**：函数体逐字迁移；时钟从 `Date.now()` 换成装配传入的 `now()`，调用次数与位置不变；快照表仍随每次装配新建，一笔事务一张。
- **方法脱离接收者**：快照表的 `retain` 与 `readSnapshot` 只用闭包里的表与 `assertTaskScope`，不用 `this`，作为函数值交给参与者与放进返回
  值时行为不变。
- **遗留引用**：装配入口不变，使用方不改；迁移后按名字、路径片段与代码里的字符串字面量全仓再扫，另按全部文件类型扫一遍（RFC-503 的教训）。
- **SQL 走样**：SQL 文本随函数体逐字迁移，`rfc349-maintenance-disk-provider` 的 PostgreSQL 一段对拍结果与只读性。

## 6. 取舍（可推翻）

1. **三个模块一个 RFC**：都是 S10 范围点名的“余项”，各自只有一处、同一种形状（用例或 IO 写在 composition），清单与用例按文件逐项列。
2. **保留装配入口、只迁实现**：入口被 bootstrap、用例辅助、RFC-310 的清单与同文件双实现对按名字或路径钉着，留下它们就不必改使用方；迁出的是
   入口里的判据与 IO。
3. **时钟以函数传入**：与 RFC-503 维护命令的做法一致，application 不碰进程时钟，装配处仍在调用时取。
4. **PostgreSQL 报告落 infrastructure 平铺文件**：本模块 PostgreSQL 的实现文件都平铺在 `infrastructure/postgresql*.ts`；SQLite 版在 `local/`
   不动。
5. **快照表与参与者同文件**：它只服务参与者的 `freeze` 与装配交出的 `readSnapshot`，与能力、参与者同属运行时选择。
6. **不做 `daemonDatabase.ts` / `manualDatabaseMigration.ts`**：两处 `if` 是装配期的路径选择，后者的缺省回落归 S12。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是两组用例与一处 IO，分别落 application 与 infrastructure；三个组合文件只装配、没有控制流；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子（PostgreSQL 报告交出的是报告结果）。
- **C12**：RFC-505 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读三个组合文件与三个新位置；只对这些范围宣告退出门。
- **C13**：三个模块的 `composition-control-flow-*` 收紧到实测；其余触及的计数不升。新的 infrastructure 文件取 platform 的
  `PostgresqlDatabaseRuntime` 类型，组合入口的签名仍取它，跨 context import 的条数随之多一条（类型边，不在 `counts.json` 的计数项里）。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 digital-employee、system-operations 与 runtime-management 的余项：内建作业的确保、PostgreSQL 磁盘报告与运行时快照表离开
  `composition/`，三个模块的非 RFC-370 组合层控制流只剩 system-operations 的两处装配期选择。
- **留下**：`daemonDatabase.ts` 与 `manualDatabaseMigration.ts` 的路径选择（S10 收口的门允许装配期选择时随上限登记；缺省回落随 S12）；
  `crewstation*` / `taskImage*` 待 RFC-370 余项；identity-access 的改密用例、code-capability 的未绑定缺省与 integration 的可选装配另立或随 S12。
