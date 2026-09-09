import type { CreateAgent } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

export function assertBranchPortsDeclared(
  agent: Pick<CreateAgent, 'outputs' | 'branchPorts'>,
): void {
  if (agent.branchPorts === undefined || agent.branchPorts.length === 0) return
  const outputs = new Set(agent.outputs)
  const missing = agent.branchPorts.filter((port) => !outputs.has(port))
  if (missing.length === 0) return
  throw new ValidationError(
    'branch-port-not-declared',
    `agent branchPorts reference undeclared output port(s): ${missing.join(', ')}`,
    { notFound: missing },
  )
}
