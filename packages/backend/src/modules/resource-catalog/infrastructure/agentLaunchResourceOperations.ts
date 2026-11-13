// RFC-470 (RFC-294 W9-D): resource-catalog implements task-execution's agent-launch resource port. The port stays
// with its consumer (task-execution `application/ports/agentLaunchResourceOperations.ts`); the implementation lives
// with the owner of these capabilities (agent / workflow visibility, the workflow row, workflow static validation)
// and the assembly root hands it over. The shapes below are the port's, written here so resource-catalog does not
// import task-execution; `tests/rfc470-workflow-facades-retirement.test.ts` locks them equal at compile time.
import type { Agent, WorkflowDefinition, WorkflowDetail } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { getAgentById } from './legacy/agent'
import { getWorkflow } from './legacy/workflow'
import { loadWorkflowValidationContext } from './legacy/workflow.validator'
import { validateWorkflowDef } from '../domain/workflowValidator'
import { canViewResource } from '../composition/resourceAcl'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export interface AgentLaunchValidationIssue {
  readonly code: string
  readonly severity?: string
  readonly message: string
  readonly [key: string]: unknown
}

export interface AgentLaunchVisibleAgentQuery {
  get(actor: Actor, agentId: string): Promise<Agent | null>
}

export interface AgentLaunchWorkflowValidationCandidate {
  readonly definition: WorkflowDefinition
  readonly currentWorkflow: Readonly<{ id: string; name: string }>
  readonly frozenClosureJson?: string | null
}

export interface AgentLaunchWorkflowValidation {
  validate(
    definition: WorkflowDefinition,
    candidate?: AgentLaunchWorkflowValidationCandidate,
  ): Promise<{
    readonly ok: boolean
    readonly issues: readonly AgentLaunchValidationIssue[]
  }>
}

export interface AgentLaunchWorkflowAclRow {
  readonly id: string
  readonly ownerUserId?: string | null
  readonly visibility?: 'public' | 'private'
  readonly builtin?: boolean | null
}

export interface AgentLaunchResourceOperations {
  loadVisibleAgent(actor: Actor, agentId: string): Promise<Agent | null>
  canViewWorkflow(actor: Actor, workflow: AgentLaunchWorkflowAclRow): Promise<boolean>
  readWorkflow(workflowId: string): Promise<WorkflowDetail | null>
  validateHostWorkflow(
    definition: WorkflowDefinition,
    candidate?: AgentLaunchWorkflowValidationCandidate,
  ): Promise<{
    readonly ok: boolean
    readonly issues: readonly AgentLaunchValidationIssue[]
  }>
}

/**
 * RFC-359 AC-1（plan §5ge）—— **两个 provider 唯一的一份**。
 *
 * 合一前一对孪生，三件事里两件的差别都是「**自己造** vs **让人注入**」：
 *   · `loadVisibleAgent`：SQLite 那份体内 `getAgentById` + `canViewResource`，
 *     PG 那份转交给注入的 `input.agents.get`；
 *   · `validateHostWorkflow`：SQLite 那份体内 `validateWorkflowDef(def, await loadWorkflowValidationContext(db))`，
 *     PG 那份转交给注入的 `input.workflowValidation.validate`。
 *
 * 按 §5fq 三条判据一条都不命中：这不是引擎差异，是**装配责任放在了不同的地方**。
 * 处方仍是「装配者提供答案」，但这里用**缺省实参**收口：两个口子都可选，
 * 不给就用建立在 `db` 上的那份缺省实现——于是 SQLite 的两个 bootstrap 调用点一个字都不用改，
 * PG bootstrap 照旧传自己的那两份。
 *
 * RFC-470: moved here from task-execution `infrastructure/` (bodies unchanged) and gained `readWorkflow` — the same
 * `getWorkflow` the workflow-sync routes used to take through the `services/workflow` re-export.
 */
export function createAgentLaunchResourceOperations(input: {
  readonly db: PersistenceDb
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
    canViewWorkflow: (
      actor: Actor,
      workflow: Parameters<AgentLaunchResourceOperations['canViewWorkflow']>[1],
    ) => canViewResource(db, actor, 'workflow', workflow),
    readWorkflow: (workflowId: string) => getWorkflow(db, workflowId),
    async validateHostWorkflow(
      definition: Parameters<AgentLaunchResourceOperations['validateHostWorkflow']>[0],
      candidate?: Parameters<AgentLaunchResourceOperations['validateHostWorkflow']>[1],
    ) {
      return workflowValidation.validate(definition, candidate)
    },
  })
}
