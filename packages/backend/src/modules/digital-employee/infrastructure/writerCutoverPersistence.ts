// RFC-349 — provider-private atomic aggregate for the DE writer cutover.

import { and, asc, count, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  developmentApprovalSagas,
  developmentMissionLinks,
  developmentMissions,
  developmentMrClaims,
  employeeOsWriterState,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  DigitalEmployeeWriterCutoverPersistence,
  DigitalEmployeeWriterState,
  LegacyMissionDrainReport,
} from '../application/ports/writerCutoverPersistence'

const SETTLED_APPROVAL_STATUSES = ['approved', 'rejected', 'expired', 'unavailable']

function writerState(
  row: typeof employeeOsWriterState.$inferSelect | undefined,
): DigitalEmployeeWriterState {
  if (row === undefined) throw new Error('digital employee writer state is not initialized')
  return {
    activeGeneration: row.activeGeneration,
    mode: row.mode,
    legacyAdmissionsEnabled: row.legacyAdmissionsEnabled,
    legacyOpenMissionCount: row.legacyOpenMissionCount,
    updatedAt: row.updatedAt,
  }
}

function reportFrom(
  sampled: readonly { readonly id: string; readonly status: string }[],
  limit: number,
  activeMrClaims: readonly { readonly missionId: string; readonly value: number }[],
  childLinks: readonly { readonly missionId: string; readonly value: number }[],
  approvals: readonly { readonly missionId: string; readonly value: number }[],
): LegacyMissionDrainReport {
  const countMap = (rows: readonly { readonly missionId: string; readonly value: number }[]) =>
    new Map(rows.map((row) => [row.missionId, row.value]))
  const mrClaimCounts = countMap(activeMrClaims)
  const childLinkCounts = countMap(childLinks)
  const pendingApprovalCounts = countMap(approvals)
  return {
    truncated: sampled.length > limit,
    entries: sampled.slice(0, limit).map((mission) => ({
      missionId: mission.id,
      status: mission.status,
      activeMrClaimCount: mrClaimCounts.get(mission.id) ?? 0,
      childLinkCount: childLinkCounts.get(mission.id) ?? 0,
      pendingApprovalCount: pendingApprovalCounts.get(mission.id) ?? 0,
    })),
  }
}

export function createSqliteDigitalEmployeeWriterCutoverPersistence(
  db: DbClient,
): DigitalEmployeeWriterCutoverPersistence {
  return {
    async read() {
      return writerState(
        db.select().from(employeeOsWriterState).where(eq(employeeOsWriterState.id, 'global')).get(),
      )
    },
    async activate(input) {
      return dbTxSync(db, (tx) => {
        const current = writerState(
          tx
            .select()
            .from(employeeOsWriterState)
            .where(eq(employeeOsWriterState.id, 'global'))
            .get(),
        )
        const legacyOpenMissionCount =
          tx
            .select({ value: count() })
            .from(developmentMissions)
            .where(isNull(developmentMissions.terminalAt))
            .get()?.value ?? 0
        const next: DigitalEmployeeWriterState = {
          activeGeneration: Math.max(1, current.activeGeneration),
          mode: legacyOpenMissionCount > 0 ? 'legacy-draining' : 'os-active',
          legacyAdmissionsEnabled: input.legacyAdmissionsEnabled,
          legacyOpenMissionCount,
          updatedAt: input.now,
        }
        tx.update(employeeOsWriterState)
          .set(next)
          .where(eq(employeeOsWriterState.id, 'global'))
          .run()
        return next
      })
    },
    async refresh(now) {
      return dbTxSync(db, (tx) => {
        const current = writerState(
          tx
            .select()
            .from(employeeOsWriterState)
            .where(eq(employeeOsWriterState.id, 'global'))
            .get(),
        )
        const legacyOpenMissionCount =
          tx
            .select({ value: count() })
            .from(developmentMissions)
            .where(isNull(developmentMissions.terminalAt))
            .get()?.value ?? 0
        const next: DigitalEmployeeWriterState = {
          ...current,
          mode: legacyOpenMissionCount > 0 ? 'legacy-draining' : 'os-active',
          legacyOpenMissionCount,
          updatedAt: now,
        }
        tx.update(employeeOsWriterState)
          .set({
            mode: next.mode,
            legacyOpenMissionCount,
            updatedAt: now,
          })
          .where(eq(employeeOsWriterState.id, 'global'))
          .run()
        return next
      })
    },
    async migrationSnapshot(limit) {
      return db.transaction((tx) => {
        const writer = writerState(
          tx
            .select()
            .from(employeeOsWriterState)
            .where(eq(employeeOsWriterState.id, 'global'))
            .get(),
        )
        const sampled = tx
          .select({ id: developmentMissions.id, status: developmentMissions.status })
          .from(developmentMissions)
          .where(isNull(developmentMissions.terminalAt))
          .orderBy(asc(developmentMissions.createdAt), asc(developmentMissions.id))
          .limit(limit + 1)
          .all()
        const missionIds = sampled.slice(0, limit).map((mission) => mission.id)
        const activeMrClaims =
          missionIds.length === 0
            ? []
            : tx
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
            : tx
                .select({ missionId: developmentMissionLinks.parentMissionId, value: count() })
                .from(developmentMissionLinks)
                .where(inArray(developmentMissionLinks.parentMissionId, missionIds))
                .groupBy(developmentMissionLinks.parentMissionId)
                .all()
        const approvals =
          missionIds.length === 0
            ? []
            : tx
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
        return {
          writer,
          drain: reportFrom(sampled, limit, activeMrClaims, childLinks, approvals),
        }
      })
    },
  }
}

