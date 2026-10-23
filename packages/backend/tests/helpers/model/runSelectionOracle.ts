// RFC-395 II-a A3：旧物理形状只在 fixture 内读写，供 oracle 与原 picker / SQL 对拍。
import { and, asc, eq, not } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { structurallySupersededCondition } from './frozenSelection/supersessionSql'
import type { OracleRunRow } from '@/modules/task-execution/infrastructure/runSelection/oracle/rows'

export async function readRunSelectionOracleFixtures(
  db: PersistenceDb,
  taskId: string,
): Promise<readonly OracleRunRow[]> {
  const { nodeRuns } = tablesOf(db)
  return db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
}

/** A1 正常 spec 刻意不允许 NULL seq 或旧 JSON；这里只用于历史兼容反例。 */
export async function patchLegacyRunSelectionFixture(
  db: PersistenceDb,
  runId: string,
  values: {
    readonly seq?: null
    readonly consumedUpstreamRunsJson?: string | null
  },
): Promise<void> {
  const { nodeRuns } = tablesOf(db)
  await db.update(nodeRuns).set(values).where(eq(nodeRuns.id, runId))
}

export async function readUnsupersededRunSelectionFixtureIds(
  db: PersistenceDb,
  taskId: string,
): Promise<readonly string[]> {
  const { nodeRuns } = tablesOf(db)
  return (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), not(structurallySupersededCondition(db))))
  )
    .map((row) => row.id)
    .sort()
}

/** taskNodeRunsProjection / codeWorkspaceRead 保留的旧 DTO 排序。 */
export async function readRunSelectionTimelineFixtureIds(
  db: PersistenceDb,
  taskId: string,
): Promise<string[]> {
  const { nodeRuns } = tablesOf(db)
  return (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
      .orderBy(
        engineOf(db).ascNullsFirst(nodeRuns.startedAt),
        engineOf(db).ascNullsFirst(nodeRuns.seq),
        asc(nodeRuns.id),
      )
  ).map((row) => row.id)
}
