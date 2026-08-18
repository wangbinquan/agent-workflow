import type {
  RepositoryCommitCandidateParticipant,
  RepositoryCommitPublicationParticipant,
  WorkspaceExcludeParticipant,
} from './public/participants'
import type { RepositoryPublishMode } from './public/types'
import { ensureWorkspaceExcludeProfile } from './infrastructure/workspaceExcludeManager'
import {
  prepareRepositoryCommit,
  commitPreparedRepository,
  classifyRepositoryCommitPath,
  publishRepositoryCommit,
  readRepositoryCommitPreview,
  resolvePushBase,
  updateRepositoryRef,
  type RepositoryGit,
} from './application/repositoryCommit'
import { ensurePlatformWorkspaceDirectory } from './infrastructure/platformWorkspaceDirectory'
import { deriveChangeCandidate } from './application/changeCandidate'
import type { PlatformWorkspaceKind } from '@agent-workflow/shared'

/** RFC-308 temporary composition seam until RFC-294 W5 owns durable WorkspaceRef. */
export function bindWorkspaceExcludeParticipant(input: {
  worktreePath: string
  appHome?: string
}): WorkspaceExcludeParticipant {
  return {
    ensure: (request = {}) =>
      ensureWorkspaceExcludeProfile({
        ...input,
        directChildMounts: request.directChildMounts ?? [],
      }),
  }
}

/**
 * RFC-308 temporary path binder. Consumers receive operations bound to one
 * repository and one immutable settings slice; Git mechanics stay private to
 * source-control. RFC-294 W5 replaces the absolute-path binding with WorkspaceRef.
 */
export function bindRepositoryCommitParticipant(input: {
  repoPath: string
  configuredPatterns?: readonly string[]
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): RepositoryCommitCandidateParticipant & RepositoryCommitPublicationParticipant {
  const common = {
    repoPath: input.repoPath,
    configuredPatterns: input.configuredPatterns ?? [],
    ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  }
  return {
    prepare: () => prepareRepositoryCommit(common),
    commitPrepared: (request: {
      message: string
      verification: 'normal' | 'artifact'
      authorName?: string | null
      authorEmail?: string | null
    }) => commitPreparedRepository({ ...common, ...request }),
    preview: () => readRepositoryCommitPreview(common),
    publish: (request: { baseSha: string; tipSha: string; mode: RepositoryPublishMode }) =>
      publishRepositoryCommit({ ...common, ...request }),
    resolvePushBase: (request: { remote: string; branch: string; fallbackRef: string }) =>
      resolvePushBase({
        repoPath: input.repoPath,
        ...request,
        ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
      }),
    classifyPath: (request: { path: string; directory?: boolean }) =>
      classifyRepositoryCommitPath({ ...common, ...request }),
    updateRef: (request: { ref: string; commitSha?: string }) =>
      updateRepositoryRef({
        repoPath: input.repoPath,
        ...request,
        ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
        ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
      }),
  }
}

/** RFC-308 composition-only path binding; absolute path never enters public DTOs. */
export function ensureBoundPlatformWorkspaceDirectory(input: {
  worktreePath: string
  kind: PlatformWorkspaceKind
  segments?: readonly string[]
}): string {
  return ensurePlatformWorkspaceDirectory(input)
}

/**
 * RFC-310 PR-4 T48 —— ChangeCandidate 派生的组装（development-automation 以
 * 结构同形端口接收；两模块互不 import 对方内部，同 requirementSource 先例）。
 */
export function bindChangeCandidateParticipant(): {
  derive: typeof deriveChangeCandidate
} {
  return { derive: deriveChangeCandidate }
}
