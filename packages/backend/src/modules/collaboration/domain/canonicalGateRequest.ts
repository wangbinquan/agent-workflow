// RFC-333 — canonical business request used by gate-operation idempotency.

import {
  humanGateSha256Hex,
  type HumanGateKind,
  type HumanGateOperationKind,
} from './humanGateOperation'

export type ReviewGateDecision = 'approved' | 'rejected' | 'iterated'
export type ClarifyGateDirective = 'continue' | 'stop'

export type HumanGateRequestPayload =
  | Readonly<{
      kind: 'open'
      manifestDigest: string
    }>
  | Readonly<{
      kind: 'review-decision'
      decision: ReviewGateDecision
      reviewIteration: number
      rejectReason: string | null
      commentsJson: string
      selectionsJson: string
    }>
  | Readonly<{
      kind: 'clarify-decision'
      roundId: string
      directive: ClarifyGateDirective
      answersJson: string
      releaseGate: boolean
    }>
  | Readonly<{
      kind: 'question-dispatch'
      entryIds: readonly string[]
    }>
  | Readonly<{
      kind: 'manual-question-open'
      questionId: string
      targetNodeId: string
    }>
  | Readonly<{
      kind: 'legacy-seed'
      factDigest: string
    }>

export interface CanonicalHumanGateRequest {
  readonly schemaVersion: 1
  readonly taskId: string
  readonly gateKind: HumanGateKind
  readonly operationKind: HumanGateOperationKind
  readonly gateRef: string
  readonly actorUserId: string | null
  readonly expectedTaskRevision: number
  readonly expectedGateRevision: number
  readonly payload: HumanGateRequestPayload
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return output
  }
  return value
}

export function canonicalHumanGateValueJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function canonicalHumanGateJson(request: CanonicalHumanGateRequest): string {
  return canonicalHumanGateValueJson(request)
}

export function canonicalHumanGateRequestHash(request: CanonicalHumanGateRequest): string {
  return humanGateSha256Hex(canonicalHumanGateJson(request))
}

export function deriveHumanGateCompatibilityKey(request: CanonicalHumanGateRequest): string {
  const actor = request.actorUserId ?? 'system'
  return `compat:v1:${request.gateKind}:${request.gateRef}:${actor}:${String(request.expectedGateRevision)}:${canonicalHumanGateRequestHash(request)}`
}
