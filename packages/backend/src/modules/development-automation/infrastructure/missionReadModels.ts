// RFC-310 PR-2 T31 —— Mission read models（列表/详情/决策 trace）。
//
// 只读投影：列表回摘要（design §1.4 DevelopmentMissionSummary 的 PR-2 子集），
// 详情附 source/upload/decision 摘要，trace 回 canonical guard/rule trace。
// 不返回 host path/nonce/secret/raw 正文（§12.4）。

import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'

import {
  DIGITAL_EMPLOYEE_MISSION_STATUSES,
  digitalEmployeeTaskStatus,
  taskMatchesListView,
  type TaskListView,
  type TaskStatus,
} from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import {
  cachedRepos,
  developmentDecisions,
  developmentEffects,
  developmentMissionSources,
  developmentMissions,
  developmentMrClaims,
} from '@/db/schema'
import type { MissionReadModelQueries } from '../application/ports/missionReadModelQueries'

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

/**
 * RFC-311：列表只投影 `MissionSummaryView` 真正用到的 18 列。此前是 `select()` 全行，
 * 于是每一行都跟着把 `readiness_json` / `block_detail` 读出来——它们只在详情页用，
 * 却让列表付溢出页的代价（性能防护网的「列表不碰重列」判据抓到）。
 */
const SUMMARY_COLUMNS = {
  id: developmentMissions.id,
  revision: developmentMissions.revision,
  status: developmentMissions.status,
  automationMode: developmentMissions.automationMode,
  transitionFence: developmentMissions.transitionFence,
  repositoryId: developmentMissions.repositoryId,
  sourceKind: developmentMissions.sourceKind,
  externalId: developmentMissions.externalId,
  resolvedSourceKey: developmentMissions.resolvedSourceKey,
  deliveryKind: developmentMissions.deliveryKind,
  employeeId: developmentMissions.employeeId,
  employeeRevision: developmentMissions.employeeRevision,
  policyId: developmentMissions.policyId,
  policyRevision: developmentMissions.policyRevision,
  blockCode: developmentMissions.blockCode,
  terminalKind: developmentMissions.terminalKind,
  createdAt: developmentMissions.createdAt,
  updatedAt: developmentMissions.updatedAt,
} as const

function summaryOf(row: MissionSummaryView): MissionSummaryView {
  return row
}

export function listMissionSummaries(db: DbClient): MissionSummaryView[] {
  return db
    .select(SUMMARY_COLUMNS)
    .from(developmentMissions)
    .orderBy(desc(developmentMissions.createdAt))
    .all()
    .map(summaryOf)
}

const TERMINAL_MISSION_STATUSES = [
  'merged',
  'completed-no-change',
  'closed-unmerged',
  'canceled',
  'failed',
] as const
const MAX_EMPLOYEE_OUTCOME_GROUPS = 50_000

/**
 * Legacy-drain outcome projection for employee cards. This bounded context
 * emits raw status groups; the UI owns the stable cross-generation buckets.
 */
export function listMissionTerminalOutcomeGroups(db: DbClient): readonly {
  readonly employeeId: string
  readonly terminalKind: string
  readonly count: number
}[] {
  const rows = db
    .select({
      employeeId: developmentMissions.employeeId,
      terminalKind: developmentMissions.status,
      count: sql<number>`count(*)`,
    })
    .from(developmentMissions)
    .where(
      and(
        sql`${developmentMissions.employeeId} is not null`,
        inArray(developmentMissions.status, [...TERMINAL_MISSION_STATUSES]),
      ),
    )
    .groupBy(developmentMissions.status, developmentMissions.employeeId)
    .orderBy(asc(developmentMissions.status), asc(developmentMissions.employeeId))
    .limit(MAX_EMPLOYEE_OUTCOME_GROUPS + 1)
    .all()
  if (rows.length > MAX_EMPLOYEE_OUTCOME_GROUPS) {
    throw new Error('employee-outcome-group-limit-exceeded')
  }
  return rows.flatMap((row) =>
    row.employeeId === null
      ? []
      : [
          {
            employeeId: row.employeeId,
            terminalKind: row.terminalKind,
            count: Number(row.count),
          },
        ],
  )
}

/** 分页游标:与 /repos、/tasks 同款——**行值比较**的 keyset,不是 offset。 */
export interface MissionPageCursor {
  createdAt: number
  id: string
}

export interface MissionPage {
  items: MissionSummaryView[]
  nextCursor: MissionPageCursor | null
  /**
   * 四个视图桶的计数，**算在全集上**（不受 view / statuses / q 影响）——与 /tasks 的
   * facets 同语义，也与此前前端 `digitalEmployeeFacets(全量)` 的行为逐字一致。
   */
  facets: { all: number; active: number; attention: number; finished: number }
  /**
   * RFC-311：**过滤集**上按原始 mission 状态分组的计数（与 facets 的全集语义相对）。
   * 它让「只要几个数」的消费者一行都不用搬——员工产出摘要要的四个数字全部由它
   * 派生，此前那条路径是把整张表取回浏览器再 filter().length。
   * 行数被状态枚举封顶（≤13），与表大小无关。
   */
  counts: Record<string, number>
}

export interface MissionPageFilters {
  view?: TaskListView
  statuses?: readonly TaskStatus[]
  /** 大小写不敏感子串，匹配 id / repositoryId / externalId / blockCode / employeeId。 */
  q?: string
  /** RFC-311：按数字员工收敛——此前 /outcomes 与员工详情都取全量再在前端筛。 */
  employeeId?: string
  /**
   * RFC-311：**原始 mission 状态**过滤，不能用上面的 `statuses` 代替。
   * 任务状态映射把 `blocked` 与 `failed` 并成同一个 `failed`，而 `blocked` **不是**
   * 终态——/outcomes 要的「终态集合」用 `statuses` 表达会多出 blocked 的行。
   */
  missionStatuses?: readonly string[]
}

