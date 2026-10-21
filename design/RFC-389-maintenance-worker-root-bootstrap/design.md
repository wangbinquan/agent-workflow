# RFC-389 设计：维护 Worker 根迁入 bootstrap

研究基线 HEAD `3450e6872`（行号以实施时源码为准）。缩写：

- `W:` = `platform/background/maintenanceWorker.ts`
- `SV:` = `platform/background/maintenanceWorkerSupervisor.ts`
- `S:` = `cli/start.ts`
- `T/` = `packages/backend/tests/`

其余路径相对 `packages/backend/src/`。研究笔记见本会话 2026-10-21 的只读研究（S2b 余项三部分）。

## 1. 现状

### 1.1 W 的内容

| 类别 | 位置 | 说明 |
| --- | --- | --- |
| 模块级状态 | W:89-121 | 29 个 `let`：连接与 14 个图成员，外加运行状态（处理中、排空、初始化、当前租约、两个定时器、计时直方图、切片诊断） |
| 机制 | W:133-342、W:363-571 | 计时直方图、事件、错误分类与退避、关库（W:279-332）、排空、队列循环（经 `runMaintenanceJob({ ownerCommands })` 使用图） |
| 初始化前后 | W:573-597、W:845-905 | 目录摘要校验、等待上一代关闭、效果作用域、`store.recoverRunning`、定时器、就绪事件 |
| 消息路由 | W:907-953 | `self.onmessage`：初始化 / 唤醒 / 排空 / 延迟排空 |
| 组合 | W:598-844、W:344-361 | 两支模块图；GC 阶段保护物化中任务的包装 |

### 1.2 两支对照

| 成员 | PostgreSQL | SQLite | 结论 |
| --- | --- | --- | --- |
| 开库 | 专用运行时，`poolMax ≤ 2`（W:602），客户端接托管写围栏 `beforeWrite`（W:607） | `openDb`（W:721-737），挂语句 / 事务计时观察器（W:732） | 适配 |
| 关库 | `runtime.close()` | `$client.close()`（W:318-321） | 适配 |
| 维护运行账本、集成、任务恢复、任务归档、工作区维护、令牌审计、插件代 GC、执行围栏、开发自动化、数字员工、意图 | 同一组工厂，只差 db 句柄 | 同 | 中立（两支构造顺序不同，均为被动构造） |
| 系统维护：备份、对象发布 | `databaseBackups` + `objectPublications`（W:654） | 只有 `databaseBackups` | 中立（对象发布只有托管有值） |
| 事件归档存储 | `createPostgresqlEventsArchiveStore` | `createEventsArchiveStore` | 适配 |
| 保留期切片 | W:660-689 | W:777-801 | 中立（同一 `runRetentionSweepSlice`，RFC-359 W57） |
| 存储维护 | 运维适配器 `runStorageMaintenance()`（W:690） | WAL checkpoint，计数 `{ checkpointed: 1 }`（W:802） | 适配 |
| 资源包维护 | `composePostgresqlResourcePackageApplyMaintenance` | `composeSqliteResourcePackageApplyMaintenance`（多传 `activitySource`、日志） | 适配 |
| 认领退避计数键 | `postgresqlTransientDeferrals` | `sqliteBusyDeferrals`；W:458-461 按「是否有 SQLite 句柄」选择 | 适配 |

W:267、W:527-529 的计数键按错误分类决定，属机制，不变。

### 1.3 入口与清单

- 入口：
  - SV:106-112 写死默认入口（编译态 `./platform/background/maintenanceWorker.ts`；源码态是相对本文件的 URL）。
  - 托管入口由 `bootstrap/crewstationMaintenance.ts:63-76` 给出，经效果描述符的 `workerEntry` 传入（SV:132-135）。
  - `bootstrap/maintenanceWorkerEntry.ts:10` 以副作用导入 platform Worker。