export function createPostgresqlDigitalEmployeeWriterCutoverPersistence(
  db: PostgresqlDatabaseClient,
): DigitalEmployeeWriterCutoverPersistence {
  return {
    async read() {
      const row = await db
        .select()
        .from(employeeOsWriterState)
        .where(eq(employeeOsWriterState.id, 'global'))
        .limit(1)
        .get()
      return writerState(row)
    },
    async activate(input) {
      return await db.transaction(async (tx) => {
        await tx.run(sql`
          SELECT ${employeeOsWriterState.id}
          FROM ${employeeOsWriterState}
          WHERE ${employeeOsWriterState.id} = 'global'
          FOR UPDATE
        `)
        const current = writerState(
          await tx
            .select()
            .from(employeeOsWriterState)
            .where(eq(employeeOsWriterState.id, 'global'))
            .limit(1)
            .get(),
        )
        const countRow = await tx
          .select({ value: count() })
          .from(developmentMissions)
          .where(isNull(developmentMissions.terminalAt))
          .limit(1)
          .get()
        const legacyOpenMissionCount = countRow?.value ?? 0
        const next: DigitalEmployeeWriterState = {
          activeGeneration: Math.max(1, current.activeGeneration),
          mode: legacyOpenMissionCount > 0 ? 'legacy-draining' : 'os-active',
          legacyAdmissionsEnabled: input.legacyAdmissionsEnabled,
          legacyOpenMissionCount,
          updatedAt: input.now,
        }
        await tx
          .update(employeeOsWriterState)
          .set(next)
          .where(eq(employeeOsWriterState.id, 'global'))
          .run()
        return next
      })
    },
    async refresh(now) {
      return await db.transaction(async (tx) => {
        await tx.run(sql`
          SELECT ${employeeOsWriterState.id}
          FROM ${employeeOsWriterState}
          WHERE ${employeeOsWriterState.id} = 'global'
          FOR UPDATE
        `)
        const current = writerState(
          await tx
            .select()
            .from(employeeOsWriterState)
            .where(eq(employeeOsWriterState.id, 'global'))
            .limit(1)
            .get(),
        )
        const countRow = await tx
          .select({ value: count() })
          .from(developmentMissions)
          .where(isNull(developmentMissions.terminalAt))
          .limit(1)
          .get()
        const legacyOpenMissionCount = countRow?.value ?? 0
        const next: DigitalEmployeeWriterState = {
          ...current,
          mode: legacyOpenMissionCount > 0 ? 'legacy-draining' : 'os-active',
          legacyOpenMissionCount,
          updatedAt: now,
        }
        await tx
          .update(employeeOsWriterState)
          .set({ mode: next.mode, legacyOpenMissionCount, updatedAt: now })
          .where(eq(employeeOsWriterState.id, 'global'))
          .run()
        return next
      })
    },
    async migrationSnapshot(limit) {
      return await db.transaction(async (tx) => {
        const writer = writerState(
          await tx
            .select()
            .from(employeeOsWriterState)
            .where(eq(employeeOsWriterState.id, 'global'))
            .limit(1)
            .get(),
        )
        const sampled = await tx
          .select({ id: developmentMissions.id, status: developmentMissions.status })
          .from(developmentMissions)
          .where(isNull(developmentMissions.terminalAt))
          .orderBy(asc(developmentMissions.createdAt), asc(developmentMissions.id))
          .limit(limit + 1)
          .all()
        const missionIds = sampled.slice(0, limit).map((mission) => mission.id)
        const activeMrClaims =
          missionIds.length === 0
            ? []
            : await tx
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
            : await tx
                .select({ missionId: developmentMissionLinks.parentMissionId, value: count() })
                .from(developmentMissionLinks)
                .where(inArray(developmentMissionLinks.parentMissionId, missionIds))
                .groupBy(developmentMissionLinks.parentMissionId)
                .all()
        const approvals =
          missionIds.length === 0
            ? []
            : await tx
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
        return {
          writer,
          drain: reportFrom(sampled, limit, activeMrClaims, childLinks, approvals),
        }
      })
    },
  }
}
