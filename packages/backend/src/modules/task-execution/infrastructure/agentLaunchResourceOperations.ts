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
import type { ProviderNeutralDatabase } from '@/db/query'
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

/**
 * RFC-359 AC-1（plan §5ge）—— **两个 provider 唯一的一份**。
 *
 * 合一前一对孪生，三件事里两件的差别都是「**自己造** vs **让人注入**」：
 *   · `loadVisibleAgent`：SQLite 那份体内 `getAgentById` + `canViewResource`，
 *     PG 那份转交给注入的 `input.agents.get`；
 *   · `validateHostWorkflow`：SQLite 那份体内 `validateWorkflowDef(def, await loadWorkflowValidationContext(db))`，
 *     PG 那份转交给注入的 `input.workflowValidation.validate`。
 * 第三件 `ensureHostWorkflow` 本来就一样，只差 PG 那份多写了个 `.run()`——
 * 中立句柄上 `await` 就够（§5ft 同一条）。
 *
 * 按 §5fq 三条判据一条都不命中：这不是引擎差异，是**装配责任放在了不同的地方**。
 * 处方仍是「装配者提供答案」，但这里用**缺省实参**收口：两个口子都可选，
 * 不给就用建立在 `db` 上的那份缺省实现——于是 SQLite 的两个 bootstrap 调用点一个字都不用改，
 * PG bootstrap 照旧传自己的那两份。
 */
export function createAgentLaunchResourceOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly agents?: AgentLaunchVisibleAgentQuery
  readonly workflowValidation?: AgentLaunchWorkflowValidation
}): AgentLaunchResourceOperations {
  const { db } = input
  const agents: AgentLaunchVisibleAgentQuery = input.agents ?? {
    async get(actor: Actor, agentId: string) {
      const agent = await getAgentById(db, agentId)
      if (agent === null || !(await canViewResource(db, actor, 'agent', agent))) return null
      return agent
    },
  }
  const workflowValidation: AgentLaunchWorkflowValidation = input.workflowValidation ?? {
    async validate(definition, candidate) {
      // RFC-359 AC-1（plan §5hn 批次二 ④）：**候选上下文必须透传**。没有它，
      // `loadWorkflowValidationContext` 不填 `callWorkflows` / `callWorkgroupNames` /
      // `currentWorkflow`，call-node 规则就不在这道门上判。
      return validateWorkflowDef(definition, await loadWorkflowValidationContext(db, candidate))
    },
  }
  return Object.freeze({
    loadVisibleAgent: (actor: Actor, agentId: string) => agents.get(actor, agentId),
    async ensureHostWorkflow() {
      await db
        .insert(workflows)
        .values(hostWorkflowRow())
        .onConflictDoNothing({ target: workflows.id })
    },
    async validateHostWorkflow(
      definition: Parameters<AgentLaunchResourceOperations['validateHostWorkflow']>[0],
      candidate?: Parameters<AgentLaunchResourceOperations['validateHostWorkflow']>[1],
    ) {
      return workflowValidation.validate(definition, candidate)
    },
  })
}
