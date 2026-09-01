import { eq, inArray, isNull, ne } from 'drizzle-orm'

import {
  developmentActionRuns,
  developmentAgentAttempts,
  developmentEffects,
  developmentFactSnapshots,
  developmentMissions,
  developmentWakeHints,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { FactSnapshotReader } from '../application/ports/reconcilerPorts'
import type { FactCell } from '../domain/factCell'
import type { FactCellValue } from '../domain/facts'

export function createPostgresqlFactSnapshotReader(
  db: PostgresqlDatabaseClient,
): FactSnapshotReader {
  return {
    async getCells(snapshotId) {
      const row = await db
        .select({ cellsJson: developmentFactSnapshots.cellsJson })
        .from(developmentFactSnapshots)
        .where(eq(developmentFactSnapshots.id, snapshotId))
        .limit(1)
        .get()
      if (row === undefined) return null
      return JSON.parse(row.cellsJson) as Record<string, FactCell<FactCellValue>>
    },
  }
}

export async function postgresqlMissionIdOfExecutionRef(
  db: PostgresqlDatabaseClient,
  executionRef: string,
): Promise<string | null> {
  const row = await db
    .select({ missionId: developmentActionRuns.missionId })
    .from(developmentAgentAttempts)
    .innerJoin(
      developmentActionRuns,
      eq(developmentAgentAttempts.actionRunId, developmentActionRuns.id),
    )
    .where(eq(developmentAgentAttempts.executionRef, executionRef))
    .limit(1)
    .get()
  return row?.missionId ?? null
}

export async function listPostgresqlFencedMissionIds(
  db: PostgresqlDatabaseClient,
): Promise<string[]> {
  return (
    await db
      .select({ id: developmentMissions.id })
      .from(developmentMissions)
      .where(ne(developmentMissions.transitionFence, 'none'))
      .all()
  ).map((row) => row.id)
}

export async function listPostgresqlPreparedEffectRows(
  db: PostgresqlDatabaseClient,
): Promise<{ readonly id: string; readonly missionId: string; readonly epoch: number }[]> {
  return await db
    .select({
      id: developmentEffects.id,
      missionId: developmentEffects.missionId,
      epoch: developmentEffects.epoch,
    })
    .from(developmentEffects)
    .where(eq(developmentEffects.state, 'prepared'))
    .all()
}

export async function listPostgresqlUnconsumedWakeHintMissionIds(
  db: PostgresqlDatabaseClient,
): Promise<string[]> {
  const rows = await db
    .select({ missionId: developmentWakeHints.missionId })
    .from(developmentWakeHints)
    .where(isNull(developmentWakeHints.consumedAt))
    .all()
  return [...new Set(rows.map((row) => row.missionId))]
}

export async function postgresqlMissionEpochsOf(
  db: PostgresqlDatabaseClient,
  missionIds: readonly string[],
): Promise<Map<string, number>> {
  if (missionIds.length === 0) return new Map()
  const rows = await db
    .select({ id: developmentMissions.id, epoch: developmentMissions.epoch })
    .from(developmentMissions)
    .where(inArray(developmentMissions.id, [...missionIds]))
    .all()
  return new Map(rows.map((row) => [row.id, row.epoch]))
}
