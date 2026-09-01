import {
  McpRuntimeTestLeaseError,
  type McpRuntimeTestLeaseOperations,
} from '@/modules/resource-catalog/public/participants'
import type {
  McpRuntimeTestLeaseInput,
  McpRuntimeTestLeaseToken,
} from '@/modules/resource-catalog/public/types'

export { McpRuntimeTestLeaseError, type McpRuntimeTestLeaseOperations }
export type { McpRuntimeTestLeaseToken }

export function claimNewMcpRuntimeTestSessionLease(
  operations: McpRuntimeTestLeaseOperations,
  input: McpRuntimeTestLeaseInput,
): Promise<McpRuntimeTestLeaseToken> {
  return operations.claimNew(input)
}

export function preclaimMcpRuntimeTestSessionLease(
  operations: McpRuntimeTestLeaseOperations,
  input: McpRuntimeTestLeaseInput,
): Promise<McpRuntimeTestLeaseToken> {
  return operations.preclaim(input)
}

export function rotateMcpRuntimeTestSessionLease(
  operations: McpRuntimeTestLeaseOperations,
  token: McpRuntimeTestLeaseToken,
  nextRuntimeSessionId: string,
): Promise<McpRuntimeTestLeaseToken> {
  return operations.rotate(token, nextRuntimeSessionId)
}

export function releaseMcpRuntimeTestSessionLease(
  operations: McpRuntimeTestLeaseOperations,
  token: McpRuntimeTestLeaseToken,
): Promise<boolean> {
  return operations.release(token)
}

export function repairMcpRuntimeTestSessionLeaseAfterReap(
  operations: McpRuntimeTestLeaseOperations,
  testSessionId: string,
  turnId: string,
  childReaped: true,
): Promise<boolean> {
  return operations.repairAfterReap(testSessionId, turnId, childReaped)
}
