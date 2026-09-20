import { z } from 'zod'
import type { ExecutionContractResourcePort } from '@/modules/execution-contract/composition/required-ports'
import type { ExecutionContractResourceLookup } from '../ports/executionContractResourceLookup'
import { inspectExecutionContractWorkflowDefinition } from '../../domain/executionContractWorkflow'
const declarationsSchema = z
  .array(
    z.object({ contractId: z.string().min(1), version: z.number().int().positive() }).passthrough(),
  )
  .max(200)
export function createExecutionContractResourceAdapterFromLookup(
  lookup: ExecutionContractResourceLookup,
  implicitAgentDeclarations: (input: {
    readonly frontmatterExtra: Readonly<Record<string, unknown>>
  }) => readonly { readonly contractId: string; readonly version: number }[] = () => [],
): ExecutionContractResourcePort {
  return {
    async inspect({ implementation, expectedOutputPort }) {
      if (implementation.kind === 'agent') {
        const agent = await lookup.loadAgent(implementation.agentRef.id)
        if (agent === null || agent.updatedAt !== implementation.agentRef.revision) return null
        const available = agent.outputs.includes(expectedOutputPort)
        const declared = declarationsSchema.safeParse(agent.frontmatterExtra.executionContracts)
        const fallbackDeclarations = implicitAgentDeclarations({
          frontmatterExtra: agent.frontmatterExtra,
        })
        return {
          kind: 'agent',
          name: agent.name,
          available,
          detail: available
            ? `${agent.name}; exact ${expectedOutputPort} output port`
            : `${agent.name}; missing required output ${expectedOutputPort}`,
          declaredContractRefs: declared.success ? declared.data : fallbackDeclarations,
        }
      }
      const workflow = await lookup.loadWorkflow(implementation.workflowRef.id)
      if (workflow === null || workflow.version !== implementation.workflowRef.revision) return null
      const closure = inspectExecutionContractWorkflowDefinition(
        workflow.definition,
        expectedOutputPort,
      )
      return {
        kind: 'workflow',
        name: workflow.name,
        available: closure.ok,
        detail: `${workflow.name}; ${closure.detail}`,
        declaredContractRefs: null,
      }
    },
  }
}
