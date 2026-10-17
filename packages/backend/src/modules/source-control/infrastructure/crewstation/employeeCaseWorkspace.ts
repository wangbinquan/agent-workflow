// RFC-370 §9.2 V3 — employee Case workspace use cases on a hosted task volume.
//
// Each use case is ONE task-image command (`employee-case`) whose handler runs
// the same application function with native step effects against `/work`.
// Hosted references are translated to volume paths here; results that carry a
// workspace path are translated back to references of the same volume.
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { EmployeeCaseWorkspaceOperationHost } from '../../application/ports/employeeCaseWorkspaceOperations'
import { assertHostedRepositoryUrl } from './repositoryUrl'
import { hostedVolumePaths, hostedWorkspaceReference } from './workspaceReference'

export const HOSTED_EMPLOYEE_CASE_OPERATION = 'employee-case'

export function createHostedEmployeeCaseWorkspaceOperations(input: {
  readonly helper: WorkspaceHelper
}): EmployeeCaseWorkspaceOperationHost {
  const run = <T>(owner: string, method: string, value: unknown) =>
    input.helper.call<T>(owner, HOSTED_EMPLOYEE_CASE_OPERATION, { method, input: value })
  const scene = async (
    owner: string,
    method: string,
    value: unknown,
  ): Promise<{ readonly workspacePath: string }> => {
    const result = await run<{ readonly workspacePath: string }>(owner, method, value)
    return { workspacePath: hostedWorkspaceReference(owner, result.workspacePath) }
  }
  return {
    operations: {
      materialize(request) {
        const volume = hostedVolumePaths({
          caseRoot: request.caseRoot,
          baselineRepoPath: request.baselineRepoPath,
        })
        return scene(volume.owner, 'materialize', { ...request, ...volume.paths })
      },
      rematerialize(request) {
        const volume = hostedVolumePaths({
          caseRoot: request.caseRoot,
          baselineRepoPath: request.baselineRepoPath,
          currentWorkspacePath: request.currentWorkspacePath,
        })
        return scene(volume.owner, 'rematerialize', { ...request, ...volume.paths })
      },
      fetchRemoteHead(request) {
        const { publicationTransport: _transport, ...rest } = request
        // The volume authenticates with the platform's Git credential bindings;
        // a credential must never travel inside the persisted command request.
        assertHostedRepositoryUrl(request.remoteUrl)
        const volume = hostedVolumePaths({ baselineRepoPath: request.baselineRepoPath })
        return run(volume.owner, 'fetchRemoteHead', { ...rest, ...volume.paths })
      },
      checkpoint(request) {
        const volume = hostedVolumePaths({
          workspacePath: request.workspacePath,
          checkpointRoot: request.checkpointRoot,
        })
        return run(volume.owner, 'checkpoint', { ...request, ...volume.paths })
      },
      restore(request) {
        const volume = hostedVolumePaths({
          caseRoot: request.caseRoot,
          baselineRepoPath: request.baselineRepoPath,
          checkpointRoot: request.checkpointRoot,
        })
        return scene(volume.owner, 'restore', { ...request, ...volume.paths })
      },
      async discard(caseRoot) {
        const volume = hostedVolumePaths({ caseRoot })
        await run(volume.owner, 'discard', volume.paths)
      },
      resolveBaseline(request) {
        const volume = hostedVolumePaths({ baselineRepoPath: request.baselineRepoPath })
        return run(volume.owner, 'resolveBaseline', { ...request, ...volume.paths })
      },
      async importCommit(request) {
        const volume = hostedVolumePaths({
          baselineRepoPath: request.baselineRepoPath,
          sourceRepoPath: request.sourceRepoPath,
        })
        await run(volume.owner, 'importCommit', { ...request, ...volume.paths })
      },
    },
  }
}
