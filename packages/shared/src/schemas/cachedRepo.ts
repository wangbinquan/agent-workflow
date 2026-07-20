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
