import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { ConflictMergeWorkspaceEffects } from '../../application/ports/conflictMergeWorkspaceEffects'
import { hostedWorkspaceReference, parseHostedWorkspaceReference } from './workspaceReference'

export function createHostedConflictMergeEffects(
  helper: WorkspaceHelper,
): ConflictMergeWorkspaceEffects {
  const call = <T>(reference: string, method: string, args: unknown[] = []) => {
    const workspace = parseHostedWorkspaceReference(reference)
    return helper.call<T>(workspace.taskId, 'conflict-workspace', {
      workspaceReference: workspace.path,
      method,
      args,
    })
  }
  return {
    async allocate(_storageRootReference, baselineReference) {
      if (baselineReference === undefined) throw new Error('hosted-conflict-baseline-required')
      const baseline = parseHostedWorkspaceReference(baselineReference)
      const path = await helper.call<string>(baseline.taskId, 'conflict-allocate', {})
      return hostedWorkspaceReference(baseline.taskId, path)
    },
    cloneBaseline(workspaceReference, baselineReference) {
      const workspace = parseHostedWorkspaceReference(workspaceReference)
      const baseline = parseHostedWorkspaceReference(baselineReference)
      if (workspace.taskId !== baseline.taskId) throw new Error('hosted-conflict-volume-mismatch')
      return call(workspaceReference, 'cloneBaseline', [baseline.path])
    },
    run(reference, args, options) {
      const workspace = parseHostedWorkspaceReference(reference)
      const { signal, ...serializable } = options ?? {}
      return helper.call(
        workspace.taskId,
        'git',
        { path: workspace.path, args, options: serializable },
        {
          signal,
          timeoutMs: options?.timeoutMs,
        },
      )
    },
    installPlatformExclude: (reference) => call(reference, 'installPlatformExclude'),
    readConflictFile: (reference, path) => call(reference, 'readConflictFile', [path]),
    mergeHeadExists: (reference) => call(reference, 'mergeHeadExists'),
    discard: (reference) => call(reference, 'discard'),
  }
}
