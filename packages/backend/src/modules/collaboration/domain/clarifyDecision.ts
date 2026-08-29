// RFC-333 T9 — durable manifest/receipt for a quick-channel clarify decision.

import type { CanonicalHumanGateRequest } from './canonicalGateRequest'
import { canonicalHumanGateValueJson } from './canonicalGateRequest'
import type { GateDecisionReceipt } from './gateReceipt'
import { HumanGateOperationError } from './humanGateOperation'
import type { ValidatedWorkspaceRollbackPlan } from './workspaceRollbackPlan'
import { TaskActorRoleSchema } from '@agent-workflow/shared'

export interface ClarifyDecisionManifest {
  readonly schemaVersion: 1
  readonly kind: 'clarify-decision'
  readonly request: CanonicalHumanGateRequest
  readonly sourceNodeRunIds: readonly string[]
  readonly workspaceRollbackPlan: ValidatedWorkspaceRollbackPlan | null
}

export interface ClarifyDecisionReceiptEnvelope {
  readonly schemaVersion: 1
  readonly kind: 'clarify-decision'
  readonly decision: GateDecisionReceipt
  readonly result: {
    readonly taskId: string
    readonly roundId: string
    readonly continuationRef: string
    readonly sealedQuestionIds: readonly string[]
    readonly roundFullySealed: boolean
  }
}

function invalid(message: string): never {
  throw new HumanGateOperationError('human-gate-operation-manifest-invalid', message)
}

export function encodeClarifyDecisionManifest(manifest: ClarifyDecisionManifest): string {
  return canonicalHumanGateValueJson(manifest)
}

export function decodeClarifyDecisionManifest(raw: string): ClarifyDecisionManifest {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    invalid('clarify decision manifest must be valid JSON')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    invalid('clarify decision manifest must be an object')
  }
  const value = decoded as Partial<ClarifyDecisionManifest>
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'clarify-decision' ||
    value.request?.schemaVersion !== 1 ||
    value.request.gateKind !== 'clarify' ||
    value.request.operationKind !== 'decide' ||
    value.request.payload.kind !== 'clarify-decision' ||
    (value.request.payload.actorRole !== undefined &&
      !TaskActorRoleSchema.safeParse(value.request.payload.actorRole).success) ||
    !Array.isArray(value.sourceNodeRunIds) ||
    value.sourceNodeRunIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    invalid('clarify decision manifest has an invalid shape')
  }
  return value as ClarifyDecisionManifest
}

export function encodeClarifyDecisionReceipt(receipt: ClarifyDecisionReceiptEnvelope): string {
  return canonicalHumanGateValueJson(receipt)
}

export function decodeClarifyDecisionReceipt(raw: string): ClarifyDecisionReceiptEnvelope {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    invalid('clarify decision receipt must be valid JSON')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    invalid('clarify decision receipt must be an object')
  }
  const value = decoded as Partial<ClarifyDecisionReceiptEnvelope>
  const decision = value.decision
  const result = value.result
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'clarify-decision' ||
    decision === undefined ||
    result === undefined ||
    typeof decision.operationId !== 'string' ||
    decision.gate?.kind !== 'clarify' ||
    typeof decision.gate.ref !== 'string' ||
    !Number.isSafeInteger(decision.gateRevision) ||
    !Number.isSafeInteger(decision.taskRevision) ||
    typeof result.taskId !== 'string' ||
    typeof result.roundId !== 'string' ||
    typeof result.continuationRef !== 'string' ||
    !Array.isArray(result.sealedQuestionIds) ||
    typeof result.roundFullySealed !== 'boolean'
  ) {
    invalid('clarify decision receipt has an invalid shape')
  }
  return value as ClarifyDecisionReceiptEnvelope
}
