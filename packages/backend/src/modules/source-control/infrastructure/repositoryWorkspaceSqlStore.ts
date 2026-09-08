import { and, sql, type SQLWrapper } from 'drizzle-orm'

import type { EngineCapabilities } from '@/platform/persistence/capabilities'
import {
  cachedRepos,
  memories,
  repoGroupNodes,
  repoGroups,
  scheduledTasks,
  taskRepos,
  tasks,
} from '@/db/schema'
import type {
  CachedRepositoryPageQuery,
  CachedRepositoryPageRecords,
  CachedRepositoryPatch,
  CachedRepositoryRecord,
  RepositoryCredentialSealingSnapshot,
  RepositoryGroupSnapshot,
  RepositoryScheduleRecord,
  WorktreeTaskRecord,
} from '../ports/repositoryWorkspaceStore'
import {
  currentRepositoryFacetCacheEpoch,
  invalidateRepositoryWorkspaceFacetCaches,
} from '../ports/repositoryWorkspaceStore'

export interface RepositoryWorkspaceSqlExecutor {
  all<T extends Record<string, unknown>>(query: SQLWrapper): Promise<readonly T[]>
  run(query: SQLWrapper): Promise<number>
  /**
   * 每格一条 `SELECT count(*) FROM cached_repos WHERE <谓词>` 的标量子查询。
   * `referenced` 的三格互斥（见 `referencedFacetCounts`），调用方相加。
   */
  cachedRepoFacets(input: {
    readonly explicit: SQLWrapper
    readonly legacyOnly: SQLWrapper
    readonly scheduledOnly: SQLWrapper
    readonly attention: SQLWrapper
  }): Promise<{
    readonly all_count: number
    readonly explicit_count: number
    readonly legacy_count: number
    readonly scheduled_count: number
    readonly attention_count: number
  }>
}

interface RawCachedRepoRow {
  readonly id: string
  readonly url_hash: string
  readonly url_enc: string | null
  readonly url_redacted: string | null
  readonly local_path: string
  readonly default_branch: string | null
  readonly last_fetched_at: number
  readonly created_at: number
  readonly has_submodules: boolean | number | null
  readonly last_submodule_sync_ok: boolean | number | null
  readonly last_submodule_sync_error: string | null
  readonly last_auto_refresh_at: number | null
}

interface RawRepositoryGroupRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: number
  readonly created_by_user_id: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly schema_version: number
}

interface RawRepositoryGroupNodeRow {
  readonly group_id: string
  readonly path: string
  readonly attachment_kind: 'repo' | 'group' | null
  readonly cached_repo_id: string | null
  readonly ref: string
  readonly subdir: string
  readonly child_group_id: string | null
  readonly readonly: boolean | number
}

const cachedRepoSelect = sql`
  ${cachedRepos.id} AS id,
  ${cachedRepos.urlHash} AS url_hash,
  ${cachedRepos.urlEnc} AS url_enc,
  ${cachedRepos.urlRedacted} AS url_redacted,
  ${cachedRepos.localPath} AS local_path,
  ${cachedRepos.defaultBranch} AS default_branch,
  ${cachedRepos.lastFetchedAt} AS last_fetched_at,
  ${cachedRepos.createdAt} AS created_at,
  ${cachedRepos.hasSubmodules} AS has_submodules,
  ${cachedRepos.lastSubmoduleSyncOk} AS last_submodule_sync_ok,
  ${cachedRepos.lastSubmoduleSyncError} AS last_submodule_sync_error,
  ${cachedRepos.lastAutoRefreshAt} AS last_auto_refresh_at
`

function nullableBoolean(value: boolean | number | null): boolean | null {
  return value === null ? null : value === true || value === 1
}

export function mapCachedRepository(row: RawCachedRepoRow): CachedRepositoryRecord {
  return {
    id: row.id,
    urlHash: row.url_hash,
    urlEnc: row.url_enc,
    urlRedacted: row.url_redacted,
    localPath: row.local_path,
    defaultBranch: row.default_branch,
    lastFetchedAt: Number(row.last_fetched_at),
    createdAt: Number(row.created_at),
    hasSubmodules: nullableBoolean(row.has_submodules),
    lastSubmoduleSyncOk: nullableBoolean(row.last_submodule_sync_ok),
    lastSubmoduleSyncError: row.last_submodule_sync_error,
    lastAutoRefreshAt: row.last_auto_refresh_at === null ? null : Number(row.last_auto_refresh_at),
  }
}

