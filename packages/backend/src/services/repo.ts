// On-demand git introspection for the launcher pickers (refs / files views
// over the cached URL mirrors — RFC-110 maps a typed URL to its mirror's
// localPath and queries these). RFC-165 retired the recent_repos surface
// (path-mode launches are gone; local repos ride file:// URLs through the
// cached-repos mirror instead).

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
