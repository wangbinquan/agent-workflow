import { ZodError } from 'zod'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createLogger, type Logger } from '@/util/log'
import {
  createResourcePackageApplyActivityQuery,
  createResourcePackageApplyActivityRegistry,
  createResourcePackageApplyMaintenanceCommand,
  type ResourcePackageApplyActivitySource,
  type ResourcePackageApplyArtifactRecoveryPort,
  type ResourcePackageApplyActivityTracker,
  type ResourcePackageApplyMaintenanceLog,
} from '../application/resourcePackageMaintenance'
import { createPostgresqlResourcePackageApplyArtifactRecovery } from '../infrastructure/postgresqlResourcePackageMaintenance'
import { createResourcePackageApplyJournalPort } from '../infrastructure/resourcePackageApplyJournal'
import { createSqliteResourcePackageApplyArtifactRecovery } from '../infrastructure/sqliteResourcePackageMaintenance'
import type { ResourcePackageApplyMaintenanceCommand } from '../public/commands'
import type { ResourcePackageApplyActivityQuery } from '../public/queries'

export interface ResourcePackageApplyMaintenance {
  readonly command: ResourcePackageApplyMaintenanceCommand
  readonly activity: ResourcePackageApplyActivityQuery
}

export interface PostgresqlResourcePackageApplyMaintenance extends ResourcePackageApplyMaintenance {
  /** Provider-private writer used by the PostgreSQL apply owner around a claimed journal. */
  readonly activityTracker: ResourcePackageApplyActivityTracker
}

/**
 * RFC-359 —— 落盘工件的**跨格式回落**。
 *
 * apply 引擎合一之后，两个 provider 写出的半成品工件都是统一那一种格式；但一台在合一**之前**
 * 起的 SQLite daemon 可能在盘上留着旧格式的半成品（逐条 `opId`、字段名也不同）。读回侧只认
 * 新格式的话，那些 journal 行会永久卡住、半成品目录永远收不掉——正是
 * `rfc359-w5-artifact-format-portability` 那张矩阵在防的事。
 *
 * 回落判据是 `ZodError`：两个解码器都在**任何副作用之前**整体解码
 * （`parseArtifacts` / `parseReceipt` 是两个入口的第一件事），所以「格式不认识」时一个字节都没动过，
 * 换一个读回侧重试是安全的。其它错误（路径越界、缺文件、DB 失败）照原样抛出，不吞。
 */
export function composeResourcePackageApplyArtifactRecoveryChain(
  primary: ResourcePackageApplyArtifactRecoveryPort,
  legacy: ResourcePackageApplyArtifactRecoveryPort,
): ResourcePackageApplyArtifactRecoveryPort {
  type Journal = Parameters<ResourcePackageApplyArtifactRecoveryPort['rollForward']>[0]
  const withFallback = async (
    operation: 'rollForward' | 'compensate',
    journal: Journal,
  ): Promise<void> => {
    try {
      await primary[operation](journal)
    } catch (error) {
      if (!(error instanceof ZodError)) throw error
      await legacy[operation](journal)
    }
  }
  return Object.freeze({
    rollForward: (journal: Journal) => withFallback('rollForward', journal),
    compensate: (journal: Journal) => withFallback('compensate', journal),
  })
}

function maintenanceLog(log: Logger): ResourcePackageApplyMaintenanceLog {
  return Object.freeze({
    warn(message: string, fields: Readonly<Record<string, string>>) {
      log.warn(message, fields)
    },
  })
}

export function composeSqliteResourcePackageApplyMaintenance(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly pluginsDir: string
  readonly activitySource: ResourcePackageApplyActivitySource
  readonly now?: () => number
  readonly log?: Logger
}): ResourcePackageApplyMaintenance {
  const log = input.log ?? createLogger('resourcePackageMaintenance')
  return Object.freeze({
    command: createResourcePackageApplyMaintenanceCommand({
      journal: createResourcePackageApplyJournalPort(input.db),
      // RFC-359 —— 写出侧已合一，读回侧跟着：先按统一格式读，读不认识才回落到 legacy 那一份
      // （只可能是合一之前留在盘上的半成品）。
      artifacts: composeResourcePackageApplyArtifactRecoveryChain(
        createPostgresqlResourcePackageApplyArtifactRecovery({
          db: input.db,
          appHome: input.appHome,
          pluginsDir: input.pluginsDir,
        }),
        createSqliteResourcePackageApplyArtifactRecovery({
          db: input.db,
          appHome: input.appHome,
          pluginsDir: input.pluginsDir,
          log: maintenanceLog(log),
        }),
      ),
      ...(input.now === undefined ? {} : { now: input.now }),
      log: maintenanceLog(log),
    }),
    activity: createResourcePackageApplyActivityQuery(input.activitySource),
  })
}

export function composePostgresqlResourcePackageApplyMaintenance(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly pluginsDir: string
  readonly now?: () => number
  readonly log?: Logger
}): PostgresqlResourcePackageApplyMaintenance {
  const activity = createResourcePackageApplyActivityRegistry()
  const log = input.log ?? createLogger('resourcePackageMaintenance')
  return Object.freeze({
    command: createResourcePackageApplyMaintenanceCommand({
      journal: createResourcePackageApplyJournalPort(input.db),
      artifacts: createPostgresqlResourcePackageApplyArtifactRecovery({
        db: input.db,
        appHome: input.appHome,
        pluginsDir: input.pluginsDir,
      }),
      ...(input.now === undefined ? {} : { now: input.now }),
      log: maintenanceLog(log),
    }),
    activity: activity.query,
    activityTracker: activity.tracker,
  })
}