- 两个会话构造维护服务与监督器的位置：HEAD 约 S:707-716、S:2547-2561。
- 构建清单：`scripts/build-binary.ts:53-59` 的 `WORKER_ENTRIES`。
- 架构清单：
  - `T/architecture/rfc294Gates.ts:25-33` 的 `BINARY_ENTRIES`；
  - `T/architecture/census.ts:74-106` 的 `BOOTSTRAP_FILES`，现含 `platform/background/maintenanceWorker`；
  - `T/architecture/rfc376-structural-guards.test.ts` 的精确基线：platform 文件对 19 条，`direct-setinterval-sites` 中 W 的 2 个键。
- 计数（HEAD）：
  - `platform-to-modules-file-pairs` 49，其中 W 占 19；
  - commons-debt R1 里 W 有 3 条：`intent/application/turnEngine` 的值导入，两个 task-execution `application/ports` 的类型导入。

## 2. 设计

### 2.1 platform：Worker 运行时（G3）

`platform/background/maintenanceWorkerRuntime.ts` 提供 `runMaintenanceWorker({ composeGraph })`：安装错误边界与 `self.onmessage`，承载 W 的全部
机制、时序与事件。它只依赖 platform（含 `maintenanceJobRunner.ts` 的类型），不导入 `modules/`。端口：

```ts
interface MaintenanceWorkerObservers {
  statement(ms: number, sql: string, cpuMs: number | undefined): void
  transaction(ms: number): void
}
interface MaintenanceWorkerGraph {
  readonly store: MaintenanceRunStore
  readonly ownerCommands: MaintenanceOwnerCommands // runMaintenanceJob 的 ownerCommands 类型，由 maintenanceJobRunner 导出
  readonly busyDeferralCounter: 'sqliteBusyDeferrals' | 'postgresqlTransientDeferrals'
  close(): Promise<void>
}
type MaintenanceWorkerGraphFactory = (input: {
  readonly request: MaintenanceWorkerInitRequest
  readonly appHome: string
  readonly effects: MaintenanceWorkerEffectsSelections | undefined
  readonly observe: MaintenanceWorkerObservers
}) => Promise<MaintenanceWorkerGraph>
```

初始化顺序不变：目录摘要校验 → 等待上一代关闭 → 效果作用域 → `composeGraph` → `graph.store.recoverRunning` → 定时器与就绪。
关停时 `graph.close()` 与效果作用域释放的失败聚合不变（W:279-332）。图工厂失败与现状一样：`degraded` + 关闭 + 排空回执。观察器只在有
当前切片时记录，语义同 W:732-736。

`platform/background/maintenanceSystemOperations.ts`（中立）提供 `composeMaintenanceSystemOperations({ db, eventsArchiveStore, storage,
databaseBackups, objectPublications, logsDir })`：事件归档命令、保留期切片（W:660-689 与 W:777-801 合一）、存储维护。

### 2.2 bootstrap：薄入口根与线程内图（G1、G2）

- **`bootstrap/maintenanceWorker.ts`（Worker 入口根）**：只有 `runMaintenanceWorker({ composeGraph: composeMaintenanceWorkerGraph })`。
- **`bootstrap/maintenanceWorkerGraph.ts`**：
  - provider 适配表：由初始化请求的形状选择（带 `database` 的是 PostgreSQL，同现状），给出开库、关库、事件归档存储、存储维护、资源包维护
    与计数键；
  - `composeMaintenanceWorkerGraph`：用同一组工厂，把十一个所有者命令各构造一次；GC 阶段保护物化中任务的包装（W:344-361）随图迁入，
    或并入其所属模块的 composition。
- **`bootstrap/maintenanceWorkerEntries.ts`（无副作用）**：独立部署的 Worker 入口路径（编译态 `./bootstrap/maintenanceWorker.ts`，源码态
  `new URL('./maintenanceWorker.ts', import.meta.url).href`）。托管入口常量可一并移来或留在原处，实施时择一。主线程只导入这个文件，
  **绝不**导入 Worker 根（否则会在主线程安装 `self.onmessage`）。
