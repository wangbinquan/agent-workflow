// RFC-359 AC-10 —— 维护准入的 SQLite 连接，从 `maintenanceService` 搬到这一层。
//
// 这条连接原本由 `startMaintenanceService` 自己开：服务先问 `options.provider === 'postgresql'`，
// 是就用装配方给的 store，不是就现场 `openDb(...)`。AC-10 把「准入存储从哪来」交回装配方之后，
// 这段 `openDb` 一度被搬进 `cli/start.ts` 的 SQLite 调用点——**那是错的层**：
// `rfc349-provider-cutover` 明写 `cli/start.ts` 不得 import `@/db/client`（「provider factory
// owns SQLite」），daemon 入口只负责选与装，不负责开库。
//
// 所以它落在这里：`platform/persistence/` 本来就是 provider 感知层（也是 W5-T19 的白名单前缀），
// 这一层开 SQLite 连接是它的本职。`cli/start.ts` 只 import 这个工厂。

import { openDb } from '@/db/client'
import { createMaintenanceRunStore } from '../maintenanceRunStore'
import type { MaintenanceRunStore } from '@/platform/background/maintenanceRunStorePort'

/**
 * 每日档会在同一个墙上时刻放行全部重任务。把每条 INSERT 的等待压到极小，争用的 12 任务周期
 * 才不会累加成一次可见的主事件循环卡顿；准入控制器每个槽位都会重试。
 *
 * RFC-338 起是 5ms，原名 `ADMISSION_BUSY_TIMEOUT_MS`、住在 `maintenanceService.ts`——
 * 「忙等」只有本地库文件形态才有这回事，它住在那个中立服务里本身就是错位。
 */
const ADMISSION_BUSY_TIMEOUT_MS = 5

export interface SqliteMaintenanceAdmissionInput {
  readonly dbPath: string
  readonly migrationsFolder: string
  readonly synchronous: 'NORMAL' | 'FULL'
  readonly pageCacheMib: number
  readonly mmapMib: number
}

/**
 * 维护准入专用的**短等待**本地连接，包成 run store 交出去。
 *
 * 准入绝不借用前台请求连接：被争用的持久 INSERT 最多把一个槽位推迟一个监工 tick，
 * 永远不会占着 HTTP 事件循环上主连接历史上的那 5 秒。
 *
 * `journalMode: 'preserve'` —— 这是条**次级**连接，日志模式由主连接建立一次，
 * 它不得在前台写入者活跃时重新发起一次 journal 迁移。
 */
export function openSqliteMaintenanceAdmissionStore(input: SqliteMaintenanceAdmissionInput): {
  readonly store: MaintenanceRunStore
  readonly close: () => void
} {
  const admissionDb = openDb({
    path: input.dbPath,
    migrationsFolder: input.migrationsFolder,
    skipMigrations: true,
    skipIntegrityCheck: true,
    journalMode: 'preserve',
    synchronous: input.synchronous,
    pageCacheMib: Math.min(16, input.pageCacheMib),
    mmapMib: input.mmapMib,
    busyTimeoutMs: ADMISSION_BUSY_TIMEOUT_MS,
    slowQueryMs: 0,
  })
  return {
    store: createMaintenanceRunStore(admissionDb),
    close: () => (admissionDb as unknown as { $client?: { close(): void } }).$client?.close(),
  }
}
