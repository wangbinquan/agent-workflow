# RFC-539 技术设计

## 1. 现状（HEAD `d2bd30700`，源码实读）

- **计数**（`platform/persistence/sqlite/systemProviderBackup.ts`）：模块级 `let activeDbSnapshots = 0`；`isDbSnapshotInProgress()` 返回它是否大于零。
  `quickCheckOffThread(dbPath)` 与 `vacuumIntoOffThread(sqlite, dbPath, dest)` 在 `try / finally` 里加一、减一（worker 起不来时同线程回退，计数照样
  包住）。
- **快照方**：
  - 备份：`createBackup(opts)` 对 `opts.db` 的原生连接做 `VACUUM INTO`（有文件的库经 `vacuumIntoOffThread`）。system-operations 的平台恢复适配器
    （`legacyPlatformRecoveryAdapter.ts`）以会话交来的库调它（手动备份与定时备份）。
  - 迁移安全备份：system-operations 的 `createSqliteMigrationSafetyBackup()`（`sqliteMigrationSafetyBackup.ts`）按路径另开只读连接
    `vacuumIntoOffThread`，再对临时文件 `quickCheckOffThread`；迁移协调器（`databaseMigrationCoordinator.ts`）缺省建它，daemon 会话
    （`bootstrap/daemonSession.ts`）与命令行（`composition/databaseMigration.ts` 的本机操作）各组一份迁移模块。
- **读者**：维护服务的 checkpoint 时钟在 `options.fileSnapshotInFlight()` 为真时跳过这一拍（`platform/background/maintenanceService.ts`）；SQLite 的
  会话适配器（`bootstrap/daemonSessionAdapters.ts`）交 `isDbSnapshotInProgress`，PostgreSQL 交 `() => false`。`runSqliteWalCheckpointTick(db)`
  （`systemMaintenanceOperations.ts`，经 `providerBackupScheduler.ts` 转出为 `runWalCheckpointTick`）同样先问计数——生产里没有调用方，用例用它
  验证“快照期间跳过”。
- **句柄上下文**（`platform/persistence/sessionTables.ts`）：RFC-537 起每个句柄的上下文带即时投递泵的一格槽，客户端、事务与原生会话共用。
- **用例**：`rfc311-backup-concurrency`、`rfc311-backup-worker-fallback` 直接调 `vacuumIntoOffThread` / `isDbSnapshotInProgress` /
  `runWalCheckpointTick`（后者用裸的 `bun:sqlite` 连接）；`rfc349-safety-backup-off-thread-verify` 直接调 `quickCheckOffThread(path)`。

## 2. 机制与落位

落在 platform/persistence（计数器与句柄上下文）与 bootstrap（会话把自己库的那一份往下交）；system-operations 只多收一个依赖。

### D1 文件快照计数器

- 新增 `platform/persistence/fileSnapshots.ts`：`FileSnapshotTracker`（`inFlight(): boolean`、`track(run)`——`run` 期间计一次，`finally` 里撤销）与
  `createFileSnapshotTracker()`。
- `sessionTables.ts`：`DatabaseHandleContext` 多一格 `fileSnapshots`（`bindDatabaseHandle` 建上下文时一并建一个计数器，派生句柄共用）；
  `fileSnapshotTrackerOf(handle)` 取回，没有句柄上下文的对象抛 `file-snapshot-handle-unbound`。
- `systemProviderBackup.ts` 删去模块级计数与 `isDbSnapshotInProgress`：`quickCheckOffThread(dbPath, snapshots)` 与
  `vacuumIntoOffThread(sqlite, dbPath, dest, snapshots)` 在 `snapshots.track(…)` 里跑（回退与报错逐字不变）；`createBackup` 用
  `fileSnapshotTrackerOf(opts.db)`。`runSqliteWalCheckpointTick(db, snapshots)` 改问交进来的计数器。

### D2 会话交出自己库的那一份

- `daemonSessionAdapters.ts` 的 SQLite 维护适配器：`fileSnapshotInFlight` 取会话库的计数器（`fileSnapshotTrackerOf(db).inFlight`）；PostgreSQL 不变。
- `daemonSession.ts`：迁移模块多收 `fileSnapshots: fileSnapshotTrackerOf(db)`，经迁移协调器的选项交给 `createSqliteMigrationSafetyBackup(snapshots)`；
  命令行的本机迁移操作（没有 daemon、没有 checkpoint 时钟）各建一个计数器。

### D3 用例与锁

- 新增 `tests/rfc539-database-file-snapshots-boundary.test.ts`，登记 guard-manifest：① `systemProviderBackup.ts` 顶层没有 `let` 与集合、架构报告
  的模块级可变单例判据为空；生产代码不再引用删去的名字；`quickCheckOffThread(` / `vacuumIntoOffThread(` 每处调用都带计数器实参；SQLite 维护
  适配器与会话的迁移模块取会话库的计数器（语料下限 3,000）；② 行为：计数器在 `track` 期间在途、抛错也撤销；两个库的上下文各一份；派生句柄
  与客户端共用；没有句柄上下文的对象取不到；③ 两个引擎上的真库：一个库的快照不挡另一个库的 checkpoint 判断；带负对照。
- 读旧形状的用例随改：`rfc311` 的两个用例与 `rfc349-safety-backup-off-thread-verify` 给计数器实参、按计数器断言在途。

## 3. 清单（退出门）

| 名字                                           | 之后                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `activeDbSnapshots` / `isDbSnapshotInProgress` | 删去；句柄上下文的 `fileSnapshots`（`fileSnapshotTrackerOf(handle)`） |
| `quickCheckOffThread(dbPath)`                  | 改为 `quickCheckOffThread(dbPath, snapshots)`                         |
| `vacuumIntoOffThread(sqlite, dbPath, dest)`    | 改为 `vacuumIntoOffThread(sqlite, dbPath, dest, snapshots)`           |
| `runSqliteWalCheckpointTick(db)`               | 改为 `runSqliteWalCheckpointTick(db, snapshots)`                      |

## 4. 用例

- ① ～ ③ 见 D3；既有用例覆盖备份并发、worker 回退、迁移安全备份的离线程校验与维护服务的接缝。

## 5. 失败模式

- **快照方与 checkpoint 门拿到的不是同一份**：快照期间 checkpoint 不跳过，冻结重现。RFC-539 用例钉会话把自己库的那一份交给迁移模块与维护
  适配器，备份按它快照的库取；变异验证（交一份新的计数器）兜底。
- **计数漏撤**：`track` 在 `finally` 里撤销，抛错也撤；用例覆盖。

## 6. 取舍（可推翻）

1. **挂在句柄上下文而不是会话另建一份往下交**：备份的快照方本来就以会话的库为参数，取库的那一份不必穿过 system-operations 的装配；迁移安全
   备份按路径另开连接，才由会话显式交。
2. **计数器放在中立的 `fileSnapshots.ts`**：句柄上下文是中立的，不反向依赖 SQLite 的备份文件；PostgreSQL 句柄也有一份，从不被快照。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只把依赖往下交。**C11**：各模块 public 不变（system-operations 的迁移模块多收一个依赖）。**C12**：RFC-539 用例覆盖。
  **C13**：计数不升，模块级可变单例 55 → 54。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第七步（SQLite 文件快照的在途计数，1 条）。
- **留下**：其余 54 条（可迁移的登记与绑定 18 条；凭据 / 访问 / 完整性相邻的 9 条；进程级缓存与计数器 27 条须经用户确认是否保留并修订
  §14 口径）。
