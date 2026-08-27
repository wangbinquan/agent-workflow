// RFC-333 — purpose-specific human-gate operation state machine.
//
// This is deliberately not a generic saga abstraction. The closed kinds below
// describe only review / clarify / question open and decision recovery.

import { sha256Hex as humanGateSha256Hex } from '@/util/hash'

export { humanGateSha256Hex }

export const HUMAN_GATE_KINDS = ['review', 'clarify', 'questions'] as const
export type HumanGateKind = (typeof HUMAN_GATE_KINDS)[number]

export const HUMAN_GATE_OPERATION_KINDS = [
  'open',
  'decide',
  'manual-question-open',
  'legacy-seed',
] as const
export type HumanGateOperationKind = (typeof HUMAN_GATE_OPERATION_KINDS)[number]

export const HUMAN_GATE_OPERATION_STATES = [
  'preparing',
  'prepared',
  'committed',
  'cleanup_pending',
  'completed',
  'failed',
] as const
export type HumanGateOperationState = (typeof HUMAN_GATE_OPERATION_STATES)[number]

export const HUMAN_GATE_ARTIFACT_STATES = [
  'declared',
  'staged',
  'consumed',
  'finalized',
  'cleanup_pending',
] as const
export type HumanGateArtifactState = (typeof HUMAN_GATE_ARTIFACT_STATES)[number]

export const HUMAN_GATE_MANIFEST_KINDS = [
  'review-open',
  'clarify-open',
  'questions-open',
  'manual-question-open',
  'review-decision',
  'clarify-decision',
  'question-dispatch',
  'legacy-seed',
] as const
export type HumanGateManifestKind = (typeof HUMAN_GATE_MANIFEST_KINDS)[number]

export type HumanGateOperationErrorCode =
  | 'human-gate-artifact-digest-mismatch'
  | 'human-gate-artifact-missing'
  | 'human-gate-idempotency-conflict'
  | 'human-gate-operation-conflict'
  | 'human-gate-operation-not-found'
  | 'human-gate-operation-stale'
  | 'human-gate-operation-transition-invalid'
  | 'human-gate-operation-manifest-invalid'

export class HumanGateOperationError extends Error {
  constructor(
    readonly code: HumanGateOperationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | null>> = {},
  ) {
    super(message)
    this.name = 'HumanGateOperationError'
  }
}

const TRANSITIONS = {
  preparing: ['prepared', 'committed', 'cleanup_pending', 'failed'],
  prepared: ['committed', 'cleanup_pending', 'failed'],
  committed: ['completed', 'cleanup_pending'],
  cleanup_pending: ['completed', 'failed'],
  completed: [],
  failed: [],
} as const satisfies Record<HumanGateOperationState, readonly HumanGateOperationState[]>

export function mayTransitionHumanGateOperation(
  from: HumanGateOperationState,
  to: HumanGateOperationState,
): boolean {
  return (TRANSITIONS[from] as readonly HumanGateOperationState[]).includes(to)
}

export function assertHumanGateOperationTransition(
  from: HumanGateOperationState,
  to: HumanGateOperationState,
): void {
  if (!mayTransitionHumanGateOperation(from, to)) {
    throw new HumanGateOperationError(
      'human-gate-operation-transition-invalid',
      `human-gate operation cannot transition from '${from}' to '${to}'`,
      { from, to },
    )
  }
}

export function nextHumanGateClaimEpoch(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new HumanGateOperationError(
      'human-gate-operation-stale',
      'human-gate claim epoch must be a non-negative safe integer',
      { current },
    )
  }
  return current + 1
}

export interface HumanGateOperationIdentity {
  readonly taskId: string
  readonly gateKind: HumanGateKind
  readonly operationKind: HumanGateOperationKind
  readonly gateRef: string
}

export interface PreparedHumanGateRef {
  readonly operationId: string
  readonly taskId: string
  readonly gateKind: HumanGateKind
  readonly expectedTaskRevision: number
  readonly manifestDigest: string
}

export function preparedHumanGateRef(operation: HumanGateOperationSnapshot): PreparedHumanGateRef {
  if (operation.state !== 'prepared') {
    throw new HumanGateOperationError(
      'human-gate-operation-transition-invalid',
      `human-gate operation '${operation.id}' is not prepared`,
      { operationId: operation.id, currentState: operation.state },
    )
  }
  return Object.freeze({
    operationId: operation.id,
    taskId: operation.taskId,
    gateKind: operation.gateKind,
    expectedTaskRevision: operation.expectedTaskRevision,
    manifestDigest: humanGateSha256Hex(operation.manifestJson),
  })
}

export interface HumanGateOperationSnapshot extends HumanGateOperationIdentity {
  readonly id: string
  readonly idempotencyKey: string
  readonly requestHash: string
  readonly actorUserId: string | null
  readonly expectedTaskRevision: number
  readonly expectedGateRevision: number
  readonly resultGateRevision: number | null
  readonly state: HumanGateOperationState
  readonly claimEpoch: number
  readonly claimExpiresAt: number | null
  readonly schemaVersion: number
  readonly manifestJson: string
  readonly receiptJson: string | null
  readonly failureJson: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly committedAt: number | null
  readonly completedAt: number | null
}

export type HumanGateIdempotencyMatch = Readonly<{
  requestHash: string
  actorUserId: string | null
}>

export function assertHumanGateIdempotencyMatch(
  operation: Pick<HumanGateOperationSnapshot, 'id' | 'requestHash' | 'actorUserId'>,
  incoming: HumanGateIdempotencyMatch,
): void {
  if (
    operation.requestHash !== incoming.requestHash ||
    operation.actorUserId !== incoming.actorUserId
  ) {
    throw new HumanGateOperationError(
      'human-gate-idempotency-conflict',
      `human-gate idempotency key is already bound to operation '${operation.id}'`,
      { winnerOperationId: operation.id },
    )
  }
}

export function assertHumanGateManifestJson(value: string): void {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'human-gate operation manifest must be valid JSON',
    )
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'human-gate operation manifest must be an object',
    )
  }
  const envelope = decoded as { schemaVersion?: unknown; kind?: unknown }
  if (
    envelope.schemaVersion !== 1 ||
    typeof envelope.kind !== 'string' ||
    !(HUMAN_GATE_MANIFEST_KINDS as readonly string[]).includes(envelope.kind)
  ) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'human-gate operation manifest must use a supported version and kind',
    )
  }
}