function scheduleOf(row: {
  readonly id: string
  readonly name: string
  readonly launch_payload: string
  readonly enabled: boolean | number
}): RepositoryScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    launchPayload: row.launch_payload,
    enabled: row.enabled === true || row.enabled === 1,
  }
}

function columnName(column: { readonly name: string }): SQLWrapper {
  return sql.identifier(column.name)
}

function patchAssignments(patch: CachedRepositoryPatch): SQLWrapper[] {
  const assignments: SQLWrapper[] = []
  if (patch.urlHash !== undefined) {
    assignments.push(sql`${columnName(cachedRepos.urlHash)} = ${patch.urlHash}`)
  }
  if (patch.urlEnc !== undefined) {
    assignments.push(sql`${columnName(cachedRepos.urlEnc)} = ${patch.urlEnc}`)
  }
  if (patch.urlRedacted !== undefined) {
    assignments.push(sql`${columnName(cachedRepos.urlRedacted)} = ${patch.urlRedacted}`)
  }
  if (patch.localPath !== undefined) {
    assignments.push(sql`${columnName(cachedRepos.localPath)} = ${patch.localPath}`)
  }
  if (patch.defaultBranch !== undefined) {
    assignments.push(sql`${columnName(cachedRepos.defaultBranch)} = ${patch.defaultBranch}`)
  }
  if (patch.lastFetchedAt !== undefined) {
    assignments.push(sql`${columnName(cachedRepos.lastFetchedAt)} = ${patch.lastFetchedAt}`)
  }
  if (patch.hasSubmodules !== undefined) {
    assignments.push(sql`${columnName(cachedRepos.hasSubmodules)} = ${patch.hasSubmodules}`)
  }
  if (patch.lastSubmoduleSyncOk !== undefined) {
    assignments.push(
      sql`${columnName(cachedRepos.lastSubmoduleSyncOk)} = ${patch.lastSubmoduleSyncOk}`,
    )
  }
  if (patch.lastSubmoduleSyncError !== undefined) {
    assignments.push(
      sql`${columnName(cachedRepos.lastSubmoduleSyncError)} = ${patch.lastSubmoduleSyncError}`,
    )
  }
  if (patch.lastAutoRefreshAt !== undefined) {
    assignments.push(sql`${columnName(cachedRepos.lastAutoRefreshAt)} = ${patch.lastAutoRefreshAt}`)
  }
  return assignments
}

const referencePattern = /"cachedRepoId":"([^"\\]+)"/g

function scheduledReferenceIds(rows: readonly { readonly launch_payload: string }[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    for (const match of row.launch_payload.matchAll(referencePattern)) ids.add(match[1]!)
  }
  return ids
}

function scheduledCondition(scheduleIds: ReadonlySet<string>): SQLWrapper {
  return scheduleIds.size === 0
    ? // RFC-349: this fragment lands in a boolean position (an `OR` arm in
      // `referencedCondition`, the leading `AND` term in `scheduledOnly`), and the
      // same builder now renders for PostgreSQL, which types `0` as integer and
      // rejects the whole statement (`argument of OR must be type boolean, not type
      // integer`). `false` is the literal both dialects agree on — it is what
      // drizzle's own empty `inArray` emits.
      sql`false`
    : sql`${cachedRepos.id} in (${sql.join(
        [...scheduleIds].map((id) => sql`${id}`),
        sql`, `,
      )})`
}

/** 被至少一行显式 `task_repos` 引用。 */
const explicitReference = sql`exists (
  select 1 from ${taskRepos} where ${taskRepos.cachedRepoId} = ${cachedRepos.id}
)`

/** 被**遗留直挂**引用：任务自己带 `cached_repo_id`，且它一行 `task_repos` 都没有。 */
const legacyReference = sql`exists (
  select 1 from ${tasks} where ${tasks.cachedRepoId} = ${cachedRepos.id}
    and not exists (select 1 from ${taskRepos} where ${taskRepos.taskId} = ${tasks.id})
)`

/** Row-level predicate: 三条来源的并集。用在**分页 WHERE** 里，两个 planner 在那个位置
 *  都能把 `exists` 上提成 semi/anti join，形状没有问题。 */
function referencedCondition(scheduleIds: ReadonlySet<string>): SQLWrapper {
  return sql`(
    ${explicitReference}
    or ${legacyReference}
    or ${scheduledCondition(scheduleIds)}
  )`
}

