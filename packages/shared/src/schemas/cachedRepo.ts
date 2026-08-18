// RFC-024: Cached Git URL repo entries surfaced to UI via /api/cached-repos.

import { z } from 'zod'

export const CachedRepoSchema = z.object({
  id: z.string(),
  /**
   * RFC-204: the plaintext `url` field is GONE from the wire. `cached_repos` is
   * a global shared pool and `repos:read` sits in the user baseline, so serving
   * the original URL handed every logged-in user (and every narrow PAT) the
   * credentials embedded in other people's private-repo URLs. Clients reuse a
   * mirror by `id` (`StartTask.cachedRepoId`) — the daemon resolves the real
   * URL server-side and it never travels back out.
   */
  urlRedacted: z.string(),
  /**
   * Absolute path on disk, e.g. `~/.agent-workflow/repos/abcd1234-bar`.
   * RFC-204: redacted on the way out — `parseGitUrl` keeps a `?access_token=`
   * query inside `parsed.path`, so historical slugs can embed a token.
   */
  localPath: z.string(),
  /** Default branch detected at clone time. `null` if HEAD was detached / unborn. */
  defaultBranch: z.string().nullable(),
  /** ISO timestamp of last successful `git fetch` (or clone for fresh rows). */
  lastFetchedAt: z.string(),
  /**
   * RFC-210 G7 — last time the background refresh loop touched this mirror.
   * `.default(null)` so pre-RFC-210 rows and fixtures keep parsing (same idiom
   * as the other additive fields here).
   */
  lastAutoRefreshAt: z.string().nullable().default(null),
  /** ISO timestamp of original clone. */
  createdAt: z.string(),
  /** Count of `tasks` rows whose `repoUrl` matches `url`. Joined at query time. */
  referencingTaskCount: z.number().int().nonnegative(),
  // --- RFC-034 submodule recursion ---
  /** Last detected `.gitmodules` presence. `null` when never probed (legacy rows). */
  hasSubmodules: z.boolean().nullable(),
  /** Outcome of the last submodule sync/init pass. `null` when never attempted. */
  lastSubmoduleSyncOk: z.boolean().nullable(),
  /** Redacted stderr from the last failed submodule pass, or `null`. */
  lastSubmoduleSyncError: z.string().nullable(),
})
export type CachedRepo = z.infer<typeof CachedRepoSchema>

export const ListCachedReposResponseSchema = z.object({
  items: z.array(CachedRepoSchema),
})
export type ListCachedReposResponse = z.infer<typeof ListCachedReposResponseSchema>

// --- RFC-311 T28: /api/cached-repos 分页封套 ---------------------------------
// 无参调用保持上面的旧全量 `{items}` 形状（proposal §5 C7,7 个 repo picker
// 消费方零改动）;带任一分页/过滤参数则返回本封套。视图/过滤枚举与前端
// operations 面共用,语义以 `filterRepoOperations` 的既有行为为准（oracle
// 测试锁 SQL 下推与 JS 语义等价）。

export const REPO_LIST_VIEWS = ['all', 'referenced', 'attention', 'unused'] as const
export type RepoListView = (typeof REPO_LIST_VIEWS)[number]
export const REPO_SUBMODULE_FILTERS = ['all', 'with', 'without'] as const
export type RepoSubmoduleFilter = (typeof REPO_SUBMODULE_FILTERS)[number]
export const REPO_AUTO_REFRESH_FILTERS = ['all', 'refreshed', 'never'] as const
export type RepoAutoRefreshFilter = (typeof REPO_AUTO_REFRESH_FILTERS)[number]

/** 面板计数恒为全量视角（不受 q/submodules/autoRefresh 影响）——与既有前端
 *  `repoOperationsFacets(items)` 对全量 items 计数的行为一致。 */
export const CachedRepoFacetsSchema = z.object({
  all: z.number().int().nonnegative(),
  referenced: z.number().int().nonnegative(),
  attention: z.number().int().nonnegative(),
  unused: z.number().int().nonnegative(),
})
export type CachedRepoFacets = z.infer<typeof CachedRepoFacetsSchema>

export const CachedRepoPageSchema = z.object({
  items: z.array(CachedRepoSchema),
  nextCursor: z.string().nullable(),
  facets: CachedRepoFacetsSchema,
})
export type CachedRepoPage = z.infer<typeof CachedRepoPageSchema>

/** GET /api/cached-repos 的分页 query 参数(任一出现即切换到分页封套)。 */
export const CachedRepoPageQuerySchema = z.object({
  q: z.string().optional(),
  view: z.enum(REPO_LIST_VIEWS).optional(),
  submodules: z.enum(REPO_SUBMODULE_FILTERS).optional(),
  autoRefresh: z.enum(REPO_AUTO_REFRESH_FILTERS).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type CachedRepoPageQuery = z.infer<typeof CachedRepoPageQuerySchema>

export const RefreshCachedRepoResponseSchema = z.object({
  item: CachedRepoSchema,
  /** True when `git fetch` came back clean; false when fetch failed but cache still serves. */
  fetchOk: z.boolean(),
  /** Redacted stderr from a failed fetch, if any. */
  fetchError: z.string().nullable(),
  // --- RFC-034 submodule recursion ---
  /** True when `submodule sync && update --init --recursive` succeeded. */
  submoduleSyncOk: z.boolean(),
  /** Redacted stderr from a failed submodule pass, if any. */
  submoduleSyncError: z.string().nullable(),
  /** Detected `.gitmodules` presence after this refresh. */
  hasSubmodules: z.boolean(),
})
export type RefreshCachedRepoResponse = z.infer<typeof RefreshCachedRepoResponseSchema>

export const DeleteCachedRepoQuerySchema = z.object({
  force: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional(),
})
export type DeleteCachedRepoQuery = z.infer<typeof DeleteCachedRepoQuerySchema>
