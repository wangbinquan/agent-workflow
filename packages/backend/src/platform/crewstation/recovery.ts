// RFC-370 §9.2 V4 — CrewStation recovery intake for the two parent-level
// actions AW declares (`resume-task`, `rebuild-workspace`). Node-level retry
// and resume stay AW's own task commands, and a fresh volume is AW's ordinary
// "rerun task", so the platform never offers anything else to AW.
//
// Envelopes are parsed leniently: unknown fields are ignored and an undeclared
// action is still readable, so the consumer can reject it explicitly instead
// of failing every claim of that request.
import { z } from 'zod'
import type { CrewStationPlatformApi } from './platformApi'
import type { BusinessExecutionFence } from './businessExecution'

const Id = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Generation = z.number().int().positive()

export const CrewStationRecoveryTarget = z.object({
  action: z.string().min(1).max(64),
  taskId: Id,
  expectedGeneration: Generation,
  materialDigest: Digest,
  volumeUid: z.string().min(1).max(256).optional(),
})
export type CrewStationRecoveryTarget = z.infer<typeof CrewStationRecoveryTarget>
export const CrewStationRecoveryRequest = z.object({
  id: Id,
  projectId: Id,
  serviceId: Id,
  requestedBy: Id,
  requestKey: z.string().min(1).max(128),
  target: CrewStationRecoveryTarget,
  assessmentDigest: Digest,
  state: z.enum(['pending', 'claimed', 'running', 'succeeded', 'failed', 'rejected']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  operationId: Id.optional(),
  reason: z.string().max(1024).optional(),
})
export type CrewStationRecoveryRequest = z.infer<typeof CrewStationRecoveryRequest>
const Claim = z.object({
  request: CrewStationRecoveryRequest,
  claimId: Id,
  expiresAt: z.string().datetime(),
})

export interface CrewStationRecoveryClaim {
  readonly request: Readonly<CrewStationRecoveryRequest>
  readonly expiresAt: string
  /** Issued by this adapter; caller-created handles are never actionable. */
  readonly reference: object
}
export interface CrewStationRecoveryReceipt {
  readonly kind: 'operation'
  readonly operationId: string
  readonly taskId: string
  readonly state: string
}

const Operation = z.object({
  operationId: Id,
  taskId: Id,
  state: z.string().min(1).max(64),
})

const root = '/v3/business-execution/recovery'
const sameFence = (a: BusinessExecutionFence, b: BusinessExecutionFence) =>
  a.epoch === b.epoch && a.leaseId === b.leaseId && a.instanceId === b.instanceId

/** Transport only: the consumer admits the request (owner task, requester,
 * manual-execution policy) before calling `execute`. An operation receipt
 * never means AW has resumed its task. */
export function createCrewStationRecoveryApi(input: {
  readonly api: CrewStationPlatformApi
  readonly fence: { current(): BusinessExecutionFence }
  readonly now?: () => number
}) {
  const claims = new WeakMap<
    object,
    { claim: z.infer<typeof Claim>; fence: BusinessExecutionFence }
  >()
  const now = input.now ?? Date.now
  const requireClaim = (handle: CrewStationRecoveryClaim) => {
    const stored = claims.get(handle.reference)
    if (
      !stored ||
      handle.request !== stored.claim.request ||
      handle.expiresAt !== stored.claim.expiresAt
    )
      throw new Error('hosted-recovery-claim-not-owned')
    const fence = input.fence.current()
    if (!sameFence(stored.fence, fence) || Date.parse(stored.claim.expiresAt) <= now())
      throw new Error('hosted-recovery-claim-expired')
    return { ...stored, fence }
  }
  const parseRequest = (value: unknown, requestId: string) => {
    const request = CrewStationRecoveryRequest.parse(value)
    if (request.id !== requestId) throw new Error('hosted-recovery-request-identity-mismatch')
    return request
  }
  return {
    async claim(requestId?: string): Promise<CrewStationRecoveryClaim | null> {
      if (requestId !== undefined) Id.parse(requestId)
      const fence = Object.freeze({ ...input.fence.current() })
      // Claim-next is not idempotent. A lost response must expire/reconcile;
      // transport retries must not claim a different pending request.
      const value = await input.api.post(
        root + '/claim',
        {
          fence,
          ...(requestId === undefined ? {} : { requestId }),
        },
        { retry: false },
      )
      if (value === null) return null
      const claim = Claim.parse(value)
      if (requestId !== undefined && claim.request.id !== requestId)
        throw new Error('hosted-recovery-request-identity-mismatch')
      if (!['claimed', 'running'].includes(claim.request.state))
        throw new Error('hosted-recovery-claim-state-invalid')
      Object.freeze(claim.request.target)
      Object.freeze(claim.request)
      const handle = Object.freeze({
        request: claim.request,
        expiresAt: claim.expiresAt,
        reference: Object.freeze({}),
      })
      claims.set(handle.reference, { claim, fence })
      requireClaim(handle)
      return handle
    },
    async read(requestId: string) {
      Id.parse(requestId)
      return parseRequest(
        await input.api.post(`${root}/${requestId}/read`, { fence: input.fence.current() }),
        requestId,
      )
    },
    async reject(handle: CrewStationRecoveryClaim, reason: string) {
      const { claim, fence } = requireClaim(handle)
      if (claim.request.state !== 'claimed') throw new Error('hosted-recovery-already-running')
      const detail = z.string().trim().min(1).max(1024).parse(reason)
      const rejected = parseRequest(
        await input.api.post(
          `${root}/${claim.request.id}/reject`,
          { fence, claimId: claim.claimId, reason: detail },
          { retry: false },
        ),
        claim.request.id,
      )
      if (rejected.state !== 'rejected') throw new Error('hosted-recovery-rejection-not-confirmed')
      return rejected
    },
    /** `resume-task` restarts a paused container on the same volume;
     * `rebuild-workspace` replaces a failed container on the same volume. */
    async execute(handle: CrewStationRecoveryClaim): Promise<CrewStationRecoveryReceipt> {
      const { claim, fence } = requireClaim(handle)
      const request = claim.request,
        target = request.target
      if (target.action !== 'resume-task' && target.action !== 'rebuild-workspace')
        throw new Error('hosted-recovery-action-not-declared')
      const receipt = Operation.parse(
        await input.api.post(
          `/v3/business-tasks/${target.taskId}/${target.action === 'resume-task' ? 'resume' : 'rebuild'}`,
          {
            requestKey: `recovery:${request.id}`,
            fence,
            recovery: { recoveryRequestId: request.id, claimId: claim.claimId },
            expectedGeneration: target.expectedGeneration,
          },
        ),
      )
      if (receipt.taskId !== target.taskId)
        throw new Error('hosted-recovery-task-identity-mismatch')
      return { kind: 'operation', ...receipt }
    },
  }
}