/**
 * RFC-359 W8-T26 —— facets 的 `referenced` 一格拆成**三格互斥计数**，每格一条标量子查询。
 *
 * 改写前是 `sum(case when (exists(…) or exists(…) or id in (…)) then 1 else 0 end)`：
 * 写在聚合 `CASE` 里的相关子查询**两个 planner 都无法上提**成 semi join，只能对
 * cached_repos 的每一行重跑一遍。PostgreSQL 上实测（50000 tasks 语料）：
 *
 *   · 50000 个仓库：322ms / 250,319 个 shared buffer，且估算代价越过 `jit_above_cost`
 *     又白搭进一次 JIT 编译；
 *   · 200 个仓库（生产比例：仓库少、任务多）：112ms / 16,702 buffer——planner 对
 *     `loops=200` 的子计划选了 `Seq Scan on task_repos`，比逐行索引探还糟。
 *
 * 支点是**把 `exists` 送回 WHERE 子句**：那个位置两个 planner 都会上提。外层是一行常量，
 * 所以每格只求值一次（loops=1）。三格按 `E / ¬E∧L / ¬E∧¬L∧S` 互斥切分，相加即原来的并集。
 *
 * 实测（同语料，PostgreSQL）：50000 仓库 322ms → 59ms、250,319 → 2,021 buffer，JIT 消失；
 * 200 仓库 112ms → 19ms、16,702 → 1,114 buffer。
 *
 * **为什么不是「预聚合 task_repos ∪ tasks 再 LEFT JOIN」**（T26 账本原本记的正解）：
 * 那个形状在 PostgreSQL 上同样快（49ms / 904 buffer），但它把代价从 O(仓库数) 换成了
 * O(**任务数**)——生产里任务表比仓库表大几个数量级。SQLite 上实测因此直接翻车：
 * 200 仓库 / 50000 任务的形态上 0.2ms → 16ms（八十倍），并且 `SCAN tasks` 触发
 * `rfc311-perf-guards` 的「不许扫无界表」判据。互斥三格两个引擎、两种表比例下都不退化
 * （SQLite 同形态 0.2ms → 0.4ms）。
 *
 * 结果等价（三格相加 === 原来的并集）由 `rfc359-w8-t26-plan-reshape-conformance`
 * 用一对多 / 空集 / NULL / 悬空键四类语料在两个引擎上钉住。
 */
function referencedFacetCounts(scheduleIds: ReadonlySet<string>): {
  readonly explicit: SQLWrapper
  readonly legacyOnly: SQLWrapper
  readonly scheduledOnly: SQLWrapper
} {
  return {
    explicit: explicitReference,
    legacyOnly: sql`not ${explicitReference} and ${legacyReference}`,
    scheduledOnly: sql`${scheduledCondition(scheduleIds)}
      and not ${explicitReference} and not ${legacyReference}`,
  }
}

const attentionCondition = sql`(
  ${cachedRepos.hasSubmodules} = ${true}
  and ${cachedRepos.lastSubmoduleSyncOk} = ${false}
)`

const REPOSITORY_FACETS_TTL_MS = 5_000

interface RepositoryFacetsCacheEntry {
  readonly expiresAt: number
  readonly epoch: number
  readonly scheduleIds: ReadonlySet<string>
  readonly facets: CachedRepositoryPageRecords['facets']
}

/** Shared provider-independent SQL projection. Provider-specific transaction
 * implementations wrap the mutation sets exposed by this base class. */
export class RepositoryWorkspaceSqlStore {
  private facetsCache: RepositoryFacetsCacheEntry | null = null

  constructor(
    protected readonly executor: RepositoryWorkspaceSqlExecutor,
    private readonly engine: Pick<EngineCapabilities, 'likeCaseInsensitive' | 'likeEscape'>,
  ) {}

  invalidateCachedRepoFacets(): void {
    this.facetsCache = null
    invalidateRepositoryWorkspaceFacetCaches()
  }

  async findCachedRepoByHash(hash: string): Promise<CachedRepositoryRecord | null> {
    const rows = await this.executor.all<RawCachedRepoRow & Record<string, unknown>>(sql`
      SELECT ${cachedRepoSelect}
      FROM ${cachedRepos}
      WHERE ${cachedRepos.urlHash} = ${hash}
      LIMIT 1
    `)
    return rows[0] === undefined ? null : mapCachedRepository(rows[0])
  }

