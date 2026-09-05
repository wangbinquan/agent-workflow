// RFC-359 W4-D7a —— Digital Employee OS 单写者 cutover 的 writer state / 旧 Mission 排空投影聚合：一份实现，
// 两个 provider 共用。
//
// activate / refresh 是读—改—写：先 lockAggregateRoot 锁住 'global' 单例行（PG 渲染 FOR UPDATE，SQLite 独占事务下
// no-op），再数未终态的旧 Mission、翻 mode 并写回，都在统一事务原语的一笔事务里。migrationSnapshot 是纯读投影，
// 不开写事务——旧 SQLite 实现刻意用 deferred 事务而不是 BEGIN IMMEDIATE，就是不让一次快照读去抢 writer；READ
// COMMITTED 的 PG 事务对多条 select 也不提供更强的一致性，两边都是逐语句快照，语义一致。

import { and, asc, count, eq, inArray, isNull, notInArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  developmentApprovalSagas,
  developmentMissionLinks,
  developmentMissions,
  developmentMrClaims,
  employeeOsWriterState,
} from '@/db/schema'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
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

async function readWriter(handle: ProviderNeutralDatabase): Promise<DigitalEmployeeWriterState> {
  const row = (
    await handle
      .select()
      .from(employeeOsWriterState)
      .where(eq(employeeOsWriterState.id, 'global'))
      .limit(1)
  )[0]
  return writerState(row)
}

async function countOpenLegacyMissions(handle: ProviderNeutralDatabase): Promise<number> {
  const row = (
    await handle
      .select({ value: count() })
      .from(developmentMissions)
      .where(isNull(developmentMissions.terminalAt))
  )[0]
  return row?.value ?? 0
}

export function createDigitalEmployeeWriterCutoverPersistence(
  db: ProviderNeutralDatabase,
): DigitalEmployeeWriterCutoverPersistence {
  const session = databaseSessionFor(db)
  const lockWriter = (tx: DatabaseTransaction) =>
    session.engine.lockAggregateRoot(tx, employeeOsWriterState, employeeOsWriterState.id, 'global')
  return {
    read: () => readWriter(db),
    async activate(input) {
      return await session.transaction(async (tx) => {
        await lockWriter(tx)
        const current = await readWriter(tx)
        const legacyOpenMissionCount = await countOpenLegacyMissions(tx)
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
        return next
      })
    },
    async refresh(now) {
      return await session.transaction(async (tx) => {
        await lockWriter(tx)
        const current = await readWriter(tx)
        const legacyOpenMissionCount = await countOpenLegacyMissions(tx)
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
        return next
      })
    },
    async migrationSnapshot(limit) {
      const writer = await readWriter(db)
      const sampled = await db
        .select({ id: developmentMissions.id, status: developmentMissions.status })
        .from(developmentMissions)
        .where(isNull(developmentMissions.terminalAt))
        .orderBy(asc(developmentMissions.createdAt), asc(developmentMissions.id))
        .limit(limit + 1)
      const missionIds = sampled.slice(0, limit).map((mission) => mission.id)
      const activeMrClaims =
        missionIds.length === 0
          ? []
          : await db
              .select({ missionId: developmentMrClaims.missionId, value: count() })
              .from(developmentMrClaims)
              .where(
                and(
                  eq(developmentMrClaims.state, 'active'),
                  inArray(developmentMrClaims.missionId, missionIds),
                ),
              )
              .groupBy(developmentMrClaims.missionId)
      const childLinks =
        missionIds.length === 0
          ? []
          : await db
              .select({ missionId: developmentMissionLinks.parentMissionId, value: count() })
              .from(developmentMissionLinks)
              .where(inArray(developmentMissionLinks.parentMissionId, missionIds))
              .groupBy(developmentMissionLinks.parentMissionId)
      const approvals =
        missionIds.length === 0
          ? []
          : await db
              .select({ missionId: developmentApprovalSagas.missionId, value: count() })
              .from(developmentApprovalSagas)
              .where(
                and(
                  inArray(developmentApprovalSagas.missionId, missionIds),
                  notInArray(developmentApprovalSagas.latestStatus, SETTLED_APPROVAL_STATUSES),
                ),
              )
              .groupBy(developmentApprovalSagas.missionId)
      return {
        writer,
        drain: reportFrom(sampled, limit, activeMrClaims, childLinks, approvals),
      }
    },
  }
}
