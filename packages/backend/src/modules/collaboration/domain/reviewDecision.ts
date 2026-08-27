// RFC-333 T8 — durable manifest/receipt for one atomic review decision.

import type { CanonicalHumanGateRequest } from './canonicalGateRequest'
import { canonicalHumanGateValueJson } from './canonicalGateRequest'
import { HumanGateOperationError } from './humanGateOperation'
import type { GateDecisionReceipt } from './gateReceipt'
import type { ValidatedWorkspaceRollbackPlan } from './workspaceRollbackPlan'

export interface ReviewDecisionManifest {
  readonly schemaVersion: 1
  readonly kind: 'review-decision'
  readonly request: CanonicalHumanGateRequest
  readonly sourceNodeRunIds: readonly string[]
  readonly rerunNodeRunIds: readonly string[]
  readonly workspaceRollbackPlan: ValidatedWorkspaceRollbackPlan | null
}

export interface ReviewDecisionBusinessReceipt {
  readonly taskId: string
  readonly reviewIteration: number
  readonly continuationRef: string
  readonly commentsAdded: number
  readonly commentsSkippedAsDuplicate: number
  readonly selectionsApplied: number
}

export interface ReviewDecisionReceiptEnvelope {
  readonly schemaVersion: 1
  readonly kind: 'review-decision'
  readonly decision: GateDecisionReceipt
  readonly result: ReviewDecisionBusinessReceipt
}

function invalid(message: string): never {
  throw new HumanGateOperationError('human-gate-operation-manifest-invalid', message)
}

export function encodeReviewDecisionManifest(manifest: ReviewDecisionManifest): string {
  return canonicalHumanGateValueJson(manifest)
}

export function decodeReviewDecisionManifest(raw: string): ReviewDecisionManifest {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    invalid('review decision manifest must be valid JSON')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    invalid('review decision manifest must be an object')
  }
  const value = decoded as Partial<ReviewDecisionManifest>
  const request = value.request
  const plan = value.workspaceRollbackPlan
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'review-decision' ||
    request === undefined ||
    request.schemaVersion !== 1 ||
    request.gateKind !== 'review' ||
    request.operationKind !== 'decide' ||
    !Array.isArray(value.sourceNodeRunIds) ||
    !Array.isArray(value.rerunNodeRunIds) ||
    [...value.sourceNodeRunIds, ...value.rerunNodeRunIds].some(
      (id) => typeof id !== 'string' || id.length === 0,
    ) ||
    (plan !== null &&
      (plan === undefined ||
        plan.schemaVersion !== 1 ||
        plan.kind !== 'workspace-rollback-plan' ||
        typeof plan.digest !== 'string' ||
        !Array.isArray(plan.targets) ||
        !Array.isArray(plan.resourceKeys)))
  ) {
    invalid('review decision manifest has an invalid shape')
  }
  return value as ReviewDecisionManifest
}

export function encodeReviewDecisionReceipt(receipt: ReviewDecisionReceiptEnvelope): string {
  return canonicalHumanGateValueJson(receipt)
}

export function decodeReviewDecisionReceipt(raw: string): ReviewDecisionReceiptEnvelope {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    invalid('review decision receipt must be valid JSON')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    invalid('review decision receipt must be an object')
  }
  const value = decoded as Partial<ReviewDecisionReceiptEnvelope>
  const decision = value.decision
  const result = value.result
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'review-decision' ||
    decision === undefined ||
    result === undefined ||
    typeof decision.operationId !== 'string' ||
    decision.gate?.kind !== 'review' ||
    typeof decision.gate.ref !== 'string' ||
    !Number.isSafeInteger(decision.gateRevision) ||
    !Number.isSafeInteger(decision.taskRevision) ||
    typeof result.taskId !== 'string' ||
    typeof result.continuationRef !== 'string' ||
    !Number.isSafeInteger(result.reviewIteration) ||
    !Number.isSafeInteger(result.commentsAdded) ||
    !Number.isSafeInteger(result.commentsSkippedAsDuplicate) ||
    !Number.isSafeInteger(result.selectionsApplied)
  ) {
    invalid('review decision receipt has an invalid shape')
  }
  return value as ReviewDecisionReceiptEnvelope
}