  async findCachedRepoById(id: string): Promise<CachedRepositoryRecord | null> {
    const rows = await this.executor.all<RawCachedRepoRow & Record<string, unknown>>(sql`
      SELECT ${cachedRepoSelect}
      FROM ${cachedRepos}
      WHERE ${cachedRepos.id} = ${id}
      LIMIT 1
    `)
    return rows[0] === undefined ? null : mapCachedRepository(rows[0])
  }

  async insertCachedRepo(record: CachedRepositoryRecord): Promise<boolean> {
    const changes = await this.executor.run(sql`
      INSERT INTO ${cachedRepos} (
        ${columnName(cachedRepos.id)}, ${columnName(cachedRepos.urlHash)},
        ${columnName(cachedRepos.urlEnc)}, ${columnName(cachedRepos.urlRedacted)},
        ${columnName(cachedRepos.localPath)}, ${columnName(cachedRepos.defaultBranch)},
        ${columnName(cachedRepos.lastFetchedAt)}, ${columnName(cachedRepos.createdAt)},
        ${columnName(cachedRepos.hasSubmodules)},
        ${columnName(cachedRepos.lastSubmoduleSyncOk)},
        ${columnName(cachedRepos.lastSubmoduleSyncError)},
        ${columnName(cachedRepos.lastAutoRefreshAt)}
      ) VALUES (
        ${record.id}, ${record.urlHash}, ${record.urlEnc}, ${record.urlRedacted},
        ${record.localPath}, ${record.defaultBranch}, ${record.lastFetchedAt},
        ${record.createdAt}, ${record.hasSubmodules}, ${record.lastSubmoduleSyncOk},
        ${record.lastSubmoduleSyncError}, ${record.lastAutoRefreshAt}
      ) ON CONFLICT (${columnName(cachedRepos.urlHash)}) DO NOTHING
    `)
    if (changes === 1) this.invalidateCachedRepoFacets()
    return changes === 1
  }

  async updateCachedRepo(
    id: string,
    patch: CachedRepositoryPatch,
    expectedUrlHash?: string,
  ): Promise<boolean> {
    const assignments = patchAssignments(patch)
    if (assignments.length === 0) return true
    const changes = await this.executor.run(sql`
      UPDATE ${cachedRepos}
      SET ${sql.join(assignments, sql`, `)}
      WHERE ${cachedRepos.id} = ${id}
        ${expectedUrlHash === undefined ? sql`` : sql`AND ${cachedRepos.urlHash} = ${expectedUrlHash}`}
    `)
    if (changes === 1) this.invalidateCachedRepoFacets()
    return changes === 1
  }

  async upsertCachedRepo(record: CachedRepositoryRecord): Promise<void> {
    await this.executor.run(sql`
      INSERT INTO ${cachedRepos} (
        ${columnName(cachedRepos.id)}, ${columnName(cachedRepos.urlHash)},
        ${columnName(cachedRepos.urlEnc)}, ${columnName(cachedRepos.urlRedacted)},
        ${columnName(cachedRepos.localPath)}, ${columnName(cachedRepos.defaultBranch)},
        ${columnName(cachedRepos.lastFetchedAt)}, ${columnName(cachedRepos.createdAt)},
        ${columnName(cachedRepos.hasSubmodules)},
        ${columnName(cachedRepos.lastSubmoduleSyncOk)},
        ${columnName(cachedRepos.lastSubmoduleSyncError)},
        ${columnName(cachedRepos.lastAutoRefreshAt)}
      ) VALUES (
        ${record.id}, ${record.urlHash}, ${record.urlEnc}, ${record.urlRedacted},
        ${record.localPath}, ${record.defaultBranch}, ${record.lastFetchedAt},
        ${record.createdAt}, ${record.hasSubmodules}, ${record.lastSubmoduleSyncOk},
        ${record.lastSubmoduleSyncError}, ${record.lastAutoRefreshAt}
      ) ON CONFLICT (${columnName(cachedRepos.urlHash)}) DO UPDATE SET
        ${columnName(cachedRepos.urlEnc)} = excluded.url_enc,
        ${columnName(cachedRepos.urlRedacted)} = excluded.url_redacted,
        ${columnName(cachedRepos.localPath)} = excluded.local_path,
        ${columnName(cachedRepos.defaultBranch)} = excluded.default_branch,
        ${columnName(cachedRepos.lastFetchedAt)} = excluded.last_fetched_at,
        ${columnName(cachedRepos.hasSubmodules)} = excluded.has_submodules,
        ${columnName(cachedRepos.lastSubmoduleSyncOk)} = excluded.last_submodule_sync_ok,
        ${columnName(cachedRepos.lastSubmoduleSyncError)} = excluded.last_submodule_sync_error,
        ${columnName(cachedRepos.lastAutoRefreshAt)} = excluded.last_auto_refresh_at
    `)
    this.invalidateCachedRepoFacets()
  }

