import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  IsolationWorkspaceFactory,
  IsolationWorkspaceScope,
  IsolationWorkspaceBinding,
  IsolationConflict,
} from '../../application/ports/isolationWorkspace'
import { hostedWorkspaceReference, parseHostedWorkspaceReference } from './workspaceReference'
import {
  MergeAgentChildUnreapedError,
  type PreparedConflictResolution,
  type ResolveConflictOutcome,
} from '@/platform/workspace/local/isolation'

/** Only adapter-owned physical descriptions cross the helper boundary. */
export function mapHostedWorkspacePaths<T>(
  value: T,
  direction: 'native' | 'hosted',
  taskId: string,
): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      if (direction === 'native' && item.startsWith('cs-workspace:')) {
        const reference = parseHostedWorkspaceReference(item)
        if (reference.taskId !== taskId) throw new Error('hosted-workspace-owner-mismatch')
        return reference.path
      }
      if (direction === 'hosted' && (item === '/work' || item.startsWith('/work/')))
        return hostedWorkspaceReference(taskId, item)
      return item
    }
    if (Array.isArray(item)) return item.map(visit)
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]))
    return item
  }
  return visit(value) as T
}

export function createHostedIsolationWorkspaces(
  helper: WorkspaceHelper,
): IsolationWorkspaceFactory {
  return {
    bind(binding) {
      const volumeTaskId =
        binding.repositories.length === 0
          ? binding.taskId
          : parseHostedWorkspaceReference(binding.repositories[0]!.workspaceRef).taskId
      const nativeBinding: IsolationWorkspaceBinding = {
        ...mapHostedWorkspacePaths({ ...binding, storageRootRef: '/work' }, 'native', volumeTaskId),
        storageRootRef: '/work',
      }
      const call = async <T>(method: string, args: readonly unknown[]): Promise<T> => {
        const result = await helper.call<T>(volumeTaskId, 'isolation', {
          binding: nativeBinding,
          method,
          args: mapHostedWorkspacePaths(args, 'native', volumeTaskId),
        })
        return mapHostedWorkspacePaths(result, 'hosted', volumeTaskId)
      }
      return {
        recoverKey: (reference, rowId) => call('recoverKey', [reference, rowId]),
        chooseGeneration: (baseKey) => call('chooseGeneration', [baseKey]),
        create: ({ log: _log, ...request }) => call('create', [request]),
        restore: (request) => call('restore', [request]),
        head: (reference) => call('head', [reference]),
        submodulePresence: (reference) => call('submodulePresence', [reference]),
        changedFiles: (reference, baseline) => call('changedFiles', [reference, baseline]),
        blobHashes: (reference, paths) => call('blobHashes', [reference, paths]),
        // The request is JSON: a positional `undefined` would arrive as null, so
        // "no extra forced paths" is sent as the empty list it means.
        snapshot: (workspace, _log, paths) => call('snapshot', [workspace, null, paths ?? []]),
        async merge(workspace, trees, _log, resolveSubConflict) {
          if (resolveSubConflict === undefined) return call('merge', [workspace, trees])
          const answers: [string, boolean][] = []
          let current = workspace
          for (;;) {
            const step = await call<{
              result: Awaited<ReturnType<IsolationWorkspaceScope['merge']>>
              pending: { key: string; conflict: IsolationConflict } | null
            }>('merge-step', [current, trees, answers])
            current = step.result.workspace
            if (step.pending === null) return step.result
            // A thrown/unreaped resolver interrupts the merge. No fabricated
            // failure answer is published while its writer may still be alive.
            const outcome = await resolveSubConflict(step.pending.conflict)
            answers.push([step.pending.key, outcome.resolved])
          }
        },
        undoShard: ({ log: _log, ...request }) => call('undoShard', [request]),
        async discard(workspace, _log, writeWindow, onProgress) {
          const discard = async () => {
            const result = await call<void | { readonly retained: true }>('discard', [workspace])
            onProgress?.(0)
            return result
          }
          if (writeWindow === undefined) return discard()
          return writeWindow.run(discard)
        },
        async resolveConflict(conflict, request) {
          const prepared = await helper.call<PreparedConflictResolution>(
            volumeTaskId,
            'isolation-conflict-prepare',
            {
              conflict: mapHostedWorkspacePaths(conflict, 'native', volumeTaskId),
              containerRef: mapHostedWorkspacePaths(request.containerRef, 'native', volumeTaskId),
            },
          )
          let result: ResolveConflictOutcome
          if (prepared.kind === 'parked') result = prepared.outcome
          else {
            let agentError: string | undefined
            try {
              await request.runAgent(
                prepared.prompt,
                hostedWorkspaceReference(volumeTaskId, prepared.resolveIso),
                prepared.manifest,
              )
            } catch (error) {
              // A still-running writer is a hard barrier. Preserve the resolve
              // workspace and do not publish or start another resolver.
              if (error instanceof MergeAgentChildUnreapedError) throw error
              agentError = error instanceof Error ? error.message : String(error)
            }
            result = await helper.call(volumeTaskId, 'isolation-conflict-finish', {
              prepared,
              agentError,
            })
          }
          return {
            resolved: result.resolved,
            unresolved: result.unresolved,
            resolveWorkspaceRef:
              result.resolveIsoPath === null
                ? null
                : hostedWorkspaceReference(volumeTaskId, result.resolveIsoPath),
          }
        },
        completeHumanConflict: (workspace, trees) =>
          call('completeHumanConflict', [workspace, trees]),
      } satisfies IsolationWorkspaceScope
    },
  }
}
