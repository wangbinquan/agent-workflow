import { runNode } from '../application/taskAgentRun'
import type { TaskAgentRunPolicy, RunResult } from '../application/ports/taskAgentRun'
import type { TaskAgentRunPurpose } from '../application/ports/taskAgentMaterial'

/** Normal Task execution consumes one already-selected complete purpose. */
export function runSelectedTaskAgent(
  policy: TaskAgentRunPolicy,
  purpose: TaskAgentRunPurpose,
): Promise<RunResult> {
  return runNode(policy, purpose)
}
