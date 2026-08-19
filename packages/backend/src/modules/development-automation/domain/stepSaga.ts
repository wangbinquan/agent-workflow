// RFC-310 PR-12 — business playbook step, child Mission and approval saga contracts.
//
// These codecs deliberately contain only opaque refs, closed states, digests and
// bounded timestamps.  A child workspace, provider credential, approval body,
// Agent session or raw log can therefore never leak through the orchestration
// boundary.  The state reducers are pure so recovery and system-mock tests use
// the exact same rules as the production coordinator.

import { z } from 'zod'

const ref = z.string().min(1).max(500)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const iso = z.string().datetime({ offset: true })

export const childMissionIntentSchema = z
  .object({
    parentMissionRef: ref,
    parentStepRunRef: ref,
    targetRepositoryRef: ref,
    targetEmployeeRef: z.object({ id: ref, revision: z.number().int().positive() }).strict(),
    inputEnvelopeRef: ref,
    completion: z.enum(['automation-ready', 'ready-to-merge', 'merged', 'completed']),
    deadlineAt: iso,
    idempotencyKey: digest,
    ancestry: z.array(ref).max(8),
  })
  .strict()

export type ChildMissionIntent = z.infer<typeof childMissionIntentSchema>

export const childMissionReceiptSchema = z
  .object({
    intentDigest: digest,
    childMissionRef: ref,
    childRevision: z.number().int().nonnegative(),
    observedStatus: z.enum([
      'pending',
      'running',
      'awaiting-information',
      'watching',
      'waiting-committer',
      'ready-to-merge',
      'merged',
      'closed-unmerged',
      'completed-no-change',
      'blocked',
      'handoff',
      'canceled',
    ]),
    completionSatisfied: z.boolean(),
    outputEnvelopeRef: ref.nullable(),
    observedAt: iso,
  })
  .strict()

export type ChildMissionReceipt = z.infer<typeof childMissionReceiptSchema>

export const approvalRequestDraftEnvelopeV1Schema = z
  .object({
    protocol: z.literal('aw-approval-request-draft@1'),
    nonce: z.string().min(16),
    stepRunRef: ref,
    inputDigest: digest,
    approvalType: z.string().min(1).max(120),
    title: z.string().min(1).max(500),
    bodyArtifactRef: ref,
    evidenceRefs: z.array(ref).max(100),
    requestedScopes: z.array(z.string().min(1).max(200)).max(100),
  })
  .strict()

export type ApprovalRequestDraftEnvelopeV1 = z.infer<typeof approvalRequestDraftEnvelopeV1Schema>

export const approvalSubmitIntentSchema = z
  .object({
    stepRunRef: ref,
    adapterRef: z.object({ id: ref, revision: z.number().int().positive() }).strict(),
    validatedDraftRef: ref,
    deadlineAt: iso,
    idempotencyKey: digest,
  })
  .strict()

export type ApprovalSubmitIntent = z.infer<typeof approvalSubmitIntentSchema>

export const approvalReceiptSchema = z
  .object({
    intentDigest: digest,
    correlationRef: ref,
    externalRequestRef: ref,
    submittedRevision: ref,
    submittedAt: iso,
  })
  .strict()

export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>

export const approvalObservationReceiptSchema = z
  .object({
    correlationRef: ref,
    observedRevision: ref,
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'unavailable']),
    evidenceRef: ref.nullable(),
    observedAt: iso,
  })
  .strict()

export type ApprovalObservationReceipt = z.infer<typeof approvalObservationReceiptSchema>

export const stepRunStateSchema = z.enum([
  'claimed',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'observation-only',
])
export type StepRunState = z.infer<typeof stepRunStateSchema>

export const STEP_RUN_TRANSITIONS: Readonly<Record<StepRunState, readonly StepRunState[]>> = {
  claimed: ['running', 'waiting', 'succeeded', 'failed'],
  running: ['waiting', 'succeeded', 'failed'],
  waiting: ['running', 'waiting', 'succeeded', 'failed', 'observation-only'],
  succeeded: ['observation-only'],
  failed: ['observation-only'],
  'observation-only': ['observation-only'],
}

export function canTransitionStepRun(from: StepRunState, to: StepRunState): boolean {
  return from === to || STEP_RUN_TRANSITIONS[from].includes(to)
}

export type JoinMode = 'all' | 'any' | 'quorum'
export type JoinMemberState = 'pending' | 'succeeded' | 'failed' | 'expired'

export type JoinVerdict =
  | { readonly kind: 'pending'; readonly succeeded: number; readonly settled: number }
  | { readonly kind: 'satisfied'; readonly succeeded: number; readonly settled: number }
  | { readonly kind: 'partial'; readonly succeeded: number; readonly settled: number }
  | { readonly kind: 'deadline'; readonly succeeded: number; readonly settled: number }

/** Pure all/any/quorum barrier. Remaining members stay observable after success. */
export function evaluateStepJoin(input: {
  readonly mode: JoinMode
  readonly quorum: number | null
  readonly deadlineAt: number
  readonly now: number
  readonly members: readonly JoinMemberState[]
}): JoinVerdict {
  const succeeded = input.members.filter((state) => state === 'succeeded').length
  const settled = input.members.filter((state) => state !== 'pending').length
  const required =
    input.mode === 'all'
      ? input.members.length
      : input.mode === 'any'
        ? 1
        : Math.max(1, input.quorum ?? input.members.length)
  if (succeeded >= required) return { kind: 'satisfied', succeeded, settled }
  const possible = succeeded + input.members.filter((state) => state === 'pending').length
  if (possible < required) return { kind: 'partial', succeeded, settled }
  if (input.now >= input.deadlineAt) return { kind: 'deadline', succeeded, settled }
  return { kind: 'pending', succeeded, settled }
}

export function childCompletionSatisfied(
  completion: ChildMissionIntent['completion'],
  status: ChildMissionReceipt['observedStatus'],
): boolean {
  if (completion === 'merged') return status === 'merged'
  if (completion === 'ready-to-merge') return status === 'ready-to-merge' || status === 'merged'
  if (completion === 'automation-ready') {
    return (
      status === 'watching' ||
      status === 'waiting-committer' ||
      status === 'ready-to-merge' ||
      status === 'merged' ||
      status === 'completed-no-change'
    )
  }
  return status === 'merged' || status === 'completed-no-change'
}
