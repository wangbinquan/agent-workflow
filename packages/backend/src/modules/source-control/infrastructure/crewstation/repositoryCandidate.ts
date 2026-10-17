// RFC-370 §9.2 V3 — candidate use cases on a hosted task volume.
//
// Each use case (derive, stage, commit, push) is ONE task-image command whose
// handler runs the same application function with native step effects against
// `/work`. Hosted references are translated to volume paths here and back for
// the one result that carries a path (the staged tree).
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { RepositoryCandidateOperationHost } from '../../application/ports/repositoryCandidateOperations'
import type { StageCandidateTreeResult } from '../../application/changeCandidate'
import { assertHostedRepositoryUrl } from './repositoryUrl'
import { hostedVolumePaths, hostedWorkspaceReference } from './workspaceReference'

export const HOSTED_CANDIDATE_OPERATIONS = [
  'candidate-derive',
  'candidate-stage',
  'candidate-discard',
  'candidate-commit',
  'candidate-push',
] as const

export function createHostedRepositoryCandidateOperations(input: {
  readonly helper: WorkspaceHelper
  /** In-process writer holds: a staged tree a command still writes is kept. */
  readonly writerHeld?: (reference: string) => boolean
}): RepositoryCandidateOperationHost {
  return {
    operations: {
      derive(request) {
        const { runGit: _local, ...rest } = request
        const volume = hostedVolumePaths({
          baselineRepoPath: request.baselineRepoPath,
          overlayRoot: request.overlayRoot,
        })
        return input.helper.call(volume.owner, 'candidate-derive', { ...rest, ...volume.paths })
      },
      async stage(request) {
        const { runGit: _local, ...rest } = request
        const volume = hostedVolumePaths({
          baselineRepoPath: request.baselineRepoPath,
          overlayRoot: request.overlayRoot,
        })
        const staged = await input.helper.call<
          | { readonly ok: true; readonly ws: string; readonly treeOid: string }
          | Extract<StageCandidateTreeResult, { ok: false }>
        >(volume.owner, 'candidate-stage', { ...rest, ...volume.paths })
        if (!staged.ok) return staged
        const ws = hostedWorkspaceReference(volume.owner, staged.ws)
        let discarded = false
        return {
          ok: true,
          ws,
          treeOid: staged.treeOid,
          async cleanup() {
            if (discarded) return
            if (input.writerHeld?.(ws) === true)
              throw new Error('hosted-workspace-writer-not-settled')
            await input.helper.call(volume.owner, 'candidate-discard', { ws: staged.ws })
            discarded = true
          },
        }
      },
      commit(request) {
        const { runGit: _local, ...rest } = request
        const volume = hostedVolumePaths({
          baselineRepoPath: request.baselineRepoPath,
          overlayRoot: request.overlayRoot,
        })
        return input.helper.call(volume.owner, 'candidate-commit', { ...rest, ...volume.paths })
      },
      push(request) {
        const { runGit: _local, publicationTransport: _transport, ...rest } = request
        // The volume authenticates with the platform's Git credential bindings;
        // a credential must never travel inside the persisted command request.
        assertHostedRepositoryUrl(request.remoteUrl)
        const volume = hostedVolumePaths({ baselineRepoPath: request.baselineRepoPath })
        return input.helper.call(volume.owner, 'candidate-push', { ...rest, ...volume.paths })
      },
    },
  }
}
