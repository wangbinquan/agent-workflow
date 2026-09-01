import type {
  RepoAutoRefreshFilter,
  RepoListView,
  RepoSubmoduleFilter,
} from '@agent-workflow/shared'

let repositoryFacetCacheEpoch = 0

export function currentRepositoryFacetCacheEpoch(): number {
  return repositoryFacetCacheEpoch
}

export function invalidateRepositoryWorkspaceFacetCaches(): void {
  repositoryFacetCacheEpoch += 1
}

export interface CachedRepositoryRecord {
  readonly id: string
  readonly urlHash: string
  readonly urlEnc: string | null
  readonly urlRedacted: string | null
  readonly localPath: string
  readonly defaultBranch: string | null
  readonly lastFetchedAt: number
  readonly createdAt: number
  readonly hasSubmodules: boolean | null
  readonly lastSubmoduleSyncOk: boolean | null
  readonly lastSubmoduleSyncError: string | null
  readonly lastAutoRefreshAt: number | null
}

export type CachedRepositoryPatch = Partial<
  Pick<
    CachedRepositoryRecord,
    | 'urlHash'
    | 'urlEnc'
    | 'urlRedacted'
    | 'localPath'
    | 'defaultBranch'
    | 'lastFetchedAt'
    | 'hasSubmodules'
    | 'lastSubmoduleSyncOk'
    | 'lastSubmoduleSyncError'
    | 'lastAutoRefreshAt'
  >
>

export interface CachedRepositoryPageQuery {
  readonly q?: string
  readonly view?: RepoListView
  readonly submodules?: RepoSubmoduleFilter
  readonly autoRefresh?: RepoAutoRefreshFilter
  readonly cursor?: { readonly lastFetchedAt: number; readonly id: string }
  readonly limit: number
}

export interface CachedRepositoryPageRecords {
  readonly rows: readonly CachedRepositoryRecord[]
  readonly hasMore: boolean
  readonly referenceCounts: ReadonlyMap<string, number>
  readonly facets: {
    readonly all: number
    readonly referenced: number
    readonly attention: number
    readonly unused: number
  }
}

export interface RepositoryCredentialTaskRepoRecord {
  readonly taskId: string
  readonly repoIndex: number
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
  readonly submoduleInitError: string | null
}

export interface RepositoryCredentialTaskRecord {
  readonly id: string
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
}

export interface RepositoryScheduleRecord {
  readonly id: string
  readonly name: string
  readonly launchPayload: string
  readonly enabled: boolean
}

export interface RepositoryCredentialSealingSnapshot {
  readonly cachedRepos: readonly CachedRepositoryRecord[]
  readonly taskRepos: readonly RepositoryCredentialTaskRepoRecord[]
  readonly tasks: readonly RepositoryCredentialTaskRecord[]
  readonly schedules: readonly RepositoryScheduleRecord[]
}

export interface RepositoryCredentialSealingMutation {
  readonly cachedRepoUpdates: readonly {
    readonly id: string
    readonly patch: CachedRepositoryPatch
  }[]
  readonly taskRepoUpdates: readonly {
    readonly taskId: string
    readonly repoIndex: number
    readonly patch: Partial<
      Pick<RepositoryCredentialTaskRepoRecord, 'cachedRepoId' | 'repoUrl' | 'submoduleInitError'>
    >
  }[]
  readonly taskUpdates: readonly {
    readonly id: string
    readonly patch: Partial<Pick<RepositoryCredentialTaskRecord, 'cachedRepoId' | 'repoUrl'>>
  }[]
  readonly scheduleUpdates: readonly {
    readonly id: string
    readonly launchPayload: string
  }[]
}

export interface RepositoryGroupRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: number
  readonly createdByUserId: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly schemaVersion: number
}

export interface RepositoryGroupNodeRecord {
  readonly groupId: string
  readonly path: string
  readonly attachmentKind: 'repo' | 'group' | null
  readonly cachedRepoId: string | null
  readonly ref: string
  readonly subdir: string
  readonly childGroupId: string | null
  readonly readonly: boolean
}

export interface RepositoryGroupSnapshot {
  readonly groups: readonly RepositoryGroupRecord[]
  readonly nodes: readonly RepositoryGroupNodeRecord[]
  readonly repoUrls: ReadonlyMap<string, string | null>
  readonly boundMemoryCounts: ReadonlyMap<string, number>
  readonly schedules: readonly RepositoryScheduleRecord[]
}

