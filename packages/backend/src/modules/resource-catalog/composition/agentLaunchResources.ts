import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createAgentLaunchResourceOperations,
  type AgentLaunchResourceOperations,
  type AgentLaunchVisibleAgentQuery,
  type AgentLaunchWorkflowValidation,
} from '../infrastructure/agentLaunchResourceOperations'

// RFC-470: the scheduled-task launch gate validates an already authorized snapshot with the same static rules.
export { assertWorkflowSnapshotLaunchable } from '../infrastructure/workflowSnapshotLaunchGate'

/**
 * RFC-359 AC-1（plan §5ge）—— 装配面也只剩一份。
 *
 * 两个 provider 的差别（谁解析可见 agent、谁做工作流校验）由**可选实参**承担：
 * 不传就用建立在 `db` 上的缺省实现（原 SQLite 那份的体内逻辑），
 * PostgreSQL bootstrap 照旧把自己的两份传进来。
 *
 * RFC-470: moved here from task-execution `composition/`; the assembly root hands the result to task-execution, whose
 * agent-launch resource port it satisfies structurally.
 */
export function composeAgentLaunchResourceOperations(input: {
  readonly db: PersistenceDb
  readonly agents?: AgentLaunchVisibleAgentQuery
  readonly workflowValidation?: AgentLaunchWorkflowValidation
}): AgentLaunchResourceOperations {
  return createAgentLaunchResourceOperations(input)
}
