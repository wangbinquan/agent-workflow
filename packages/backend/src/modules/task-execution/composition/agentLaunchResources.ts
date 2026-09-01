import type { DbClient } from '@/db/client'
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
  db: DbClient,
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
