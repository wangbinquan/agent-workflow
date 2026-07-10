// Repo-related schemas: ref dropdowns, file picker. (RFC-165 retired the
// recent-repos DTOs together with path-mode launches; the pickers now target
// cached URL mirrors — see schemas/cachedRepo.)

import { z } from 'zod'

export const GitRefSchema = z.object({
  sha: z.string(),
  subject: z.string(),
})
export type GitRef = z.infer<typeof GitRefSchema>

export const RepoRefsResponseSchema = z.object({
  /** Local + remote-tracking branches as seen by `git for-each-ref refs/heads refs/remotes`. */
  branches: z.array(z.string()),
  tags: z.array(z.string()),
  /** Most recent commits, newest first. Default 50. */
  recentCommits: z.array(GitRefSchema),
  /** Branch HEAD currently points at, or null when detached. */
  currentBranch: z.string().nullable(),
  /** Default branch heuristic — origin/HEAD if set, else main/master if present. */
  defaultBranch: z.string().nullable(),
  /**
   * `true` once the repo has at least one commit. `git init -b main` alone
   * leaves the unborn `main` ref unresolvable, so the launcher uses this
   * flag to refuse a doomed task launch with a clear inline message
   * (instead of letting `git worktree add` blow up post-submit with
   * `cannot resolve base ref 'main'`).
   */
  hasCommits: z.boolean(),
})
export type RepoRefsResponse = z.infer<typeof RepoRefsResponseSchema>

export const RepoFilesResponseSchema = z.object({
  /** Repo-relative paths from `git ls-files`. */
  files: z.array(z.string()),
})
export type RepoFilesResponse = z.infer<typeof RepoFilesResponseSchema>
