import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  AgentLaunchResourceOperations,
  AgentLaunchVisibleAgentQuery,
  AgentLaunchWorkflowValidation,
} from '../application/ports/agentLaunchResourceOperations'
import {
  createPostgresqlAgentLaunchResourceOperations,
  createSqliteAgentLaunchResourceOperations,
} from '../infrastructure/agentLaunchResourceOperations'

export function composeSqliteAgentLaunchResourceOperations(
  db: ProviderNeutralDatabase,
): AgentLaunchResourceOperations {
  return createSqliteAgentLaunchResourceOperations(db)
}

export function composePostgresqlAgentLaunchResourceOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly agents: AgentLaunchVisibleAgentQuery
  readonly workflowValidation: AgentLaunchWorkflowValidation
}): AgentLaunchResourceOperations {
  return createPostgresqlAgentLaunchResourceOperations(input)
}
