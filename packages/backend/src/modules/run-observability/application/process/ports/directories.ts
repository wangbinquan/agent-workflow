import type { ProcessIdentity } from '@agent-workflow/shared'

/** Display identities of accounts; unknown ids are simply absent from the result. */
export interface ProcessIdentityDirectory {
  identities(userIds: readonly string[]): Promise<readonly ProcessIdentity[]>
}

/**
 * Current names of workflows. A task does not freeze its workflow's name, so the
 * name is read live, like the task list does; a deleted workflow has no entry.
 */
export interface ProcessWorkflowNames {
  names(workflowIds: readonly string[]): Promise<ReadonlyMap<string, string>>
}
