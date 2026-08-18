// RFC-310 PR-2 —— reconciler/recovery 的读侧辅助（T26/T30）。
//
// MissionStore port（fork D 交付）刻意只提供写路径与逐行读；本文件补三个
// 纯读查询：fact snapshot cells 读回、fence 扫描、prepared-effect 扫描。
// 全部只读、无业务分支——留在 infrastructure，经装配点注入。

import { eq, inArray, isNull, ne } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  developmentActionRuns,
  developmentAgentAttempts,
  developmentEffects,
  developmentFactSnapshots,
  developmentMissions,
  developmentWakeHints,
} from '@/db/schema'
import type { FactCellValue } from '../domain/facts'
import type { FactCell } from '../domain/factCell'
import type { FactSnapshotReader } from '../application/ports/reconcilerPorts'

export function createSqliteFactSnapshotReader(db: DbClient): FactSnapshotReader {
  return {
    getCells(snapshotId) {
      const row = db
        .select()
        .from(developmentFactSnapshots)
        .where(eq(developmentFactSnapshots.id, snapshotId))
        .get()
      if (row === undefined) return null
      return JSON.parse(row.cellsJson) as Record<string, FactCell<FactCellValue>>
    },
  }
}

/** transition_fence ≠ none 的 mission id（启动恢复扫描）。 */
export function listFencedMissionIds(db: DbClient): string[] {
  return db
    .select({ id: developmentMissions.id })
    .from(developmentMissions)
    .where(ne(developmentMissions.transitionFence, 'none'))
    .all()
    .map((r) => r.id)
}

/** 仍有 prepared effect 的 mission id 及其行（epoch 过期失效扫描）。 */
export function listPreparedEffectRows(db: DbClient): {
  readonly id: string
  readonly missionId: string
  readonly epoch: number
}[] {
  return db
    .select({
      id: developmentEffects.id,
      missionId: developmentEffects.missionId,
      epoch: developmentEffects.epoch,
    })
    .from(developmentEffects)
    .where(eq(developmentEffects.state, 'prepared'))
    .all()
}

/** PR-4 —— agent execution 终态回调的反查：executionRef → missionId。 */
export function missionIdOfExecutionRef(db: DbClient, executionRef: string): string | null {
  const row = db
    .select({ missionId: developmentActionRuns.missionId })
    .from(developmentAgentAttempts)
    .innerJoin(
      developmentActionRuns,
      eq(developmentAgentAttempts.actionRunId, developmentActionRuns.id),
    )
    .where(eq(developmentAgentAttempts.executionRef, executionRef))
    .get()
  return row?.missionId ?? null
}

/** wake sweep 读侧：有未消费 wake hint 的 mission id（去重）。 */
export function listUnconsumedWakeHintMissionIds(db: DbClient): string[] {
  const rows = db
    .select({ missionId: developmentWakeHints.missionId })
    .from(developmentWakeHints)
    .where(isNull(developmentWakeHints.consumedAt))
    .all()
  return [...new Set(rows.map((row) => row.missionId))]
}

/** 给定 mission 集合的当前 epoch（recovery 对拍 effect.epoch 用）。 */
export function missionEpochsOf(db: DbClient, missionIds: readonly string[]): Map<string, number> {
  if (missionIds.length === 0) return new Map()
  const rows = db
    .select({ id: developmentMissions.id, epoch: developmentMissions.epoch })
    .from(developmentMissions)
    .where(inArray(developmentMissions.id, [...missionIds]))
    .all()
  return new Map(rows.map((r) => [r.id, r.epoch]))
}
