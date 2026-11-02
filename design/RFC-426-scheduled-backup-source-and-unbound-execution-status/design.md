# RFC-426 技术设计

路径缩写：`S` = `packages/backend/src`，`SO` = `S/modules/system-operations`，`T` = `packages/backend/tests`。以 RFC-425 落库后的源码
（`aa275ba44`）为准。

## 1. 定时备份请求与模块参与者（system-operations）

- `SO/domain/backup.ts` 新增 `SCHEDULED_BACKUP_REQUEST = { includeWorktrees: false, kind: 'scheduled' }`（冻结），即
  `docs/disaster-recovery.md` §1.2 / §6 的定时备份契约。
- `SO/composition.ts`：
  - `SystemOperationsRecoveryAdapter` 新增 `scheduledBackup(): Promise<unknown>`；
  - `SystemOperationsModule` 新增同名的 bootstrap 专用参与者（与 `localContext` 同类）；
  - `composeSystemOperationsWithArtifacts` 把适配器的实现原样交出。

各 provider 的实现：

| 装配                                                                                         | `scheduledBackup`                                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| PostgreSQL（`composePostgresqlSystemOperations`，托管与单机共用）                            | `backup.request(SCHEDULED_BACKUP_REQUEST)`；`backup` 即 `deps.backup ?? 本地协调器`               |
| SQLite（`createLegacyPlatformRecoveryAdapter`，经 `composeSystemOperations` 与本地运维装配） | 进程内快照 `createBackup({ contract, db, appHome, ...SCHEDULED_BACKUP_REQUEST })`，不执行准备步骤 |

托管 / 单机的差别只在 `deps.backup` 是否注入。这个选择点在 RFC-370 起就已存在，本 RFC 只让定时备份也经过它。

两个本地协调器的 `request(input)` 都把 `input.kind` 交给备份实现：

- `SO/infrastructure/postgresqlAdminBackupCoordinator.ts` → `createPostgresqlProviderBackup({ kind })`；
- `SO/infrastructure/legacyPlatformRecoveryAdapter.ts` → `createBackup({ kind })`。

手动备份命令不带 `kind`，仍落成手动家族。

## 2. 会话与定时器

- `S/bootstrap/daemonSessionAdapters.ts`：`DaemonSessionAdapter` 与两个 provider 实现删除 `scheduledBackup`，随之删去只为它存在的类型导入。
- `S/bootstrap/daemonSession.ts`：定时备份作业改为 `startBackupScheduler({ createScheduledBackup: application.core.systemOperations.scheduledBackup, … })`，
  不再把 `databaseBackup` 交给适配表。托管的 `databaseBackup` 仍经 PostgreSQL 核心适配器注入系统运维模块。
- `S/platform/background/providerBackupScheduler.ts`：
  - `createScheduledBackup: () => Promise<unknown>` 改为必填且无参；
  - 删除 `{ db, contract }` 分支、`ScheduledBackupRequest` 与对 SQLite `createBackup` 的导入；
  - 保留 `appHome`，只用于内部轮转。

## 3. 执行可用性

`S/platform/http/executionAvailability.ts`：

```ts
export function readExecutionStatus(app: object): ExecutionStatus {
  const read = readers.get(app)
  if (read === undefined) throw new Error('execution-availability-unbound')
  return read()
}
export function assertExecutionAvailable(app: object, group: ExecutionGroup | undefined): void {
  if (group === undefined) return
  const read = readers.get(app)
  if (read === undefined) return // a test or tool root without a bound reader has no execution gate
  const status = read()
  … // 其后不变
}
```

生产路径 `mountApiRoutes` 先绑定读取器再挂路由，`GET /api/execution/status` 与门控的结果不变。

## 4. 守卫与账本

- **RFC-376**：`deployment-mode-branch-sites` 基线删去 `executionAvailability.ts#readExecutionStatus#comparison#1`（2 → 1），`counts.json`
  上限同步改为 1（原因写明本 RFC）。
- **RFC-391 中立应用图锁**：适配表字段清单删去 `scheduledBackup`。
- **新增结构锁** `T/architecture/rfc426-scheduled-backup-source.test.ts`：
  - provider 适配表（接口与两个实现）没有 `scheduledBackup` 成员；
  - 会话的定时备份作业以 `application.core.systemOperations.scheduledBackup` 为 `createScheduledBackup`；
  - 定时器文件不调用 `createBackup`，也不声明 `db` 选项；
  - `executionAvailability.ts` 不含部署字面量；
  - 负例两组：既有语料替换与纯伪造单元。
- **guard-manifest**：新增一条；改动的守卫刷新行数。

## 5. 测试

- **定时备份来源**：
  - PostgreSQL 模块的两例写在 `rfc349-postgresql-system-operations-composition`，复用该文件已有的运行时夹具：
    - 注入托管协调端口时，`scheduledBackup()` 只发出一次 `{ includeWorktrees: false, kind: 'scheduled' }`，手动备份命令仍只带
      `includeWorktrees`；
    - 不注入时走本地协调器，以准备步骤先被调用为证；
  - 本地 PostgreSQL 协调器把 `kind` / `includeWorktrees` 交给 provider 备份：`rfc349-postgresql-admin-backup` 加一例；
  - SQLite 两例在新增的 `T/rfc426-scheduled-backup-source.test.ts`：
    - 恢复适配器的 `request` 透传 `kind`；
    - 模块的 `scheduledBackup()` 在真实库上产出 `scheduled-*`、清单 `kind: 'scheduled'`、不含工作树，且不调用准备步骤；
  - PostgreSQL 一侧放回既有文件：不新增手搓的 PostgreSQL 运行时（RFC-359 W5 高水位账本），也不改变成对适配器的引用计数。
- **PostgreSQL 备份产物**：`rfc349-postgresql-provider-backup` 增加 scheduled 种类一例：文件名 `scheduled-*`、清单 `kind: 'scheduled'`、
  `includesWorktrees: false`、无 `worktrees/`。
- **定时器**：
  - `rfc349-backup-scheduler-provider` 改为断言每拍无参调用注入函数（文件头注明旧断言为何掩盖了缺陷）；
  - `rfc213-backup-retention` 两例的 SQLite 占位改为空的定时备份函数；
  - `rfc370-backup-scheduler-drain` 不变。
- **执行可用性**（`rfc370-v2-execution-authority`）：
  - 未绑定 app 不门控、`readExecutionStatus` 报 `execution-availability-unbound`、状态路由返回 500；
  - 绑定单机状态后状态路由返回 `standalone / active`；
  - 托管一例不变。
- **适配器夹具**：`SystemOperationsRecoveryAdapter` 的四处测试夹具补上 `scheduledBackup`：三个 `composeSystemOperationsWithRecoveryAdapter` 使用方，
  与 RFC-359 W8 恢复一致性用例的 PostgreSQL 夹具（与生产同形）。
- **文档**：`docs/disaster-recovery.md` §1.2 补一句：单机 PostgreSQL 在本 RFC 之前误落的 `agent-workflow-*` 定时备份按手动家族处理。
