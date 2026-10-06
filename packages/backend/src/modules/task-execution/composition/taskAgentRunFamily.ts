import type { TaskAgentRunFamily, TaskAgentRunScope } from '../application/ports/taskAgentRunFamily'
import type { TaskAgentRunPolicy } from '../application/ports/taskAgentRun'
import { runSelectedTaskAgent } from './taskAgentRun'

/** Normal production entry: open one selected purpose, then run the complete
 * common Task policy. Missing family members have no compatibility fallback. */
export function runTaskAgentWithFamily(
  family: TaskAgentRunFamily,
  policy: TaskAgentRunPolicy,
  scope: Omit<TaskAgentRunScope, 'taskId' | 'nodeRunId' | 'taskMountRefs'>,
) {
  return runSelectedTaskAgent(
    policy,
    family.open({
      ...scope,
      taskId: policy.taskId,
      nodeRunId: policy.nodeRunId,
      taskMountRefs: () => (policy.templateMeta.repos ?? []).map((repo) => repo.worktreePath),
    }),
  )
}
