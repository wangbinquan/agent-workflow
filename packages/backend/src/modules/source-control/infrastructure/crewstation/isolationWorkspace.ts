import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  IsolationWorkspaceFactory,
  IsolationWorkspaceScope,
  IsolationWorkspaceBinding,
} from '../../application/ports/isolationWorkspace'
import { hostedWorkspaceReference, parseHostedWorkspaceReference } from './workspaceReference'

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
      const nativeBinding: IsolationWorkspaceBinding = {
        ...mapHostedWorkspacePaths(binding, 'native', binding.taskId),
        storageRootRef: '/work',
      }
      const call = async <T>(method: string, args: readonly unknown[]): Promise<T> => {
        const result = await helper.call<T>(binding.taskId, 'isolation', {
          binding: nativeBinding,
          method,
          args: mapHostedWorkspacePaths(args, 'native', binding.taskId),
        })
        return mapHostedWorkspacePaths(result, 'hosted', binding.taskId)
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
        snapshot: (workspace, _log, paths) => call('snapshot', [workspace, null, paths]),
        // M1 preserves conflicts as explicit human decisions. Native-config
        // Agent resolution is selected in M2; no callback runs on this host.
        merge: (workspace, trees) => call('merge', [workspace, trees]),
        undoShard: ({ log: _log, ...request }) => call('undoShard', [request]),
        async discard(workspace, _log, writeWindow, onProgress) {
          const discard = async () => {
            await call('discard', [workspace])
            onProgress?.(0)
          }
          if (writeWindow === undefined) await discard()
          else await writeWindow.run(discard)
        },
        resolveConflict: async () => {
          throw new Error(
            'hosted-capability-unavailable: Agent conflict resolution requires RFC-370 M2',
          )
        },
        completeHumanConflict: (workspace, trees) =>
          call('completeHumanConflict', [workspace, trees]),
      } satisfies IsolationWorkspaceScope
    },
  }
}
