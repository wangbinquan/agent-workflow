// RFC-333 — committed receipt returned by collaboration commands.

import type { HumanGateKind } from './humanGateOperation'

export interface HumanGateIdentity {
  readonly kind: HumanGateKind
  readonly ref: string
}

export interface GateDecisionReceipt {
  readonly operationId: string
  readonly gate: HumanGateIdentity
  readonly gateRevision: number
  readonly taskRevision: number
  readonly acceptedAt: number
  readonly replayed: boolean
}

export function gateDecisionReceipt(input: GateDecisionReceipt): GateDecisionReceipt {
  if (input.gateRevision <= 0 || input.taskRevision < 0) {
    throw new Error('invalid-human-gate-receipt-revision')
  }
  return Object.freeze({
    ...input,
    gate: Object.freeze({ ...input.gate }),
  })
}

export function encodeGateDecisionReceipt(receipt: GateDecisionReceipt): string {
  return JSON.stringify({
    operationId: receipt.operationId,
    gate: receipt.gate,
    gateRevision: receipt.gateRevision,
    taskRevision: receipt.taskRevision,
    acceptedAt: receipt.acceptedAt,
  })
}
