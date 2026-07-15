// On-demand git introspection for the launcher pickers (refs / files views
// over the cached URL mirrors — RFC-110 maps a typed URL to its mirror's
// localPath and queries these). RFC-165 retired the recent_repos surface
// (path-mode launches are gone; local repos ride file:// URLs through the
// cached-repos mirror instead).

import { resolve, sep } from 'node:path'
import type { RepoFilesResponse, RepoRefsResponse } from '@agent-workflow/shared'
import {
  currentBranch,
  defaultBranch,
  listBranches,
  listFiles,
  listTags,
  recentCommits,
  requireGitRepo,
} from '@/util/git'

/**
 * RFC-099 audit (2026-07-15): the refs/files pickers must only introspect a
 * repo the caller already reached through the cached-mirror model — NOT an
 * arbitrary host path. The `path` query param is attacker-controllable, so it
 * must resolve to a known cached_repos.localPath (or a directory under one).
 * resolve() first so `/mirror/../../etc/secret` can't ride a lexical prefix
 * match past the containment check.
 */
export function isKnownRepoPath(knownLocalPaths: readonly string[], path: string): boolean {
  const target = resolve(path)
  return knownLocalPaths.some((lp) => {
    const root = resolve(lp)
    return target === root || target.startsWith(root + sep)
  })
}

// --- read-only views over a repo ---

export async function getRepoRefs(repoPath: string, commitCount = 50): Promise<RepoRefsResponse> {
  await requireGitRepo(repoPath)
  const [branches, tags, commits, current, def] = await Promise.all([
    listBranches(repoPath),
    listTags(repoPath),
    recentCommits(repoPath, commitCount),
    currentBranch(repoPath),
    defaultBranch(repoPath),
  ])
  return {
    branches,
    tags,
    recentCommits: commits,
    currentBranch: current,
    defaultBranch: def,
    hasCommits: commits.length > 0,
  }
}

export async function getRepoFiles(repoPath: string): Promise<RepoFilesResponse> {
  await requireGitRepo(repoPath)
  const files = await listFiles(repoPath)
  return { files }
}
