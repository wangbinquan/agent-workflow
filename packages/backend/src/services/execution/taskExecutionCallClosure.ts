// RFC-345 T4a / RFC-349 T4a — provider-neutral atomic reference-closure freeze.

import type { WorkflowDefinition } from '@agent-workflow/shared'

import type { TaskExecutionResourceAuthority } from '@/modules/task-execution/application/ports/taskExecutionResourceSnapshots'

export async function freezeTaskExecutionCallClosure(
  root: Readonly<{ readonly id: string; readonly definition: WorkflowDefinition }>,
  resourceAuthority: TaskExecutionResourceAuthority,
): Promise<string | null> {
  return await resourceAuthority.resources.freezeCallClosure(resourceAuthority, root)
}
