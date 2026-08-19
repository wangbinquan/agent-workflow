// RFC-310 PR-2 T31 —— Mission read models（列表/详情/决策 trace）。
//
// 只读投影：列表回摘要（design §1.4 DevelopmentMissionSummary 的 PR-2 子集），
// 详情附 source/upload/decision 摘要，trace 回 canonical guard/rule trace。
// 不返回 host path/nonce/secret/raw 正文（§12.4）。

import { desc, eq, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  cachedRepos,
  developmentDecisions,
  developmentEffects,
  developmentMissionSources,
  developmentMissions,
  developmentMrClaims,
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

/** 分页游标:与 /repos、/tasks 同款——**行值比较**的 keyset,不是 offset。 */
export interface MissionPageCursor {
  createdAt: number
  id: string
}

export interface MissionPage {
  items: MissionSummaryView[]
  nextCursor: MissionPageCursor | null
}

/**
 * RFC-311(自 RFC-310 移交)—— mission 列表的 O(页) 读法。
 *
 * 原实现是全表 `.all()`:mission 表长起来会复刻 `/tasks` 在十万任务下的卡顿形态
 * （一次取回全部行 + 全部投影），而这条路径跑在 daemon 唯一的同步连接上。
 *
 * 排序键 `(created_at DESC, id DESC)`;断点写成**行值比较** `(a, id) < (?, ?)`——
 * 展开成 `a < ? OR (a = ? AND id < ?)` 会让 SQLite 在绑定参数下选 MULTI-INDEX OR
 * 并回落 TEMP B-TREE 全排序（RFC-311 在 10 万任务库上实测过这一条,判据见
 * `docs/dev-gotchas.md`）。
 */
export function listMissionSummariesPage(
  db: DbClient,
  opts: { limit: number; cursor?: MissionPageCursor },
): MissionPage {
  const boundary =
    opts.cursor === undefined
      ? sql`1 = 1`
      : sql`(${developmentMissions.createdAt}, ${developmentMissions.id}) < (${opts.cursor.createdAt}, ${opts.cursor.id})`
  const rows = db
    .select()
    .from(developmentMissions)
    .where(boundary)
    .orderBy(desc(developmentMissions.createdAt), desc(developmentMissions.id))
    .limit(opts.limit + 1)
    .all()
  const hasMore = rows.length > opts.limit
  const page = hasMore ? rows.slice(0, opts.limit) : rows
  const last = page[page.length - 1]
  return {
    items: page.map(summaryOf),
    nextCursor: hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
  }
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

/**
 * RFC-310 PR-13 —— MR 链接拼装（纯函数，无 IO）。
 *
 * 平台只知道仓库地址与 MR iid：GitHub 走 `/pull/<iid>`，其余（GitLab 形态）走
 * `/-/merge_requests/<iid>`。非 http(s) 的地址（ssh / 本地 bare 仓 / 空）一律返回
 * `null`，由调用方呈现"链接不可用"，绝不拼出一个打不开的地址冒充可用。
 */
export function mergeRequestHref(input: {
  repositoryUrl: string | null
  endpointRef: string
  mrIid: string
}): string | null {
  if (input.repositoryUrl === null || !/^https?:\/\//i.test(input.repositoryUrl)) return null
  const base = input.repositoryUrl.replace(/\.git(?:[?#].*)?$/, '').replace(/\/$/, '')
  const github =
    input.endpointRef.toLowerCase().includes('github') ||
    (() => {
      try {
        return new URL(base).hostname.toLowerCase().includes('github')
      } catch {
        return false
      }
    })()
  return github ? `${base}/pull/${input.mrIid}` : `${base}/-/merge_requests/${input.mrIid}`
}

/** RFC-310 PR-13 —— Mission 详情的 MR 投影（iid / 外部状态 / 可打开的链接）。 */
export interface MissionMergeRequestView {
  iid: string
  state: string
  href: string | null
}

/**
 * RFC-310 PR-13 —— Mission 详情的 MR 投影。
 *
 * 路由层不得直接读库（depcheck `no-routes-to-db`），因此 claim 与仓库地址这两次点查
 * 连同 href 拼装一并落在读模型里；路由只消费结果。无 claim ⇒ `null`（尚未建 MR）。
 */
export function getMissionMergeRequestView(
  db: DbClient,
  missionId: string,
  repositoryId: string,
): MissionMergeRequestView | null {
  const claim = db
    .select()
    .from(developmentMrClaims)
    .where(eq(developmentMrClaims.missionId, missionId))
    .get()
  if (claim === undefined) return null
  const repository = db
    .select({ urlRedacted: cachedRepos.urlRedacted })
    .from(cachedRepos)
    .where(eq(cachedRepos.id, repositoryId))
    .get()
  return {
    iid: claim.mrIid,
    state: claim.state,
    href: mergeRequestHref({
      repositoryUrl: repository?.urlRedacted ?? null,
      endpointRef: claim.codeHostEndpointRef,
      mrIid: claim.mrIid,
    }),
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
