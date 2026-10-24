import type { RepositoryWorkspaceTaskPorts } from '../composition/required-ports'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { and, sql, type SQLWrapper } from 'drizzle-orm'

import type { RawRowCodecs } from '@/platform/persistence/queryHelpers'
import type { EngineCapabilities } from '@/platform/persistence/capabilities'
import type {
  CachedRepositoryPageQuery,
  CachedRepositoryPageRecords,
  CachedRepositoryPatch,
  CachedRepositoryRecord,
  RepositoryCredentialSealingSnapshot,
  RepositoryGroupSnapshot,
  RepositoryScheduleRecord,
} from '../ports/repositoryWorkspaceStore'
import {
  currentRepositoryFacetCacheEpoch,
  invalidateRepositoryWorkspaceFacetCaches,
} from '../ports/repositoryWorkspaceStore'

export interface RepositoryWorkspaceSqlExecutor {
  readonly db: PersistenceDb
  all<T extends Record<string, unknown>>(
    query: SQLWrapper,
    codecs?: RawRowCodecs<T>,
  ): Promise<readonly T[]>
  run(query: SQLWrapper): Promise<number>
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
  readonly has_submodules: boolean | null
  readonly last_submodule_sync_ok: boolean | null
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
  readonly readonly: boolean
}