  async countCachedRepos(): Promise<number> {
    const rows = await this.executor.all<{ count: number }>(sql`
      SELECT count(*) AS count FROM ${cachedRepos}
    `)
    return Number(rows[0]?.count ?? 0)
  }

  async listCachedRepos(): Promise<readonly CachedRepositoryRecord[]> {
    const rows = await this.executor.all<RawCachedRepoRow & Record<string, unknown>>(sql`
      SELECT ${cachedRepoSelect}
      FROM ${cachedRepos}
      ORDER BY ${cachedRepos.lastFetchedAt} DESC, ${cachedRepos.id} DESC
    `)
    return rows.map(mapCachedRepository)
  }

  private async schedulePayloadRows(): Promise<readonly { launch_payload: string }[]> {
    return await this.executor.all<{ launch_payload: string }>(sql`
      SELECT ${scheduledTasks.launchPayload} AS launch_payload FROM ${scheduledTasks}
    `)
  }

  async cachedRepoReferenceCount(id: string): Promise<number> {
    const rows = await this.executor.all<{ count: number }>(sql`
      SELECT count(*) AS count FROM (
        SELECT ${taskRepos.taskId} AS task_id
        FROM ${taskRepos}
        WHERE ${taskRepos.cachedRepoId} = ${id}
        GROUP BY ${taskRepos.taskId}
        UNION ALL
        SELECT ${tasks.id} AS task_id
        FROM ${tasks}
        WHERE ${tasks.cachedRepoId} = ${id}
          AND NOT EXISTS (
            SELECT 1 FROM ${taskRepos} WHERE ${taskRepos.taskId} = ${tasks.id}
          )
      ) AS task_refs
    `)
    let count = Number(rows[0]?.count ?? 0)
    const needle = `"cachedRepoId":${JSON.stringify(id)}`
    for (const row of await this.schedulePayloadRows()) {
      if (row.launch_payload.includes(needle)) count++
    }
    return count
  }

  async cachedRepoReferenceCounts(ids: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>()
    if (ids.length === 0) return counts
    const idSet = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )
    const explicitRows = await this.executor.all<{
      cached_repo_id: string
      count: number
    }>(sql`
      SELECT ${taskRepos.cachedRepoId} AS cached_repo_id, count(distinct ${taskRepos.taskId}) AS count
      FROM ${taskRepos}
      WHERE ${taskRepos.cachedRepoId} IN (${idSet})
      GROUP BY ${taskRepos.cachedRepoId}
    `)
    const legacyRows = await this.executor.all<{
      cached_repo_id: string
      count: number
    }>(sql`
      SELECT ${tasks.cachedRepoId} AS cached_repo_id, count(*) AS count
      FROM ${tasks}
      WHERE ${tasks.cachedRepoId} IN (${idSet})
        AND ${tasks.id} NOT IN (SELECT ${taskRepos.taskId} FROM ${taskRepos})
      GROUP BY ${tasks.cachedRepoId}
    `)
    for (const row of explicitRows) counts.set(row.cached_repo_id, Number(row.count))
    for (const row of legacyRows) {
      counts.set(row.cached_repo_id, (counts.get(row.cached_repo_id) ?? 0) + Number(row.count))
    }
    const known = new Set(ids)
    for (const schedule of await this.schedulePayloadRows()) {
      const seen = new Set<string>()
      for (const match of schedule.launch_payload.matchAll(referencePattern)) {
        if (known.has(match[1]!)) seen.add(match[1]!)
      }
      for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }

