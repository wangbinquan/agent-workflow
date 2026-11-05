// On-demand git introspection for the launcher pickers (refs / files views
// over the cached URL mirrors — RFC-110 maps a typed URL to its mirror's
// localPath and queries these). RFC-165 retired the recent_repos surface
// (path-mode launches are gone; local repos ride file:// URLs through the
// cached-repos mirror instead).
//
// RFC-446: moved from services/repo.ts — these read a mirror directory on the
// daemon's own disk, so they are source-control's local adapter. The legacy
// `?path=` form's known-mirror check moved here from routes/repos.ts and now
// guards the `RepositoryMirrors.local` reads it always preceded.

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
import { ValidationError } from '@/util/errors'
import type { RepositoryMirrors } from '../../application/ports/repositoryMirrors'

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

/**
 * The `?path=` reads of a standalone daemon: `path` must lie inside a
 * registered mirror directory (`knownPaths`, read on every call) before git
 * runs; otherwise `repo-path-unknown`. RFC-099 audit (2026-07-15): `path` is
 * attacker-controllable and repos:read is in the user baseline, so a user must
 * not enumerate arbitrary host git repos.
 */
export function createKnownPathRepositoryReads(
  knownPaths: () => Promise<readonly string[]>,
): NonNullable<RepositoryMirrors['local']> {
  const requireKnownPath = async (path: string): Promise<void> => {
    if (!isKnownRepoPath(await knownPaths(), path)) {
      throw new ValidationError('repo-path-unknown', 'path is not a known cached repository')
    }
  }
  return {
    async refs(path) {
      await requireKnownPath(path)
      return await getRepoRefs(path)
    },
    async files(path) {
      await requireKnownPath(path)
      return await getRepoFiles(path)
    },
  }
}