const cachedRepoSelect = (db: object) => {
  const { cachedRepos } = tablesOf(db)
  return sql`
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
    hasSubmodules: row.has_submodules,
    lastSubmoduleSyncOk: row.last_submodule_sync_ok,
    lastSubmoduleSyncError: row.last_submodule_sync_error,
    lastAutoRefreshAt: row.last_auto_refresh_at === null ? null : Number(row.last_auto_refresh_at),
  }
}

function scheduleOf(row: {
  readonly id: string
  readonly name: string
  readonly launch_payload: string
  readonly enabled: boolean
}): RepositoryScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    launchPayload: row.launch_payload,
    enabled: row.enabled,
  }
}

function columnName(column: { readonly name: string }): SQLWrapper {
  return sql.identifier(column.name)
}

function patchAssignments(db: object, patch: CachedRepositoryPatch): SQLWrapper[] {
  const assignments: SQLWrapper[] = []
  if (patch.urlHash !== undefined) {
    const { cachedRepos } = tablesOf(db)
    assignments.push(sql`${columnName(cachedRepos.urlHash)} = ${patch.urlHash}`)
  }
  if (patch.urlEnc !== undefined) {
    const { cachedRepos } = tablesOf(db)
    assignments.push(sql`${columnName(cachedRepos.urlEnc)} = ${patch.urlEnc}`)
  }
  if (patch.urlRedacted !== undefined) {
    const { cachedRepos } = tablesOf(db)
    assignments.push(sql`${columnName(cachedRepos.urlRedacted)} = ${patch.urlRedacted}`)
  }
  if (patch.localPath !== undefined) {
    const { cachedRepos } = tablesOf(db)
    assignments.push(sql`${columnName(cachedRepos.localPath)} = ${patch.localPath}`)
  }
  if (patch.defaultBranch !== undefined) {
    const { cachedRepos } = tablesOf(db)
    assignments.push(sql`${columnName(cachedRepos.defaultBranch)} = ${patch.defaultBranch}`)
  }
  if (patch.lastFetchedAt !== undefined) {
    const { cachedRepos } = tablesOf(db)
    assignments.push(sql`${columnName(cachedRepos.lastFetchedAt)} = ${patch.lastFetchedAt}`)
  }
  if (patch.hasSubmodules !== undefined) {
    const { cachedRepos } = tablesOf(db)
    assignments.push(sql`${columnName(cachedRepos.hasSubmodules)} = ${patch.hasSubmodules}`)
  }
  if (patch.lastSubmoduleSyncOk !== undefined) {
    const { cachedRepos } = tablesOf(db)
    assignments.push(
      sql`${columnName(cachedRepos.lastSubmoduleSyncOk)} = ${patch.lastSubmoduleSyncOk}`,
    )
  }
  if (patch.lastSubmoduleSyncError !== undefined) {
    const { cachedRepos } = tablesOf(db)
    assignments.push(
      sql`${columnName(cachedRepos.lastSubmoduleSyncError)} = ${patch.lastSubmoduleSyncError}`,
    )
  }
  if (patch.lastAutoRefreshAt !== undefined) {
    const { cachedRepos } = tablesOf(db)
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

function scheduledCondition(db: object, scheduleIds: ReadonlySet<string>): SQLWrapper {
  const { cachedRepos } = tablesOf(db)
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

/** RFC-395 II-b O1: source-control filters only its own IDs, after the task-owner probes. */
function referencedCondition(db: object, ids: ReadonlySet<string>): SQLWrapper {
  return scheduledCondition(db, ids)
}

const attentionCondition = (db: object) => {
  const { cachedRepos } = tablesOf(db)
  return sql`(
  ${cachedRepos.hasSubmodules} = ${true}
  and ${cachedRepos.lastSubmoduleSyncOk} = ${false}
)`
}

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
  protected get database(): PersistenceDb {
    return this.executor.db
  }
  private facetsCache: RepositoryFacetsCacheEntry | null = null

  constructor(
    protected readonly executor: RepositoryWorkspaceSqlExecutor,
    private readonly engine: Pick<EngineCapabilities, 'likeCaseInsensitive' | 'likeEscape'>,
    protected readonly taskPorts: RepositoryWorkspaceTaskPorts,
  ) {}

  invalidateCachedRepoFacets(): void {
    this.facetsCache = null
    invalidateRepositoryWorkspaceFacetCaches()
  }

  async findCachedRepoByHash(hash: string): Promise<CachedRepositoryRecord | null> {
    const persistenceDb = this.database

    const { cachedRepos } = tablesOf(persistenceDb)
    const rows = await this.executor.all<RawCachedRepoRow & Record<string, unknown>>(
      sql`
      SELECT ${cachedRepoSelect(persistenceDb)}
      FROM ${cachedRepos}
      WHERE ${cachedRepos.urlHash} = ${hash}
      LIMIT 1
    `,
      {
        last_fetched_at: 'int',
        created_at: 'int',
        has_submodules: 'bool',
        last_submodule_sync_ok: 'bool',
        last_auto_refresh_at: 'int',
      },
    )
    return rows[0] === undefined ? null : mapCachedRepository(rows[0])
  }

  async findCachedRepoById(id: string): Promise<CachedRepositoryRecord | null> {
    const persistenceDb = this.database

    const { cachedRepos } = tablesOf(persistenceDb)
    const rows = await this.executor.all<RawCachedRepoRow & Record<string, unknown>>(
      sql`
      SELECT ${cachedRepoSelect(persistenceDb)}
      FROM ${cachedRepos}
      WHERE ${cachedRepos.id} = ${id}
      LIMIT 1
    `,
      {
        last_fetched_at: 'int',
        created_at: 'int',
        has_submodules: 'bool',
        last_submodule_sync_ok: 'bool',
        last_auto_refresh_at: 'int',
      },
    )
    return rows[0] === undefined ? null : mapCachedRepository(rows[0])
  }

  async insertCachedRepo(record: CachedRepositoryRecord): Promise<boolean> {
    const persistenceDb = this.database

    const { cachedRepos } = tablesOf(persistenceDb)
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
    const persistenceDb = this.database

    const assignments = patchAssignments(persistenceDb, patch)
    if (assignments.length === 0) return true
    const { cachedRepos } = tablesOf(persistenceDb)
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
    const persistenceDb = this.database

    const { cachedRepos } = tablesOf(persistenceDb)
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
    const persistenceDb = this.database

    const { cachedRepos } = tablesOf(persistenceDb)
    const rows = await this.executor.all<{ count: number }>(
      sql`
      SELECT count(*) AS count FROM ${cachedRepos}
    `,
      { count: 'int' },
    )
    return Number(rows[0]?.count ?? 0)
  }

  async listCachedRepos(): Promise<readonly CachedRepositoryRecord[]> {
    const persistenceDb = this.database

    const { cachedRepos } = tablesOf(persistenceDb)
    const rows = await this.executor.all<RawCachedRepoRow & Record<string, unknown>>(
      sql`
      SELECT ${cachedRepoSelect(persistenceDb)}
      FROM ${cachedRepos}
      ORDER BY ${cachedRepos.lastFetchedAt} DESC, ${cachedRepos.id} DESC
    `,
      {
        last_fetched_at: 'int',
        created_at: 'int',
        has_submodules: 'bool',
        last_submodule_sync_ok: 'bool',
        last_auto_refresh_at: 'int',
      },
    )
    return rows.map(mapCachedRepository)
  }

  private async schedulePayloadRows(): Promise<readonly { launch_payload: string }[]> {
    const persistenceDb = this.database

    const { scheduledTasks } = tablesOf(persistenceDb)
    return await this.executor.all<{ launch_payload: string }>(sql`
      SELECT ${scheduledTasks.launchPayload} AS launch_payload FROM ${scheduledTasks}
    `)
  }

  async cachedRepoReferenceCount(id: string): Promise<number> {
    let count = Number((await this.taskPorts.taskUsage.countTaskReferences([id])).get(id) ?? 0)
    const needle = `"cachedRepoId":${JSON.stringify(id)}`
    for (const row of await this.schedulePayloadRows()) {
      if (row.launch_payload.includes(needle)) count++
    }
    return count
  }

  async cachedRepoReferenceCounts(ids: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (ids.length === 0) return new Map()
    const counts = new Map(await this.taskPorts.taskUsage.countTaskReferences(ids))
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
    const persistenceDb = this.database

    const cachedFacets =
      this.facetsCache !== null &&
      this.facetsCache.expiresAt > Date.now() &&
      this.facetsCache.epoch === currentRepositoryFacetCacheEpoch()
        ? this.facetsCache
        : null
    const scheduleIds =
      cachedFacets?.scheduleIds ?? scheduledReferenceIds(await this.schedulePayloadRows())
    const referenceSnapshot = async () => {
      const { cachedRepos } = tablesOf(persistenceDb)
      const registry = await this.executor.all<{ id: string }>(sql`
        SELECT ${cachedRepos.id} AS id FROM ${cachedRepos}
      `)
      const usage = await this.taskPorts.taskUsage.referencedAmong(registry.map((row) => row.id))
      const referencedIds = new Set(
        registry
          .filter(
            (row) =>
              usage.mounted.has(row.id) ||
              usage.requestedOnly.has(row.id) ||
              scheduleIds.has(row.id),
          )
          .map((row) => row.id),
      )
      return {
        all: registry.length,
        referencedIds,
      }
    }
    const snapshot =
      query.view === 'referenced' || query.view === 'unused' ? await referenceSnapshot() : null
    const conditions: SQLWrapper[] = []
    const term = query.q?.trim() ?? ''
    if (term !== '') {
      const { pattern, escape } = this.engine.likeEscape(term)
      const { cachedRepos } = tablesOf(persistenceDb)
      conditions.push(sql`(
        ${this.engine.likeCaseInsensitive(sql`coalesce(${cachedRepos.urlRedacted}, '<url unavailable>')`, pattern, escape)}
        or ${this.engine.likeCaseInsensitive(cachedRepos.localPath, pattern, escape)}
        or ${this.engine.likeCaseInsensitive(cachedRepos.defaultBranch, pattern, escape)}
      )`)
    }
    const { cachedRepos } = tablesOf(persistenceDb)
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
    const referenced = referencedCondition(persistenceDb, snapshot?.referencedIds ?? new Set())
    if (query.view === 'referenced') conditions.push(referenced)
    if (query.view === 'unused') conditions.push(sql`not ${referenced}`)
    if (query.view === 'attention') conditions.push(attentionCondition(persistenceDb))
    if (query.cursor !== undefined) {
      conditions.push(sql`(
        ${cachedRepos.lastFetchedAt}, ${cachedRepos.id}
      ) < (
        ${query.cursor.lastFetchedAt}, ${query.cursor.id}
      )`)
    }
    const where = conditions.length === 0 ? sql`` : sql`WHERE ${and(...conditions)}`
    const rows = await this.executor.all<RawCachedRepoRow & Record<string, unknown>>(
      sql`
      SELECT ${cachedRepoSelect(persistenceDb)}
      FROM ${cachedRepos}
      ${where}
      ORDER BY ${cachedRepos.lastFetchedAt} DESC, ${cachedRepos.id} DESC
      LIMIT ${query.limit + 1}
    `,
      {
        last_fetched_at: 'int',
        created_at: 'int',
        has_submodules: 'bool',
        last_submodule_sync_ok: 'bool',
        last_auto_refresh_at: 'int',
      },
    )
    const mapped = rows.map(mapCachedRepository)
    const page = mapped.slice(0, query.limit)
    const counts = await this.cachedRepoReferenceCounts(page.map((row) => row.id))
    let facets = cachedFacets?.facets
    if (facets === undefined) {
      const facts = snapshot ?? (await referenceSnapshot())
      const all = facts.all
      const referencedCount = facts.referencedIds.size
      const [attention] = await this.executor.all<{ count: number }>(
        sql`SELECT count(*) AS count FROM ${cachedRepos} WHERE ${attentionCondition(persistenceDb)}`,
        { count: 'int' },
      )
      facets = {
        all,
        referenced: referencedCount,
        attention: Number(attention?.count ?? 0),
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
    const persistenceDb = this.database

    const { cachedRepos } = tablesOf(persistenceDb)
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
    const persistenceDb = this.database

    if (ids.length === 0) return
    const { cachedRepos } = tablesOf(persistenceDb)
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
    const persistenceDb = this.database

    const { cachedRepos } = tablesOf(persistenceDb)
    const rows = await this.executor.all<{ local_path: string }>(sql`
      SELECT ${cachedRepos.localPath} AS local_path FROM ${cachedRepos}
    `)
    return rows.map((row) => row.local_path)
  }

  async groupsReferencingRepo(id: string): Promise<readonly { id: string; name: string }[]> {
    const persistenceDb = this.database

    const { repoGroups, repoGroupNodes } = tablesOf(persistenceDb)
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
    const persistenceDb = this.database

    const { repoGroupNodes } = tablesOf(persistenceDb)
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
    const persistenceDb = this.database

    const { cachedRepos, scheduledTasks } = tablesOf(persistenceDb)
    const [repoRows, sources, scheduleRows] = await Promise.all([
      this.executor.all<RawCachedRepoRow & Record<string, unknown>>(
        sql`
        SELECT ${cachedRepoSelect(persistenceDb)} FROM ${cachedRepos}
      `,
        {
          last_fetched_at: 'int',
          created_at: 'int',
          has_submodules: 'bool',
          last_submodule_sync_ok: 'bool',
          last_auto_refresh_at: 'int',
        },
      ),
      this.taskPorts.sourceSealing.listSources(),
      this.executor.all<{
        id: string
        name: string
        launch_payload: string
        enabled: boolean
      }>(
        sql`
        SELECT ${scheduledTasks.id} AS id, ${scheduledTasks.name} AS name,
          ${scheduledTasks.launchPayload} AS launch_payload,
          ${scheduledTasks.enabled} AS enabled
        FROM ${scheduledTasks}
      `,
        { enabled: 'bool' },
      ),
    ])
    return {
      cachedRepos: repoRows.map(mapCachedRepository),
      taskRepos: sources.mounts,
      tasks: sources.requested.map(({ taskId, ...source }) => ({ id: taskId, ...source })),
      schedules: scheduleRows.map(scheduleOf),
    }
  }

  async readRepositoryGroupSnapshot(): Promise<RepositoryGroupSnapshot> {
    const persistenceDb = this.database

    const { repoGroups, repoGroupNodes, cachedRepos, memories, scheduledTasks } =
      tablesOf(persistenceDb)
    const [groupRows, nodeRows, repoRows, memoryRows, scheduleRows] = await Promise.all([
      this.executor.all<RawRepositoryGroupRow & Record<string, unknown>>(
        sql`
        SELECT ${repoGroups.id} AS id, ${repoGroups.name} AS name,
          ${repoGroups.description} AS description, ${repoGroups.version} AS version,
          ${repoGroups.createdByUserId} AS created_by_user_id,
          ${repoGroups.createdAt} AS created_at, ${repoGroups.updatedAt} AS updated_at,
          ${repoGroups.schemaVersion} AS schema_version
        FROM ${repoGroups}
        ORDER BY ${repoGroups.name}, ${repoGroups.id}
      `,
        { version: 'int', created_at: 'int', updated_at: 'int', schema_version: 'int' },
      ),
      this.executor.all<RawRepositoryGroupNodeRow & Record<string, unknown>>(
        sql`
        SELECT ${repoGroupNodes.groupId} AS group_id, ${repoGroupNodes.path} AS path,
          ${repoGroupNodes.attachmentKind} AS attachment_kind,
          ${repoGroupNodes.cachedRepoId} AS cached_repo_id,
          ${repoGroupNodes.ref} AS ref, ${repoGroupNodes.subdir} AS subdir,
          ${repoGroupNodes.childGroupId} AS child_group_id,
          ${repoGroupNodes.readonly} AS readonly
        FROM ${repoGroupNodes}
        ORDER BY ${repoGroupNodes.groupId}, ${repoGroupNodes.path}
      `,
        { readonly: 'bool' },
      ),
      this.executor.all<{ id: string; url_redacted: string | null }>(sql`
        SELECT ${cachedRepos.id} AS id, ${cachedRepos.urlRedacted} AS url_redacted
        FROM ${cachedRepos}
      `),
      this.executor.all<{ scope_id: string; count: number }>(
        sql`
        SELECT ${memories.scopeId} AS scope_id, count(*) AS count
        FROM ${memories}
        WHERE ${memories.scopeType} = 'repo_group'
          AND ${memories.status} IN ('candidate', 'approved', 'superseded', 'rejected')
          AND ${memories.scopeId} IS NOT NULL
        GROUP BY ${memories.scopeId}
      `,
        { count: 'int' },
      ),
      this.executor.all<{
        id: string
        name: string
        launch_payload: string
        enabled: boolean
      }>(
        sql`
        SELECT ${scheduledTasks.id} AS id, ${scheduledTasks.name} AS name,
          ${scheduledTasks.launchPayload} AS launch_payload,
          ${scheduledTasks.enabled} AS enabled
        FROM ${scheduledTasks}
      `,
        { enabled: 'bool' },
      ),
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
        readonly: row.readonly,
      })),
      repoUrls: new Map(repoRows.map((row) => [row.id, row.url_redacted])),
      boundMemoryCounts: new Map(memoryRows.map((row) => [row.scope_id, Number(row.count)])),
      schedules: scheduleRows.map(scheduleOf),
    }
  }
}