  async listCachedRepoPage(query: CachedRepositoryPageQuery): Promise<CachedRepositoryPageRecords> {
    const cachedFacets =
      this.facetsCache !== null &&
      this.facetsCache.expiresAt > Date.now() &&
      this.facetsCache.epoch === currentRepositoryFacetCacheEpoch()
        ? this.facetsCache
        : null
    const scheduleIds =
      cachedFacets?.scheduleIds ?? scheduledReferenceIds(await this.schedulePayloadRows())
    const conditions: SQLWrapper[] = []
    const term = query.q?.trim() ?? ''
    if (term !== '') {
      const { pattern, escape } = this.engine.likeEscape(term)
      conditions.push(sql`(
        ${this.engine.likeCaseInsensitive(sql`coalesce(${cachedRepos.urlRedacted}, '<url unavailable>')`, pattern, escape)}
        or ${this.engine.likeCaseInsensitive(cachedRepos.localPath, pattern, escape)}
        or ${this.engine.likeCaseInsensitive(cachedRepos.defaultBranch, pattern, escape)}
      )`)
    }
    if (query.submodules === 'with') conditions.push(sql`${cachedRepos.hasSubmodules} = ${true}`)
    if (query.submodules === 'without') {
      conditions.push(sql`${cachedRepos.hasSubmodules} = ${false}`)
    }
    if (query.autoRefresh === 'refreshed') {
      conditions.push(sql`${cachedRepos.lastAutoRefreshAt} is not null`)
    }
    if (query.autoRefresh === 'never') {
      conditions.push(sql`${cachedRepos.lastAutoRefreshAt} is null`)
    }
    const referenced = referencedCondition(scheduleIds)
    if (query.view === 'referenced') conditions.push(referenced)
    if (query.view === 'unused') conditions.push(sql`not ${referenced}`)
    if (query.view === 'attention') conditions.push(attentionCondition)
    if (query.cursor !== undefined) {
      conditions.push(sql`(
        ${cachedRepos.lastFetchedAt}, ${cachedRepos.id}
      ) < (
        ${query.cursor.lastFetchedAt}, ${query.cursor.id}
      )`)
    }
    const where = conditions.length === 0 ? sql`` : sql`WHERE ${and(...conditions)}`
    const rows = await this.executor.all<RawCachedRepoRow & Record<string, unknown>>(sql`
      SELECT ${cachedRepoSelect}
      FROM ${cachedRepos}
      ${where}
      ORDER BY ${cachedRepos.lastFetchedAt} DESC, ${cachedRepos.id} DESC
      LIMIT ${query.limit + 1}
    `)
    const mapped = rows.map(mapCachedRepository)
    const page = mapped.slice(0, query.limit)
    const counts = await this.cachedRepoReferenceCounts(page.map((row) => row.id))
    let facets = cachedFacets?.facets
    if (facets === undefined) {
      const facetRow = await this.executor.cachedRepoFacets({
        ...referencedFacetCounts(scheduleIds),
        attention: attentionCondition,
      })
      const all = Number(facetRow.all_count)
      // 三格按构造互斥（E / ¬E∧L / ¬E∧¬L∧S），相加即改写前那个 OR 的并集势。
      const referencedCount =
        Number(facetRow.explicit_count) +
        Number(facetRow.legacy_count) +
        Number(facetRow.scheduled_count)
      facets = {
        all,
        referenced: referencedCount,
        attention: Number(facetRow.attention_count),
        unused: all - referencedCount,
      }
      this.facetsCache = {
        expiresAt: Date.now() + REPOSITORY_FACETS_TTL_MS,
        epoch: currentRepositoryFacetCacheEpoch(),
        scheduleIds,
        facets,
      }
    }
    return {
      rows: page,
      hasMore: mapped.length > query.limit,
      referenceCounts: counts,
      facets,
    }
  }

  async listDueCachedRepos(input: {
    readonly dueBefore: number
    readonly freshAfter: number
  }): Promise<readonly Pick<CachedRepositoryRecord, 'id' | 'urlRedacted'>[]> {
    const rows = await this.executor.all<{ id: string; url_redacted: string | null }>(sql`
      SELECT ${cachedRepos.id} AS id, ${cachedRepos.urlRedacted} AS url_redacted
      FROM ${cachedRepos}
      WHERE ${cachedRepos.lastFetchedAt} >= ${input.freshAfter}
        AND (
          ${cachedRepos.lastAutoRefreshAt} IS NULL
          OR ${cachedRepos.lastAutoRefreshAt} < ${input.dueBefore}
        )
        AND ${cachedRepos.localPath} IS NOT NULL
    `)
    return rows.map((row) => ({ id: row.id, urlRedacted: row.url_redacted }))
  }

