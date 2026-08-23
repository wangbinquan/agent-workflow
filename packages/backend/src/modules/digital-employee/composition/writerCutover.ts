// RFC-317 T41（DE-01）—— 本文件此前直接 import development-automation 的四张表
// （developmentMissions / MrClaims / MissionLinks / ApprovalSagas）并抄了一份
// 「已了结审批状态」词表。那是 RFC-294 明令禁止的「共享 Drizzle table」形态：通用 OS
// 离开 development 的 schema 就装配不起来，且 development 改一列会静默改坏这里。
// 现在只经 `LegacyMissionDrainPort` 拿排空视图，实现落在
// `modules/development-automation/composition/legacyMissionDrain.ts`。

import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { employeeOsWriterState } from '@/db/schema'
import type { LegacyMissionDrainPort } from './required-ports'

export interface DigitalEmployeeWriterState {
  readonly activeGeneration: number
  readonly mode: 'pre-cutover' | 'legacy-draining' | 'os-active'
  readonly legacyAdmissionsEnabled: boolean
  readonly legacyOpenMissionCount: number
  readonly updatedAt: number
}

const MIGRATION_REPORT_LIMIT = 100

function stateOf(row: typeof employeeOsWriterState.$inferSelect): DigitalEmployeeWriterState {
  return {
    activeGeneration: row.activeGeneration,
    mode: row.mode,
    legacyAdmissionsEnabled: row.legacyAdmissionsEnabled,
    legacyOpenMissionCount: row.legacyOpenMissionCount,
    updatedAt: row.updatedAt,
  }
}

export function readDigitalEmployeeWriterState(db: DbClient): DigitalEmployeeWriterState {
  const row = db
    .select()
    .from(employeeOsWriterState)
    .where(eq(employeeOsWriterState.id, 'global'))
    .get()
  if (row === undefined) throw new Error('digital employee writer state is not initialized')
  return stateOf(row)
}

/**
 * Boot-time single-writer flip. New legacy admissions are frozen first. Existing
 * non-terminal Missions are allowed to drain under their old claims; the OS
 * never adopts those subjects concurrently. Once the count reaches zero, the
 * legacy reconciler is no longer scheduled.
 */
export function activateDigitalEmployeeOsWriter(
  db: DbClient,
  drain: LegacyMissionDrainPort,
  now = Date.now(),
  options: { readonly legacyAdmissionsEnabled?: boolean } = {},
): DigitalEmployeeWriterState {
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(employeeOsWriterState)
      .where(eq(employeeOsWriterState.id, 'global'))
      .get()
    if (current === undefined) throw new Error('digital employee writer state is not initialized')
    const legacyOpenMissionCount = drain.openMissionCount(tx)
    const legacyAdmissionsEnabled = options.legacyAdmissionsEnabled ?? false
    const mode = legacyOpenMissionCount > 0 ? 'legacy-draining' : 'os-active'
    const activeGeneration = Math.max(1, current.activeGeneration)
    tx.update(employeeOsWriterState)
      .set({
        activeGeneration,
        mode,
        legacyAdmissionsEnabled,
        legacyOpenMissionCount,
        updatedAt: now,
      })
      .where(eq(employeeOsWriterState.id, 'global'))
      .run()
    return {
      activeGeneration,
      mode,
      legacyAdmissionsEnabled,
      legacyOpenMissionCount,
      updatedAt: now,
    }
  })
}

/** Recounts the drain set without reopening legacy admission. */
export function refreshDigitalEmployeeWriterState(
  db: DbClient,
  drain: LegacyMissionDrainPort,
  now = Date.now(),
): DigitalEmployeeWriterState {
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(employeeOsWriterState)
      .where(eq(employeeOsWriterState.id, 'global'))
      .get()
    if (current === undefined) throw new Error('digital employee writer state is not initialized')
    const legacyOpenMissionCount = drain.openMissionCount(tx)
    const mode = legacyOpenMissionCount > 0 ? 'legacy-draining' : 'os-active'
    tx.update(employeeOsWriterState)
      .set({ mode, legacyOpenMissionCount, updatedAt: now })
      .where(eq(employeeOsWriterState.id, 'global'))
      .run()
    return {
      activeGeneration: current.activeGeneration,
      mode,
      legacyAdmissionsEnabled: current.legacyAdmissionsEnabled,
      legacyOpenMissionCount,
      updatedAt: now,
    }
  })
}

export function analyzeDigitalEmployeeMigration(db: DbClient, drain: LegacyMissionDrainPort) {
  const report = drain.drainReport(MIGRATION_REPORT_LIMIT)
  const writer = readDigitalEmployeeWriterState(db)
  return {
    schemaVersion: 1 as const,
    writer,
    mechanicallyAdoptable: [] as const,
    drainingTotal: writer.legacyOpenMissionCount,
    drainingTruncated: report.truncated,
    draining: report.entries,
    blockedReason:
      report.entries.length === 0
        ? null
        : 'active legacy Missions retain their existing writer claims until terminal; they are never concurrently adopted by the OS',
  }
}
