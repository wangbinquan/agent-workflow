// RFC-308 — the bound commit + publication surface of one repository (moved
// out of the module root `composition.ts` by RFC-475 so the workspace change
// publication binder can take it without the root's whole import graph; the
// root still re-exports it).
import type {
  RepositoryCommitCandidateParticipant,
  RepositoryCommitPublicationParticipant,
} from '../public/participants'
import type { RepositoryPublishMode } from '../public/types'
import {
  prepareRepositoryCommit,
  commitPreparedRepository,
  classifyRepositoryCommitPath,
  publishRepositoryCommit,
  readRepositoryCommitPreview,
  resolvePushBase,
  updateRepositoryRef,
  type RepositoryGit,
} from '../application/repositoryCommit'
import { createFileRepositoryPreviewIndexPort } from '../infrastructure/local/fileRepositoryPreviewIndex'
import type { RepositoryPreviewIndexPort } from '../application/ports/repositoryPreviewIndex'
import type { RepositoryGitWorkspaceScope } from '../application/ports/repositoryGitWorkspace'
import { requireRepositoryGitWorkspaceScope } from './repositoryGitWorkspaces'

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
  previewIndex?: RepositoryPreviewIndexPort
  gitWorkspace?: RepositoryGitWorkspaceScope
  runNetworkGit?: RepositoryGit
}): RepositoryCommitCandidateParticipant & RepositoryCommitPublicationParticipant {
  const workspace = input.gitWorkspace
  if (workspace !== undefined) requireRepositoryGitWorkspaceScope(workspace)
  const runGit: RepositoryGit | undefined =
    workspace === undefined
      ? input.runGit
      : (_repoPath, args, options) => workspace.run(args, options)
  const common = {
    repoPath: input.repoPath,
    configuredPatterns: input.configuredPatterns ?? [],
    ...(runGit !== undefined ? { runGit } : {}),
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  }
  const previewIndex: RepositoryPreviewIndexPort =
    workspace === undefined
      ? (input.previewIndex ?? createFileRepositoryPreviewIndexPort(common))
      : { withIndex: (operation) => workspace.withPreviewIndex(operation, common.gitOptions) }
  // RFC-370 §9.2 V3: a scope whose repository lives in a remote volume runs
  // each commit use case there as one operation.
  const operations = workspace?.commitOperations
  const portableOptions = (() => {
    if (input.gitOptions === undefined) return {}
    const { signal: _signal, ...gitOptions } = input.gitOptions
    return { gitOptions }
  })()
  return {
    prepare: () =>
      operations !== undefined
        ? operations.prepare({ configuredPatterns: common.configuredPatterns, ...portableOptions })
        : prepareRepositoryCommit(common),
    commitPrepared: (request: {
      message: string
      verification: 'normal' | 'artifact'
      authorName?: string | null
      authorEmail?: string | null
      preparedTree?: string
    }) =>
      operations !== undefined
        ? operations.commitPrepared({ ...request, ...portableOptions })
        : commitPreparedRepository({ ...common, ...request }),
    preview: () =>
      operations !== undefined
        ? operations.preview({ configuredPatterns: common.configuredPatterns, ...portableOptions })
        : readRepositoryCommitPreview({ ...common, previewIndex }),
    publish: (request: { baseSha: string; tipSha: string; mode: RepositoryPublishMode }) =>
      publishRepositoryCommit({
        ...common,
        ...request,
        ...(input.runNetworkGit === undefined ? {} : { runNetworkGit: input.runNetworkGit }),
      }),
    resolvePushBase: (request: { remote: string; branch: string; fallbackRef: string }) =>
      resolvePushBase({
        repoPath: input.repoPath,
        ...request,
        ...(workspace === undefined
          ? input.runGit !== undefined
            ? { runGit: input.runGit }
            : {}
          : { runGit }),
      }),
    classifyPath: (request: { path: string; directory?: boolean }) =>
      classifyRepositoryCommitPath({ ...common, ...request }),
    updateRef: (request: { ref: string; commitSha?: string }) =>
      updateRepositoryRef({
        repoPath: input.repoPath,
        ...request,
        ...(workspace === undefined
          ? input.runGit !== undefined
            ? { runGit: input.runGit }
            : {}
          : { runGit }),
        ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
      }),
  }
}