  async stampAutoRefreshed(ids: readonly string[], at: number): Promise<void> {
    if (ids.length === 0) return
    await this.executor.run(sql`
      UPDATE ${cachedRepos}
      SET ${columnName(cachedRepos.lastAutoRefreshAt)} = ${at}
      WHERE ${cachedRepos.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    `)
  }

  async listKnownRepositoryPaths(): Promise<readonly string[]> {
    const rows = await this.executor.all<{ local_path: string }>(sql`
      SELECT ${cachedRepos.localPath} AS local_path FROM ${cachedRepos}
    `)
    return rows.map((row) => row.local_path)
  }

  async groupsReferencingRepo(id: string): Promise<readonly { id: string; name: string }[]> {
    const rows = await this.executor.all<{ id: string; name: string }>(sql`
      SELECT ${repoGroups.id} AS id, ${repoGroups.name} AS name
      FROM ${repoGroupNodes}
      INNER JOIN ${repoGroups} ON ${repoGroups.id} = ${repoGroupNodes.groupId}
      WHERE ${repoGroupNodes.cachedRepoId} = ${id}
      GROUP BY ${repoGroups.id}, ${repoGroups.name}
    `)
    return rows
  }

  async detachRepoFromAllGroups(id: string): Promise<number> {
    return await this.executor.run(sql`
      UPDATE ${repoGroupNodes}
      SET ${columnName(repoGroupNodes.attachmentKind)} = null,
        ${columnName(repoGroupNodes.cachedRepoId)} = null,
        ${columnName(repoGroupNodes.childGroupId)} = null,
        ${columnName(repoGroupNodes.ref)} = '',
        ${columnName(repoGroupNodes.subdir)} = '',
        ${columnName(repoGroupNodes.readonly)} = ${false}
      WHERE ${repoGroupNodes.cachedRepoId} = ${id}
    `)
  }

  async readCredentialSealingSnapshot(): Promise<RepositoryCredentialSealingSnapshot> {
    const [repoRows, taskRepoRows, taskRows, scheduleRows] = await Promise.all([
      this.executor.all<RawCachedRepoRow & Record<string, unknown>>(sql`
        SELECT ${cachedRepoSelect} FROM ${cachedRepos}
      `),
      this.executor.all<{
        task_id: string
        repo_index: number
        repo_url: string | null
        cached_repo_id: string | null
        submodule_init_error: string | null
      }>(sql`
        SELECT ${taskRepos.taskId} AS task_id, ${taskRepos.repoIndex} AS repo_index,
          ${taskRepos.repoUrl} AS repo_url, ${taskRepos.cachedRepoId} AS cached_repo_id,
          ${taskRepos.submoduleInitError} AS submodule_init_error
        FROM ${taskRepos}
      `),
      this.executor.all<{
        id: string
        repo_url: string | null
        cached_repo_id: string | null
      }>(sql`
        SELECT ${tasks.id} AS id, ${tasks.repoUrl} AS repo_url,
          ${tasks.cachedRepoId} AS cached_repo_id
        FROM ${tasks}
      `),
      this.executor.all<{
        id: string
        name: string
        launch_payload: string
        enabled: boolean | number
      }>(sql`
        SELECT ${scheduledTasks.id} AS id, ${scheduledTasks.name} AS name,
          ${scheduledTasks.launchPayload} AS launch_payload,
          ${scheduledTasks.enabled} AS enabled
        FROM ${scheduledTasks}
      `),
    ])
    return {
      cachedRepos: repoRows.map(mapCachedRepository),
      taskRepos: taskRepoRows.map((row) => ({
        taskId: row.task_id,
        repoIndex: Number(row.repo_index),
        repoUrl: row.repo_url,
        cachedRepoId: row.cached_repo_id,
        submoduleInitError: row.submodule_init_error,
      })),
      tasks: taskRows.map((row) => ({
        id: row.id,
        repoUrl: row.repo_url,
        cachedRepoId: row.cached_repo_id,
      })),
      schedules: scheduleRows.map(scheduleOf),
    }
  }

