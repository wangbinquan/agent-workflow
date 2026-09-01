// Runtime-native conversation ownership and single-writer leases.
//
// Provider clients and transaction mechanisms belong to task-execution
// infrastructure. This compatibility facade keeps the stable product error
// and input-validation surface while requiring bootstrap-selected async
// operations for every read and mutation.

import {
  RuntimeSessionLeaseError,
  type RuntimeSessionLease,
  type RuntimeSessionLeaseClaimInput,
  type RuntimeSessionLeaseOperations,
  type RuntimeSessionLeaseProtocol,
  type RuntimeSessionLeaseToken,
} from '@/modules/task-execution/application/ports/runtimeSessionLeaseOperations'

export {
  RuntimeSessionLeaseError,
  type RuntimeSessionLease,
  type RuntimeSessionLeaseClaimInput,
  type RuntimeSessionLeaseOperations,
  type RuntimeSessionLeaseProtocol,
  type RuntimeSessionLeaseToken,
}

function fail(reason: string): never {
  throw new RuntimeSessionLeaseError(reason)
}

function nonEmpty(value: string): void {
  if (value.length === 0) fail('invalid-input')
}

function leaseTime(value: number | undefined): number {
  const result = value ?? Date.now()
  if (!Number.isSafeInteger(result) || result < 0) fail('invalid-input')
  return result
}

function validateClaim(input: RuntimeSessionLeaseClaimInput): void {
  nonEmpty(input.sessionId)
  nonEmpty(input.taskId)
  nonEmpty(input.nodeId)
  nonEmpty(input.currentNodeRunId)
  nonEmpty(input.leaseNonceDigest)
}

function validateToken(token: RuntimeSessionLeaseToken): void {
  nonEmpty(token.sessionId)
  nonEmpty(token.nodeRunId)
  nonEmpty(token.leaseNonceDigest)
}

export async function getRuntimeSessionLease(
  operations: RuntimeSessionLeaseOperations,
  protocol: RuntimeSessionLeaseProtocol,
  sessionId: string,
): Promise<RuntimeSessionLease | undefined> {
  nonEmpty(sessionId)
  return await operations.load(protocol, sessionId)
}

export async function claimNewRuntimeSession(
  operations: RuntimeSessionLeaseOperations,
  input: RuntimeSessionLeaseClaimInput,
): Promise<RuntimeSessionLeaseToken> {
  validateClaim(input)
  return await operations.claimNew({ ...input, leasedAt: leaseTime(input.leasedAt) })
}

export async function preclaimRuntimeSessionResume(
  operations: RuntimeSessionLeaseOperations,
  input: RuntimeSessionLeaseClaimInput,
): Promise<RuntimeSessionLeaseToken> {
  validateClaim(input)
  return await operations.preclaimResume({ ...input, leasedAt: leaseTime(input.leasedAt) })
}

export async function confirmRuntimeSessionResume(
  operations: RuntimeSessionLeaseOperations,
  token: RuntimeSessionLeaseToken,
): Promise<boolean> {
  validateToken(token)
  return await operations.confirmResume(token)
}

export async function rotateRuntimeSessionLease(
  operations: RuntimeSessionLeaseOperations,
  token: RuntimeSessionLeaseToken,
  nextSessionId: string,
): Promise<RuntimeSessionLeaseToken> {
  validateToken(token)
  nonEmpty(nextSessionId)
  if (nextSessionId === token.sessionId) fail('invalid-input')
  return await operations.rotate(token, nextSessionId)
}

export async function markRuntimeSessionResetPending(
  operations: RuntimeSessionLeaseOperations,
  token: RuntimeSessionLeaseToken,
): Promise<boolean> {
  validateToken(token)
  return await operations.markResetPending(token)
}

export async function discardRuntimeSessionLease(
  operations: RuntimeSessionLeaseOperations,
  token: RuntimeSessionLeaseToken,
): Promise<boolean> {
  validateToken(token)
  return await operations.discard(token)
}

export async function releaseRuntimeSessionLease(
  operations: RuntimeSessionLeaseOperations,
  token: RuntimeSessionLeaseToken,
): Promise<boolean> {
  validateToken(token)
  return await operations.release(token)
}

/** Called only after boot orphan reaping has killed or rejected every live child. */
export async function repairRuntimeSessionLeasesAfterOrphanReap(
  operations: RuntimeSessionLeaseOperations,
  orphanReapCompleted: true,
  nodeRunId?: string,
): Promise<number> {
  if (orphanReapCompleted !== true) fail('invalid-input')
  if (nodeRunId !== undefined) nonEmpty(nodeRunId)
  return await operations.repairAfterOrphanReap(nodeRunId)
}
