// RFC-333 T9 — durable manifest/receipt for one task-question dispatch.

import type { CanonicalHumanGateRequest } from './canonicalGateRequest'
import { canonicalHumanGateValueJson } from './canonicalGateRequest'
import type { GateDecisionReceipt } from './gateReceipt'
import { HumanGateOperationError } from './humanGateOperation'

export interface QuestionDispatchRerunReceipt {
  readonly targetNodeId: string
  readonly nodeRunId: string
  readonly entryIds: readonly string[]
}

export interface QuestionDispatchDeferredReceipt {
  readonly entryId: string
  readonly homeNodeId: string
  readonly reason: string
}

export interface QuestionDispatchManifest {
  readonly schemaVersion: 1
  readonly kind: 'question-dispatch'
  readonly request: CanonicalHumanGateRequest
  readonly rerunNodeRunIds: readonly string[]
}

export interface QuestionDispatchBusinessReceipt {
  readonly taskId: string
  readonly continuationRef: string | null
  readonly reruns: readonly QuestionDispatchRerunReceipt[]
  readonly dispatchedEntryIds: readonly string[]
  readonly deferred: readonly QuestionDispatchDeferredReceipt[]
}

export interface QuestionDispatchReceiptEnvelope {
  readonly schemaVersion: 1
  readonly kind: 'question-dispatch'
  readonly decision: GateDecisionReceipt
  readonly result: QuestionDispatchBusinessReceipt
}

function invalid(message: string): never {
  throw new HumanGateOperationError('human-gate-operation-manifest-invalid', message)
}

export function encodeQuestionDispatchManifest(manifest: QuestionDispatchManifest): string {
  return canonicalHumanGateValueJson(manifest)
}

export function decodeQuestionDispatchManifest(raw: string): QuestionDispatchManifest {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    invalid('question dispatch manifest must be valid JSON')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    invalid('question dispatch manifest must be an object')
  }
  const value = decoded as Partial<QuestionDispatchManifest>
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'question-dispatch' ||
    value.request?.schemaVersion !== 1 ||
    value.request.gateKind !== 'questions' ||
    value.request.operationKind !== 'decide' ||
    value.request.payload.kind !== 'question-dispatch' ||
    !Array.isArray(value.rerunNodeRunIds) ||
    value.rerunNodeRunIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    invalid('question dispatch manifest has an invalid shape')
  }
  return value as QuestionDispatchManifest
}

export function encodeQuestionDispatchReceipt(receipt: QuestionDispatchReceiptEnvelope): string {
  return canonicalHumanGateValueJson(receipt)
}

export function decodeQuestionDispatchReceipt(raw: string): QuestionDispatchReceiptEnvelope {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    invalid('question dispatch receipt must be valid JSON')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    invalid('question dispatch receipt must be an object')
  }
  const value = decoded as Partial<QuestionDispatchReceiptEnvelope>
  const decision = value.decision
  const result = value.result
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'question-dispatch' ||
    decision === undefined ||
    result === undefined ||
    typeof decision.operationId !== 'string' ||
    decision.gate?.kind !== 'questions' ||
    typeof decision.gate.ref !== 'string' ||
    !Number.isSafeInteger(decision.gateRevision) ||
    !Number.isSafeInteger(decision.taskRevision) ||
    typeof result.taskId !== 'string' ||
    (result.continuationRef !== null && typeof result.continuationRef !== 'string') ||
    !Array.isArray(result.reruns) ||
    !Array.isArray(result.dispatchedEntryIds) ||
    !Array.isArray(result.deferred)
  ) {
    invalid('question dispatch receipt has an invalid shape')
  }
  return value as QuestionDispatchReceiptEnvelope
}
