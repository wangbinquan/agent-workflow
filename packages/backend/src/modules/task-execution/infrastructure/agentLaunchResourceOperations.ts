import {
  serializeWorkflowDefinitionStorageV1,
  WORKFLOW_SCHEMA_VERSION,
} from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import { workflows } from '@/db/schema'
import { initialBuiltinResourceAcl } from '@/modules/resource-catalog/application/resourceDefaults'
import { getAgentById } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import {
  loadWorkflowValidationContext,
  validateWorkflowDef,
} from '@/modules/resource-catalog/infrastructure/legacy/workflow.validator'
import { canViewResource } from '@/modules/resource-catalog/composition/resourceAcl'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  AgentLaunchResourceOperations,
  AgentLaunchVisibleAgentQuery,
  AgentLaunchWorkflowValidation,
} from '../application/ports/agentLaunchResourceOperations'

const AGENT_HOST_WORKFLOW_ID = '00000000000000AGENTHOST00'
const AGENT_HOST_WORKFLOW_NAME = '__agent_host__'

function hostWorkflowRow() {
  return {
    id: AGENT_HOST_WORKFLOW_ID,
    name: AGENT_HOST_WORKFLOW_NAME,
    description: 'RFC-165 single-agent host anchor — do not launch directly',
    definition: serializeWorkflowDefinitionStorageV1({
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [],
      edges: [],
    }),
    ...initialBuiltinResourceAcl(null),
    builtin: true,
  } as const
}

export function createSqliteAgentLaunchResourceOperations(
  db: DbClient,
): AgentLaunchResourceOperations {
  return Object.freeze({
    async loadVisibleAgent(actor: Actor, agentId: string) {
      const agent = await getAgentById(db, agentId)
      if (agent === null || !(await canViewResource(db, actor, 'agent', agent))) return null
      return agent
    },
    async ensureHostWorkflow() {
      await db
        .insert(workflows)
        .values(hostWorkflowRow())
        .onConflictDoNothing({ target: workflows.id })
    },
    async validateHostWorkflow(
      definition: Parameters<AgentLaunchResourceOperations['validateHostWorkflow']>[0],
    ) {
      return validateWorkflowDef(definition, await loadWorkflowValidationContext(db))
    },
  })
}

export function createPostgresqlAgentLaunchResourceOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly agents: AgentLaunchVisibleAgentQuery
  readonly workflowValidation: AgentLaunchWorkflowValidation
}): AgentLaunchResourceOperations {
  return Object.freeze({
    loadVisibleAgent: (actor: Actor, agentId: string) => input.agents.get(actor, agentId),
    async ensureHostWorkflow() {
      await input.db
        .insert(workflows)
        .values(hostWorkflowRow())
        .onConflictDoNothing({ target: workflows.id })
        .run()
    },
    async validateHostWorkflow(
      definition: Parameters<AgentLaunchResourceOperations['validateHostWorkflow']>[0],
    ) {
      return input.workflowValidation.validate(definition)
    },
  })
}