  async readRepositoryGroupSnapshot(): Promise<RepositoryGroupSnapshot> {
    const [groupRows, nodeRows, repoRows, memoryRows, scheduleRows] = await Promise.all([
      this.executor.all<RawRepositoryGroupRow & Record<string, unknown>>(sql`
        SELECT ${repoGroups.id} AS id, ${repoGroups.name} AS name,
          ${repoGroups.description} AS description, ${repoGroups.version} AS version,
          ${repoGroups.createdByUserId} AS created_by_user_id,
          ${repoGroups.createdAt} AS created_at, ${repoGroups.updatedAt} AS updated_at,
          ${repoGroups.schemaVersion} AS schema_version
        FROM ${repoGroups}
        ORDER BY ${repoGroups.name}, ${repoGroups.id}
      `),
      this.executor.all<RawRepositoryGroupNodeRow & Record<string, unknown>>(sql`
        SELECT ${repoGroupNodes.groupId} AS group_id, ${repoGroupNodes.path} AS path,
          ${repoGroupNodes.attachmentKind} AS attachment_kind,
          ${repoGroupNodes.cachedRepoId} AS cached_repo_id,
          ${repoGroupNodes.ref} AS ref, ${repoGroupNodes.subdir} AS subdir,
          ${repoGroupNodes.childGroupId} AS child_group_id,
          ${repoGroupNodes.readonly} AS readonly
        FROM ${repoGroupNodes}
        ORDER BY ${repoGroupNodes.groupId}, ${repoGroupNodes.path}
      `),
      this.executor.all<{ id: string; url_redacted: string | null }>(sql`
        SELECT ${cachedRepos.id} AS id, ${cachedRepos.urlRedacted} AS url_redacted
        FROM ${cachedRepos}
      `),
      this.executor.all<{ scope_id: string; count: number }>(sql`
        SELECT ${memories.scopeId} AS scope_id, count(*) AS count
        FROM ${memories}
        WHERE ${memories.scopeType} = 'repo_group'
          AND ${memories.status} IN ('candidate', 'approved', 'superseded', 'rejected')
          AND ${memories.scopeId} IS NOT NULL
        GROUP BY ${memories.scopeId}
      `),
      this.executor.all<{
        id: string
        name: string
        launch_payload: string
        enabled: boolean | number
      }>(sql`
        SELECT ${scheduledTasks.id} AS id, ${scheduledTasks.name} AS name,
          ${scheduledTasks.launchPayload} AS launch_payload,
          ${scheduledTasks.enabled} AS enabled
        FROM ${scheduledTasks}
      `),
    ])
    return {
      groups: groupRows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        version: Number(row.version),
        createdByUserId: row.created_by_user_id,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        schemaVersion: Number(row.schema_version),
      })),
      nodes: nodeRows.map((row) => ({
        groupId: row.group_id,
        path: row.path,
        attachmentKind: row.attachment_kind,
        cachedRepoId: row.cached_repo_id,
        ref: row.ref,
        subdir: row.subdir,
        childGroupId: row.child_group_id,
        readonly: row.readonly === true || row.readonly === 1,
      })),
      repoUrls: new Map(repoRows.map((row) => [row.id, row.url_redacted])),
      boundMemoryCounts: new Map(memoryRows.map((row) => [row.scope_id, Number(row.count)])),
      schedules: scheduleRows.map(scheduleOf),
    }
  }

  async findWorktreeTask(id: string): Promise<WorktreeTaskRecord | null> {
    const taskRows = await this.executor.all<{
      id: string
      owner_user_id: string | null
      worktree_path: string
      base_commit: string | null
    }>(sql`
      SELECT ${tasks.id} AS id, ${tasks.ownerUserId} AS owner_user_id,
        ${tasks.worktreePath} AS worktree_path, ${tasks.baseCommit} AS base_commit
      FROM ${tasks}
      WHERE ${tasks.id} = ${id}
      LIMIT 1
    `)
    const task = taskRows[0]
    if (task === undefined) return null
    const repos = await this.executor.all<{
      repo_index: number
      worktree_path: string
      base_commit: string | null
      mount_path: string
    }>(sql`
      SELECT ${taskRepos.repoIndex} AS repo_index,
        ${taskRepos.worktreePath} AS worktree_path,
        ${taskRepos.baseCommit} AS base_commit,
        ${taskRepos.mountPath} AS mount_path
      FROM ${taskRepos}
      WHERE ${taskRepos.taskId} = ${id}
      ORDER BY ${taskRepos.repoIndex}
    `)
    return {
      id: task.id,
      ownerUserId: task.owner_user_id,
      worktreePath: task.worktree_path,
      baseCommit: task.base_commit,
      repos: repos.map((row) => ({
        repoIndex: Number(row.repo_index),
        worktreePath: row.worktree_path,
        baseCommit: row.base_commit,
        mountPath: row.mount_path,
      })),
    }
  }
}
