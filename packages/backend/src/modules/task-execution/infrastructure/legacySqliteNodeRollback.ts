import { asc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskRepos, tasks } from '@/db/schema'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createLocalEffectAttemptObserver } from '../application/localEffectObserver'
import type { TaskExecutionEffectPersistence } from '../application/ports/taskExecutionEffectStore'
import { PostgresqlTaskExecutionEffectPersistence } from './postgresqlTaskExecutionEffectPersistence'
import { SqliteTaskExecutionEffectPersistence } from './sqliteTaskExecutionEffectPersistence'

export type LegacySqliteRollbackDatabase = ProviderNeutralDatabase

export async function loadLegacySqliteRollbackTarget(db: ProviderNeutralDatabase, taskId: string) {
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const task = taskRows[0]
  if (task === undefined) return null
  const repoRows = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
    .orderBy(asc(taskRepos.repoIndex))
  const repos =
    repoRows.length > 0
      ? repoRows.map((row) => ({
          worktreePath: row.worktreePath,
          worktreeDirName: row.worktreeDirName,
        }))
      : [{ worktreePath: task.worktreePath, worktreeDirName: '' }]
  return {
    taskId,
    db,
    repoCount: task.repoCount,
    worktreePath: task.worktreePath,
    repos,
  }
}

// RFC-359 W1-T2b：回滚 effect 账本在两个 provider 上各有一份 persistence（W4 pair-deletion 待合一）。
// 这里按客户端品牌挑一份——两边都是真实现（PG daemon 自己的 drive 路径也用同一个类），不是「一好一坏」；
// 残余分支沉入 never 汇（rfc349-provider-completeness 的 fenced-dispatch 账本）。
function rollbackEffectPersistence(db: ProviderNeutralDatabase): TaskExecutionEffectPersistence {
  const provider = databaseSessionFor(db).engine.provider
  if (provider === 'postgresql') {
    return new PostgresqlTaskExecutionEffectPersistence(db as unknown as PostgresqlDatabaseClient)
  }
  if (provider === 'sqlite')
    return new SqliteTaskExecutionEffectPersistence(db as unknown as DbClient)
  return unhandledDatabaseProvider(provider)
}

export function createLegacySqliteRollbackEffectObserver(input: {
  readonly db: ProviderNeutralDatabase
  readonly taskId: string
  readonly nodeRunId: string
  readonly request: unknown
  readonly resourceKeys: readonly string[]
}) {
  return createLocalEffectAttemptObserver({
    persistence: rollbackEffectPersistence(input.db),
    taskId: input.taskId,
    nodeRunId: input.nodeRunId,
    kind: 'workspace-rollback',
    stableActionOrdinal: 'workspace-rollback',
    candidateId: 'node-snapshot-rollback',
    request: input.request,
    resourceKeys: input.resourceKeys,
  })
}
