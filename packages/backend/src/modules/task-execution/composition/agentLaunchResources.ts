import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  AgentLaunchResourceOperations,
  AgentLaunchVisibleAgentQuery,
  AgentLaunchWorkflowValidation,
} from '../application/ports/agentLaunchResourceOperations'
import { createAgentLaunchResourceOperations } from '../infrastructure/agentLaunchResourceOperations'

/**
 * RFC-359 AC-1（plan §5ge）—— 装配面也只剩一份。
 *
 * 两个 provider 的差别（谁解析可见 agent、谁做工作流校验）由**可选实参**承担：
 * 不传就用建立在 `db` 上的缺省实现（原 SQLite 那份的体内逻辑），
 * PostgreSQL bootstrap 照旧把自己的两份传进来。
 */
export function composeAgentLaunchResourceOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly agents?: AgentLaunchVisibleAgentQuery
  readonly workflowValidation?: AgentLaunchWorkflowValidation
}): AgentLaunchResourceOperations {
  return createAgentLaunchResourceOperations(input)
}