/**
 * 把 view + statuses 反解成**mission 状态集合**——服务端不去 SQL 里重写映射逻辑，
 * 而是拿 shared 里那张唯一的表把每个 mission 状态算一遍，取命中的那些。这样两端
 * 不可能漂移，代价是一次 13 元素的常数级枚举。
 */
export function missionStatusesFor(filters: MissionPageFilters): string[] {
  const wanted = filters.statuses ?? []
  const view = filters.view ?? 'all'
  return DIGITAL_EMPLOYEE_MISSION_STATUSES.filter((missionStatus) => {
    const status = digitalEmployeeTaskStatus(missionStatus)
    if (wanted.length > 0 && !wanted.includes(status)) return false
    return taskMatchesListView(view, status)
  })
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
  opts: { limit: number; cursor?: MissionPageCursor } & MissionPageFilters,
): MissionPage {
  const boundary =
    opts.cursor === undefined
      ? sql`1 = 1`
      : sql`(${developmentMissions.createdAt}, ${developmentMissions.id}) < (${opts.cursor.createdAt}, ${opts.cursor.id})`
  const statuses = missionStatusesFor(opts)
  // 空集合意味着这组过滤在语义上排除了一切——早退，别去发一条 `IN ()`。
  const statusCond =
    statuses.length === DIGITAL_EMPLOYEE_MISSION_STATUSES.length
      ? sql`1 = 1`
      : inArray(developmentMissions.status, statuses)
  const employeeCond =
    opts.employeeId === undefined ? sql`1 = 1` : eq(developmentMissions.employeeId, opts.employeeId)
  const missionStatusCond =
    opts.missionStatuses === undefined || opts.missionStatuses.length === 0
      ? sql`1 = 1`
      : inArray(developmentMissions.status, [...opts.missionStatuses])
  const needle = opts.q?.trim().toLocaleLowerCase('en-US')
  const qCond =
    needle === undefined || needle === ''
      ? sql`1 = 1`
      : sql`(lower(${developmentMissions.id}) like ${`%${needle}%`}
          or lower(${developmentMissions.repositoryId}) like ${`%${needle}%`}
          or lower(coalesce(${developmentMissions.externalId}, '')) like ${`%${needle}%`}
          or lower(coalesce(${developmentMissions.blockCode}, '')) like ${`%${needle}%`}
          or lower(coalesce(${developmentMissions.employeeId}, '')) like ${`%${needle}%`})`
  const filters = and(statusCond, qCond, employeeCond, missionStatusCond)!
  if (statuses.length === 0) {
    return { items: [], nextCursor: null, facets: missionFacets(db), counts: {} }
  }
  const rows = db
    .select(SUMMARY_COLUMNS)
    .from(developmentMissions)
    .where(and(boundary, filters))
    .orderBy(desc(developmentMissions.createdAt), desc(developmentMissions.id))
    .limit(opts.limit + 1)
    .all()
  const hasMore = rows.length > opts.limit
  const page = hasMore ? rows.slice(0, opts.limit) : rows
  const last = page[page.length - 1]
  return {
    items: page.map(summaryOf),
    nextCursor: hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
    facets: missionFacets(db),
    counts: missionCounts(db, filters),
  }
}

/** 过滤集上按原始 mission 状态分组的计数。一条 group by，行数被枚举封顶。 */
function missionCounts(db: DbClient, where: SQL): Record<string, number> {
  const rows = db
    .select({ status: developmentMissions.status, n: sql<number>`count(*)` })
    .from(developmentMissions)
    .where(where)
    .groupBy(developmentMissions.status)
    .all()
  const out: Record<string, number> = {}
  for (const row of rows) out[row.status] = row.n
  return out
}

/**
 * 四个视图桶的计数。**一条按状态分组的语句**，不是四条 count——分组结果在内存里按
 * shared 的同一张映射表折算，避免把 view 语义复制进 SQL。
 */
function missionFacets(db: DbClient): MissionPage['facets'] {
  const rows = db
    .select({ status: developmentMissions.status, n: sql<number>`count(*)` })
    .from(developmentMissions)
    .groupBy(developmentMissions.status)
    .all()
  const facets = { all: 0, active: 0, attention: 0, finished: 0 }
  for (const row of rows) {
    const status = digitalEmployeeTaskStatus(row.status)
    facets.all += row.n
    if (taskMatchesListView('active', status)) facets.active += row.n
    if (taskMatchesListView('attention', status)) facets.attention += row.n
    if (taskMatchesListView('finished', status)) facets.finished += row.n
  }
  return facets
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

export function createSqliteMissionReadModelQueries(db: DbClient): MissionReadModelQueries {
  return {
    async list() {
      return listMissionSummaries(db)
    },
    async listPage(input) {
      return listMissionSummariesPage(db, input)
    },
    async terminalOutcomeGroups() {
      return listMissionTerminalOutcomeGroups(db)
    },
    async detail(missionId) {
      return getMissionDetail(db, missionId)
    },
    async mergeRequest(missionId, repositoryId) {
      return getMissionMergeRequestView(db, missionId, repositoryId)
    },
    async effects(missionId) {
      return listMissionEffects(db, missionId)
    },
    async decisionTrace(missionId) {
      return getDecisionTrace(db, missionId)
    },
  }
}
