// RFC-317 T41（findings DE-01）—— 旧 Mission 排空视图的**实现**。
//
// 端口声明在 digital-employee（消费方拥有合同），实现落在这里（development-automation
// 拥有那四张表）。此前这段查询整段住在
// `modules/digital-employee/composition/writerCutover.ts` 里：通用 OS 直接 import
// `developmentMissions` / `developmentMrClaims` / `developmentMissionLinks` /
// `developmentApprovalSagas`，还抄了一份「已了结的审批状态」字面量。
//
// 为什么那样不行（RFC-294 proposal §「不能以复用方便为由共享 Drizzle table」）：
//   · 通用 OS 离开 development 的 schema 就装配 / 迁移不起来；
//   · development 改一个列名或加一个审批终态，会**静默**改坏 digital-employee 的查询
//     ——两边都 typecheck 通过，因为它们看的是同一个 `@/db/schema` 命名空间；
//   · 任何基于 import 边的架构守卫都看不见这种耦合（表是从全局 schema 取的，
//     不是从另一个 module 的 public 面取的）。

import { and, asc, count, eq, inArray, isNull, notInArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  developmentApprovalSagas,
  developmentMissionLinks,
  developmentMissions,
  developmentMrClaims,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

/**
 * 审批 saga 的**已了结**状态。这份词表属于 development-automation——它此前被抄在
 * digital-employee 里，加一个终态就要记得改两处，而漏改的那处不会红。
 */
const SETTLED_APPROVAL_STATUSES = ['approved', 'rejected', 'expired', 'unavailable']

/**
 * 一条待排空的旧 Mission 在迁移报告里的样子。
 *
 * ⚠️ **刻意不 import digital-employee 的端口类型**。那个端口住在
 * `digital-employee/composition/required-ports.ts`——RFC-294 的跨界判据只对
 * `application/adapters/*-adapter` 开放该文件，而本实现要直接跑 Drizzle 查询、
 * 进不了 application 层（该层禁 `drizzle-orm`）；把端口挪到 `public/types.ts` 也不行，
 * 它的 `openMissionCount` 收事务读句柄，任何 DB 句柄类型都会触发 public 面的 taint 判据。
 *
 * 于是采用本仓既有的跨界实现形态：**结构化声明、装配点校验**。
 * `cli/start.ts` 把它传给 `activateDigitalEmployeeOsWriter` / `composeDigitalEmployee`
 * 时，TypeScript 会逐字段比对——形状一旦漂移，bootstrap 立刻编译失败。
 * （`composeDevelopmentEmployeeWorkspace` / `composeDevelopmentEmployeePlatformWorkItems`
 * 也都是这个形态，无一 import 端口类型。）
 */
export interface LegacyMissionDrainEntry {
  readonly missionId: string
  readonly status: string
  readonly activeMrClaimCount: number
  readonly childLinkCount: number
  readonly pendingApprovalCount: number
}

export interface LegacyMissionDrainReport {
  readonly truncated: boolean
  readonly entries: ReadonlyArray<LegacyMissionDrainEntry>
}

export interface LegacyMissionDrainPort {
  openMissionCount(): Promise<number>
  drainReport(limit: number): Promise<LegacyMissionDrainReport>
}

function reportFrom(
  sampled: readonly { readonly id: string; readonly status: string }[],
  limit: number,
  activeMrClaims: readonly { readonly missionId: string; readonly value: number }[],
  childLinks: readonly { readonly missionId: string; readonly value: number }[],
  approvals: readonly { readonly missionId: string; readonly value: number }[],
): LegacyMissionDrainReport {
  const counts = (rows: readonly { readonly missionId: string; readonly value: number }[]) =>
    new Map(rows.map((row) => [row.missionId, row.value]))
  const mrClaimCounts = counts(activeMrClaims)
  const childLinkCounts = counts(childLinks)
  const pendingApprovalCounts = counts(approvals)
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

export function createSqliteLegacyMissionDrainPort(db: DbClient): LegacyMissionDrainPort {
  return {
    async openMissionCount() {
      return (
        db
          .select({ value: count() })
          .from(developmentMissions)
          .where(isNull(developmentMissions.terminalAt))
          .get()?.value ?? 0
      )
    },

    async drainReport(limit) {
      // 多取一条用来判断「是否被截断」——报告必须如实说自己不完整，
      // 否则 `draining` 列表看起来就是全部，运维会以为排空快结束了。
      const sampled = db
        .select({ id: developmentMissions.id, status: developmentMissions.status })
        .from(developmentMissions)
        .where(isNull(developmentMissions.terminalAt))
        .orderBy(asc(developmentMissions.createdAt), asc(developmentMissions.id))
        .limit(limit + 1)
        .all()
      const openMissions = sampled.slice(0, limit)
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
      return reportFrom(sampled, limit, activeMrClaims, childLinks, approvals)
    },
  }
}

export function createPostgresqlLegacyMissionDrainPort(
  db: PostgresqlDatabaseClient,
): LegacyMissionDrainPort {
  return {
    async openMissionCount() {
      const row = await db
        .select({ value: count() })
        .from(developmentMissions)
        .where(isNull(developmentMissions.terminalAt))
        .limit(1)
        .get()
      return row?.value ?? 0
    },

    async drainReport(limit) {
      const sampled = await db
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
              .all()
      const childLinks =
        missionIds.length === 0
          ? []
          : await db
              .select({ missionId: developmentMissionLinks.parentMissionId, value: count() })
              .from(developmentMissionLinks)
              .where(inArray(developmentMissionLinks.parentMissionId, missionIds))
              .groupBy(developmentMissionLinks.parentMissionId)
              .all()
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
              .all()
      return reportFrom(sampled, limit, activeMrClaims, childLinks, approvals)
    },
  }
}
