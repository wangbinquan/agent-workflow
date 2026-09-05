// RFC-310 PR-2 —— reconciler/recovery 的读侧辅助（T26/T30）。RFC-359 W4-B5：一份实现，两个 provider 共用。
//
// MissionStore port（fork D 交付）刻意只提供写路径与逐行读；本文件补几个
// 纯读查询：fact snapshot cells 读回、fence 扫描、prepared-effect 扫描、
// executionRef 反查、wake hint 去重、mission epoch 对拍。全部只读、无业务分支——
// 留在 infrastructure，经装配点注入。

import { eq, inArray, isNull, ne } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  developmentActionRuns,
  developmentAgentAttempts,
  developmentEffects,
  developmentFactSnapshots,
  developmentMissions,
  developmentWakeHints,
} from '@/db/schema'
import type { FactSnapshotReader } from '../application/ports/reconcilerPorts'
import type { FactCell } from '../domain/factCell'
import type { FactCellValue } from '../domain/facts'

export function createFactSnapshotReader(db: ProviderNeutralDatabase): FactSnapshotReader {
  return {
    async getCells(snapshotId) {
      const row = (
        await db
          .select({ cellsJson: developmentFactSnapshots.cellsJson })
          .from(developmentFactSnapshots)
          .where(eq(developmentFactSnapshots.id, snapshotId))
          .limit(1)
      )[0]
      if (row === undefined) return null
      return JSON.parse(row.cellsJson) as Record<string, FactCell<FactCellValue>>
    },
  }
}

/** transition_fence ≠ none 的 mission id（启动恢复扫描）。 */
export async function listFencedMissionIds(db: ProviderNeutralDatabase): Promise<string[]> {
  return (
    await db
      .select({ id: developmentMissions.id })
      .from(developmentMissions)
      .where(ne(developmentMissions.transitionFence, 'none'))
  ).map((row) => row.id)
}

/** 仍有 prepared effect 的 mission id 及其行（epoch 过期失效扫描）。 */
export async function listPreparedEffectRows(
  db: ProviderNeutralDatabase,
): Promise<{ readonly id: string; readonly missionId: string; readonly epoch: number }[]> {
  return await db
    .select({
      id: developmentEffects.id,
      missionId: developmentEffects.missionId,
      epoch: developmentEffects.epoch,
    })
    .from(developmentEffects)
    .where(eq(developmentEffects.state, 'prepared'))
}

/** PR-4 —— agent execution 终态回调的反查：executionRef → missionId。 */
export async function missionIdOfExecutionRef(
  db: ProviderNeutralDatabase,
  executionRef: string,
): Promise<string | null> {
  const row = (
    await db
      .select({ missionId: developmentActionRuns.missionId })
      .from(developmentAgentAttempts)
      .innerJoin(
        developmentActionRuns,
        eq(developmentAgentAttempts.actionRunId, developmentActionRuns.id),
      )
      .where(eq(developmentAgentAttempts.executionRef, executionRef))
      .limit(1)
  )[0]
  return row?.missionId ?? null
}

/** wake sweep 读侧：有未消费 wake hint 的 mission id（去重）。 */
export async function listUnconsumedWakeHintMissionIds(
  db: ProviderNeutralDatabase,
): Promise<string[]> {
  const rows = await db
    .select({ missionId: developmentWakeHints.missionId })
    .from(developmentWakeHints)
    .where(isNull(developmentWakeHints.consumedAt))
  return [...new Set(rows.map((row) => row.missionId))]
}

/** 给定 mission 集合的当前 epoch（recovery 对拍 effect.epoch 用）。 */
export async function missionEpochsOf(
  db: ProviderNeutralDatabase,
  missionIds: readonly string[],
): Promise<Map<string, number>> {
  if (missionIds.length === 0) return new Map()
  const rows = await db
    .select({ id: developmentMissions.id, epoch: developmentMissions.epoch })
    .from(developmentMissions)
    .where(inArray(developmentMissions.id, [...missionIds]))
  return new Map(rows.map((row) => [row.id, row.epoch]))
}
