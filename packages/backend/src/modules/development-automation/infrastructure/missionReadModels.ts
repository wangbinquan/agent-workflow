// RFC-310 PR-2 T31 —— Mission read models（列表/详情/决策 trace）。
//
// 只读投影：列表回摘要（design §1.4 DevelopmentMissionSummary 的 PR-2 子集），
// 详情附 source/upload/decision 摘要，trace 回 canonical guard/rule trace。
// 不返回 host path/nonce/secret/raw 正文（§12.4）。

import { desc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  developmentDecisions,
  developmentEffects,
  developmentMissions,
  developmentMissionSources,
} from '@/db/schema'

export interface MissionSummaryView {
  id: string
  revision: number
  status: string
  automationMode: string
  transitionFence: string
  repositoryId: string
  sourceKind: string
  externalId: string | null
  resolvedSourceKey: string | null
  deliveryKind: string
  employeeId: string | null
  employeeRevision: number | null
  policyId: string | null
  policyRevision: number | null
  blockCode: string | null
  terminalKind: string | null
  createdAt: number
  updatedAt: number
}

function summaryOf(row: typeof developmentMissions.$inferSelect): MissionSummaryView {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    automationMode: row.automationMode,
    transitionFence: row.transitionFence,
    repositoryId: row.repositoryId,
    sourceKind: row.sourceKind,
    externalId: row.externalId,
    resolvedSourceKey: row.resolvedSourceKey,
    deliveryKind: row.deliveryKind,
    employeeId: row.employeeId,
    employeeRevision: row.employeeRevision,
    policyId: row.policyId,
    policyRevision: row.policyRevision,
    blockCode: row.blockCode,
    terminalKind: row.terminalKind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listMissionSummaries(db: DbClient): MissionSummaryView[] {
  return db
    .select()
    .from(developmentMissions)
    .orderBy(desc(developmentMissions.createdAt))
    .all()
    .map(summaryOf)
}

export function getMissionDetail(
  db: DbClient,
  id: string,
):
  | (MissionSummaryView & { sources: unknown[]; readiness: unknown; blockDetail: string | null })
  | null {
  const row = db.select().from(developmentMissions).where(eq(developmentMissions.id, id)).get()
  if (row === undefined) return null
  const sources = db
    .select()
    .from(developmentMissionSources)
    .where(eq(developmentMissionSources.missionId, id))
    .all()
    .map((s) => ({
      generation: s.generation,
      sourceKind: s.sourceKind,
      externalId: s.externalId,
      adapterId: s.adapterId,
      adapterRevision: s.adapterRevision,
      sourceRevision: s.sourceRevision,
      bundleRef: s.bundleRef,
      manifestDigest: s.manifestDigest,
      state: s.state,
    }))
  return {
    ...summaryOf(row),
    sources,
    readiness: row.readinessJson === null ? null : (JSON.parse(row.readinessJson) as unknown),
    blockDetail: row.blockDetail,
  }
}

/** PR-5 T61 —— effect 台账投影（outbox 状态可见；intent digest 只作指纹）。 */
export function listMissionEffects(db: DbClient, missionId: string): unknown[] {
  return db
    .select()
    .from(developmentEffects)
    .where(eq(developmentEffects.missionId, missionId))
    .orderBy(desc(developmentEffects.createdAt))
    .all()
    .map((e) => ({
      id: e.id,
      effectKind: e.effectKind,
      state: e.state,
      intentDigest: e.intentDigest,
      epoch: e.epoch,
      createdAt: e.createdAt,
      settledAt: e.settledAt,
    }))
}

export function getDecisionTrace(db: DbClient, missionId: string): unknown[] {
  return db
    .select()
    .from(developmentDecisions)
    .where(eq(developmentDecisions.missionId, missionId))
    .orderBy(desc(developmentDecisions.decidedAt))
    .all()
    .map((d) => ({
      id: d.id,
      missionRevision: d.missionRevision,
      policyId: d.policyId,
      policyRevision: d.policyRevision,
      employeeId: d.employeeId,
      employeeRevision: d.employeeRevision,
      factDigest: d.factDigest,
      guardTrace: JSON.parse(d.guardTraceJson) as unknown,
      ruleTrace: JSON.parse(d.ruleTraceJson) as unknown,
      selected: JSON.parse(d.selectedJson) as unknown,
      canonicalDigest: d.canonicalDigest,
      decidedAt: d.decidedAt,
    }))
}
