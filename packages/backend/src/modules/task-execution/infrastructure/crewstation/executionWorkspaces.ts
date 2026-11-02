// RFC-417: hosted (CrewStation) execution workspaces, moved verbatim from composition/crewstationExecution.ts:
// logical call / fusion children resolve the physical volume that owns their workspace before any platform parent is
// allocated, and workspace helper commands always address that physical owner.
import type { HostedWorkspaceCommands } from '@/modules/source-control/public/participants'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { isTaskWorkspaceUnbound } from '@agent-workflow/shared'
import { readTaskWorkspaceRef } from '../taskExecutionTaskReads'

/** Bind logical child executions to the physical volume owning their workspace. */
export function createHostedExecutionWorkspaces(input: {
  readonly db: PersistenceDb
  readonly locate: (reference: string) => { readonly taskId: string }
  readonly workspaces: {
    ensure(taskId: string): Promise<{ readonly businessTaskId: string }>
    find(taskId: string): Promise<{ readonly businessTaskId: string } | null>
  }
}) {
  // Inherited call/fusion children own their execution identity but operate in
  // their parent's physical workspace. Resolve that owner before allocating a
  // platform parent; never create an empty child volume for a parent cwd.
  const owner = async (taskId: string) => {
    const workspaceRef = await readTaskWorkspaceRef(input.db, taskId)
    return workspaceRef !== undefined && !isTaskWorkspaceUnbound(workspaceRef)
      ? input.locate(workspaceRef).taskId
      : taskId
  }
  return {
    owner,
    async ensure(taskId: string) {
      return input.workspaces.ensure(await owner(taskId))
    },
    async workspaceTaskId(taskId: string) {
      return (await input.workspaces.find(await owner(taskId)))?.businessTaskId ?? null
    },
  }
}

/** The workspace helper the hosted families share; logical children borrow their parent's volume. */
export type OwnerRoutedWorkspaceHelper = WorkspaceHelper & {
  recover<T>(taskId: string, operationId: string): Promise<{ value: T } | null>
}

/** Source Control owns the command journal; commands always address the physical owner. */
export function createOwnerRoutedWorkspaceHelper(
  commands: Pick<HostedWorkspaceCommands, 'call' | 'recover'>,
  owner: (taskId: string) => Promise<string>,
): OwnerRoutedWorkspaceHelper {
  return {
    call: async (taskId, operation, value, options) =>
      commands.call(await owner(taskId), operation, value, options),
    recover: async (taskId, operationId) => commands.recover(await owner(taskId), operationId),
  }
}