export type RepositoryGroupWriteResult =
  | { readonly status: 'ok'; readonly version: number }
  | { readonly status: 'missing' }
  | { readonly status: 'name-conflict' }
  | { readonly status: 'stale'; readonly actualVersion: number }
  | { readonly status: 'graph-stale' }

export type RepositoryGroupDeleteResult =
  | {
      readonly status: 'ok'
      readonly archivedMemories: number
      readonly detachedReferences: number
      readonly disabledSchedules: number
    }
  | { readonly status: 'graph-stale' }

export interface WorktreeTaskRepositoryRecord {
  readonly repoIndex: number
  readonly worktreePath: string
  readonly baseCommit: string | null
  readonly mountPath: string
}

export interface WorktreeTaskRecord {
  readonly id: string
  readonly ownerUserId: string | null
  readonly worktreePath: string
  readonly baseCommit: string | null
  readonly repos: readonly WorktreeTaskRepositoryRecord[]
}

/**
 * Provider-neutral persistence boundary for cached repositories, repository
 * groups, credential sealing and worktree projections.  Implementations own
 * all Drizzle/provider mechanics; services receive only Promise records.
 */
export interface RepositoryWorkspaceStore {
  /** Stable runtime identity for in-process coalescing and volatile credentials. */
  readonly runtimeIdentity: object

  findCachedRepoByHash(hash: string): Promise<CachedRepositoryRecord | null>
  findCachedRepoById(id: string): Promise<CachedRepositoryRecord | null>
  insertCachedRepo(record: CachedRepositoryRecord): Promise<boolean>
  updateCachedRepo(
    id: string,
    patch: CachedRepositoryPatch,
    expectedUrlHash?: string,
  ): Promise<boolean>
  upsertCachedRepo(record: CachedRepositoryRecord): Promise<void>
  countCachedRepos(): Promise<number>
  listCachedRepos(): Promise<readonly CachedRepositoryRecord[]>
  cachedRepoReferenceCount(id: string): Promise<number>
  cachedRepoReferenceCounts(ids: readonly string[]): Promise<ReadonlyMap<string, number>>
  listCachedRepoPage(query: CachedRepositoryPageQuery): Promise<CachedRepositoryPageRecords>
  invalidateCachedRepoFacets(): void
  listDueCachedRepos(input: {
    readonly dueBefore: number
    readonly freshAfter: number
  }): Promise<readonly Pick<CachedRepositoryRecord, 'id' | 'urlRedacted'>[]>
  stampAutoRefreshed(ids: readonly string[], at: number): Promise<void>
  listKnownRepositoryPaths(): Promise<readonly string[]>
  groupsReferencingRepo(id: string): Promise<readonly { id: string; name: string }[]>
  detachRepoFromAllGroups(id: string): Promise<number>
  deleteCachedRepoAndDetachGroups(id: string): Promise<void>

  readCredentialSealingSnapshot(): Promise<RepositoryCredentialSealingSnapshot>
  applyCredentialSealingMutation(mutation: RepositoryCredentialSealingMutation): Promise<void>
  compactAfterCredentialScrub(): Promise<void>

  readRepositoryGroupSnapshot(): Promise<RepositoryGroupSnapshot>
  createRepositoryGroup(
    group: RepositoryGroupRecord,
    nodes: readonly RepositoryGroupNodeRecord[],
  ): Promise<'created' | 'name-conflict'>
  updateRepositoryGroup(input: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly expectedVersion?: number
    /** Optimistic graph snapshot used to preserve cycle/ancestor validation
     * across the application-to-transaction boundary. */
    readonly expectedGraphVersions: readonly {
      readonly id: string
      readonly version: number
    }[]
    readonly updatedAt: number
    readonly nodes: readonly RepositoryGroupNodeRecord[]
  }): Promise<RepositoryGroupWriteResult>
  deleteRepositoryGroup(input: {
    readonly id: string
    readonly scheduleIds: readonly string[]
    readonly expectedGraphVersions: readonly {
      readonly id: string
      readonly version: number
    }[]
  }): Promise<RepositoryGroupDeleteResult>

  findWorktreeTask(id: string): Promise<WorktreeTaskRecord | null>
}
