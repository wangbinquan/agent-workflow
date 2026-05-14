// Repo-related schemas: recent list, ref dropdowns, file picker.

import { z } from 'zod'

export const RecentRepoSchema = z.object({
  /** Absolute path on the host. */
  path: z.string(),
  /** Last time this repo was used to launch a task. */
  lastUsedAt: z.number().int(),
  /** Default branch detected at registration time (e.g. 'main'). */
  defaultBranch: z.string().optional(),
})
export type RecentRepo = z.infer<typeof RecentRepoSchema>

export const UpsertRecentRepoSchema = z.object({
  path: z.string().min(1),
})
export type UpsertRecentRepo = z.infer<typeof UpsertRecentRepoSchema>

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
})
export type RepoRefsResponse = z.infer<typeof RepoRefsResponseSchema>

export const RepoFilesResponseSchema = z.object({
  /** Repo-relative paths from `git ls-files`. */
  files: z.array(z.string()),
})
export type RepoFilesResponse = z.infer<typeof RepoFilesResponseSchema>