- **`bootstrap/maintenanceWorkerEntry.ts`（托管）**：注册效果后 `import './maintenanceWorker'`。
- **R1 消账**：
  - 意图的临时目录名不再从 `intent/application/turnEngine` 导入，改由意图的维护 composition 自带（或经其 public / composition 导出）；
  - 两个 task-execution `application/ports` 类型不再需要显式导入（推断，或改用 public 类型）。

### 2.3 监督器入口（G4）

- `startMaintenanceWorkerSupervisor` 的独立入口改为必填输入；托管效果描述符的 `workerEntry` 仍优先。
- SV 删除 `MAINTENANCE_WORKER_ENTRY` 与对应的编译态判断。
- 两个会话显式传入 `bootstrap/maintenanceWorkerEntries.ts` 给出的独立入口。
- 测试的 `workerFactory` 接缝不变。

### 2.4 清单与账本（G5）

- 构建：`WORKER_ENTRIES` 改指 `bootstrap/maintenanceWorker.ts`；托管入口不变。
- 架构清单：
  - `BOOTSTRAP_FILES` 去掉 `platform/background/maintenanceWorker`，加入新的 bootstrap 文件；
  - `BINARY_ENTRIES` 同步；
  - RFC-376 精确基线：platform 文件对减少；`direct-setinterval-sites` 的两个键随运行时文件改名。
- 账本：
  - commons-debt R1 三条按 §2.2 消账；
  - `architecture/counts.json` 的 `platform-to-modules-file-pairs` 上限压到实测值（预计 30）。
- 文本引用：约 20 个测试文件的路径引用，`docs/audit-backlog.md` 两处路径。

## 3. 失败模式

- **编译态入口与构建清单不一致**：发布版会 ModuleNotFound。由 `T/rfc370-maintenance-worker-real-effects.test.ts` 的真编译探针，以及新结构锁
  「构建清单 = 会话传入的入口」锁定。
- **主线程误导入 Worker 根**：结构锁禁止除托管入口外的任何文件导入 `bootstrap/maintenanceWorker.ts`。
- **图工厂失败**：同现状。

## 4. 测试策略

1. 现有维护 Worker 用例全部通过、不改断言意图：`T/rfc338-maintenance-*`、`T/rfc370-maintenance-worker-*`、`T/rfc370-v9-maintenance-worker-entry.test.ts`，
   以及 `T/helpers/providerMaintenanceWorker.ts` 的使用者。
2. 中立图（双引擎）：
   - 同一工厂在两个 provider 上给出相同的所有者命令键集合；
   - 适配表成员按 provider 给出：事件归档存储、存储维护的计数、退避计数键、关库；
   - SQLite 的观察器接到语句 / 事务计时。
3. 结构锁（新守卫，登记 `architecture/guard-manifest.json`）：
   - platform/background 不含 Worker 组合根，不新增对 `modules/` 的导入；
   - Worker 图里每个所有者命令工厂恰好调用一次，无 provider 分支；
   - Worker 入口在 bootstrap，构建清单、`BINARY_ENTRIES`、会话传入的入口三者一致；
   - platform 源码不出现 `bootstrap/` 路径；
   - 只有托管入口导入 Worker 根。
4. 旧锁与清单（改指，不放宽）：
   - `T/architecture/{census.ts, rfc294Gates.ts, rfc376-structural-guards.test.ts, rfc359-w5-unattended-void-promise.test.ts, rfc359-converged-twins.test.ts}`；
   - `T/rfc310-architecture-lock.test.ts`、`T/rfc338-maintenance-architecture.test.ts`、`T/rfc370-storage-and-worker-root-bindings.test.ts`；
   - 账本 `architecture/{commons-debt,counts,guard-manifest}.json`。

## 5. 与 RFC-294 目标架构的对齐

- Worker 线程成为 bootstrap 的薄入口根，线程内模块图唯一，provider 是适配器选择；platform 去掉 19 条对模块的依赖。
- 留下的债：
  - job runner / 效果描述符的模块类型导入（S5）；
  - 独立 / 托管两个入口（S2c）；
  - 资源包维护的两个 provider 命名函数（resource-catalog）。
- 无偏离项。
