import type { TaskWorkspaceReadPort, WorkspaceReadCapability } from './ports/workspaceLaunch'
import type { TaskWorkspaceQueries } from '../public/queries'
import { WORKTREE_DIR_MAX_ENTRIES, WORKTREE_FILE_MAX_BYTES } from '@agent-workflow/shared'

interface WorkspaceQueries extends TaskWorkspaceQueries {
  list(
    taskId: string,
    request: Parameters<TaskWorkspaceReadPort['list']>[1],
  ): ReturnType<TaskWorkspaceReadPort['list']>
  read(
    taskId: string,
    request: Parameters<TaskWorkspaceReadPort['read']>[1],
  ): ReturnType<TaskWorkspaceReadPort['read']>
}

export interface TaskWorkspaceReadScope {
  readonly port: TaskWorkspaceReadPort
  readonly capability: WorkspaceReadCapability
  close(): void
}

/** Task owns the query lifetime and its existing HTTP display projection. */
export function createTaskWorkspaceQueries(
  bind: (taskId: string) => Promise<TaskWorkspaceReadScope>,
): WorkspaceQueries {
  async function using<T>(taskId: string, body: (scope: TaskWorkspaceReadScope) => Promise<T>) {
    const scope = await bind(taskId)
    try {
      return await body(scope)
    } finally {
      scope.close()
    }
  }
  return Object.freeze<WorkspaceQueries>({
    list: (taskId, request) =>
      using(taskId, ({ port, capability }) => port.list(capability, request)),
    read: (taskId, request) =>
      using(taskId, ({ port, capability }) => port.read(capability, request)),
    listDisplay: (taskId, relativeDirectory) =>
      using(taskId, async ({ port, capability }) => {
        const page = await port.list(capability, {
          relativeDirectory,
          page: { offset: 0 },
          maxEntries: WORKTREE_DIR_MAX_ENTRIES,
        })
        return { entries: page.entries, truncated: page.truncated || page.nextOffset !== null }
      }),
    readDisplay: (taskId, relativeFile) =>
      using(taskId, async ({ port, capability }) => {
        const metadata = await port.read(capability, { relativeFile, offset: 0, maxBytes: 0 })
        if (metadata.oversized) return { size: metadata.size, oversized: true, content: '' }
        const result = await port.read(capability, {
          relativeFile,
          offset: 0,
          maxBytes: WORKTREE_FILE_MAX_BYTES,
        })
        return {
          size: result.size,
          oversized: result.oversized,
          content: result.oversized
            ? ''
            : new TextDecoder('utf-8', { fatal: false }).decode(
                Buffer.from(result.content, 'base64'),
              ),
        }
      }),
  })
}
