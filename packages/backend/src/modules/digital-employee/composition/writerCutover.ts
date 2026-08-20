import { and, asc, count, eq, inArray, isNull, notInArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  developmentApprovalSagas,
  developmentMissionLinks,
  developmentMissions,
  developmentMrClaims,
  employeeOsWriterState,
} from '@/db/schema'

export interface DigitalEmployeeWriterState {
  readonly activeGeneration: number
  readonly mode: 'pre-cutover' | 'legacy-draining' | 'os-active'
  readonly legacyAdmissionsEnabled: boolean
  readonly legacyOpenMissionCount: number
  readonly updatedAt: number
}

const MIGRATION_REPORT_LIMIT = 100
const SETTLED_APPROVAL_STATUSES = ['approved', 'rejected', 'expired', 'unavailable']

function countOpenLegacyMissions(db: Pick<DbClient, 'select'>): number {
  return (
    db
      .select({ value: count() })
      .from(developmentMissions)
      .where(isNull(developmentMissions.terminalAt))
      .get()?.value ?? 0
  )
}

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
    const legacyOpenMissionCount = countOpenLegacyMissions(tx)
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
  now = Date.now(),
): DigitalEmployeeWriterState {
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(employeeOsWriterState)
      .where(eq(employeeOsWriterState.id, 'global'))
      .get()
    if (current === undefined) throw new Error('digital employee writer state is not initialized')
    const legacyOpenMissionCount = countOpenLegacyMissions(tx)
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

export function analyzeDigitalEmployeeMigration(db: DbClient) {
  const sampledOpenMissions = db
    .select({ id: developmentMissions.id, status: developmentMissions.status })
    .from(developmentMissions)
    .where(isNull(developmentMissions.terminalAt))
    .orderBy(asc(developmentMissions.createdAt), asc(developmentMissions.id))
    .limit(MIGRATION_REPORT_LIMIT + 1)
    .all()
  const openMissions = sampledOpenMissions.slice(0, MIGRATION_REPORT_LIMIT)
  const missionIds = openMissions.map((mission) => mission.id)
  const activeMrClaims =
    missionIds.length === 0
      ? []
      : db
          .select({ missionId: developmentMrClaims.missionId, value: count() })
          .from(developmentMrClaims)
          .where(
            and(
              eq(developmentMrClaims.state, 'active'),
              inArray(developmentMrClaims.missionId, missionIds),
            ),
          )
          .groupBy(developmentMrClaims.missionId)
          .all()
  const childLinks =
    missionIds.length === 0
      ? []
      : db
          .select({ missionId: developmentMissionLinks.parentMissionId, value: count() })
          .from(developmentMissionLinks)
          .where(inArray(developmentMissionLinks.parentMissionId, missionIds))
          .groupBy(developmentMissionLinks.parentMissionId)
          .all()
  const approvals =
    missionIds.length === 0
      ? []
      : db
          .select({ missionId: developmentApprovalSagas.missionId, value: count() })
          .from(developmentApprovalSagas)
          .where(
            and(
              inArray(developmentApprovalSagas.missionId, missionIds),
              notInArray(developmentApprovalSagas.latestStatus, SETTLED_APPROVAL_STATUSES),
            ),
          )
          .groupBy(developmentApprovalSagas.missionId)
          .all()
  const counts = (rows: readonly { readonly missionId: string; readonly value: number }[]) =>
    new Map(rows.map((row) => [row.missionId, row.value]))
  const mrClaimCounts = counts(activeMrClaims)
  const childLinkCounts = counts(childLinks)
  const pendingApprovalCounts = counts(approvals)
  const writer = readDigitalEmployeeWriterState(db)
  return {
    schemaVersion: 1 as const,
    writer,
    mechanicallyAdoptable: [] as const,
    drainingTotal: writer.legacyOpenMissionCount,
    drainingTruncated: sampledOpenMissions.length > MIGRATION_REPORT_LIMIT,
    draining: openMissions.map((mission) => ({
      missionId: mission.id,
      status: mission.status,
      activeMrClaimCount: mrClaimCounts.get(mission.id) ?? 0,
      childLinkCount: childLinkCounts.get(mission.id) ?? 0,
      pendingApprovalCount: pendingApprovalCounts.get(mission.id) ?? 0,
    })),
    blockedReason:
      openMissions.length === 0
        ? null
        : 'active legacy Missions retain their existing writer claims until terminal; they are never concurrently adopted by the OS',
  }
}
