// RFC-333 T7 — durable manual-question row + park obligation manifest.

import { sha256Hex } from '@/util/hash'
import { canonicalHumanGateValueJson } from './canonicalGateRequest'
import { HumanGateOperationError } from './humanGateOperation'

export interface ManualQuestionProjection {
  readonly id: string
  readonly taskId: string
  readonly originNodeRunId: string
  readonly questionId: string
  readonly questionTitle: string
  readonly sourceKind: 'manual'
  readonly roleKind: 'designer'
  readonly iteration: 0
  readonly loopIter: 0
  readonly defaultTargetNodeId: null
  readonly overrideTargetNodeId: string
  readonly dispatchedAt: null
  readonly dispatchedBy: null
  readonly triggerRunId: null
  readonly stagedAt: number
  readonly stagedBy: string
  readonly autoDispatchDeferredAt: null
  readonly sealedAt: null
  readonly sealedBy: null
  readonly confirmation: 'open'
  readonly confirmedBy: null
  readonly confirmedByRole: null
  readonly confirmedAt: null
  readonly lastReassignedBy: null
  readonly lastReassignedAt: null
  readonly manualBody: string
  readonly manualCreatedBy: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ManualQuestionOpenManifest {
  readonly schemaVersion: 1
  readonly kind: 'manual-question-open'
  readonly gateRef: string
  readonly sourceSnapshotDigest: string
  readonly nodeProjectionDigest: string
  readonly committedEventRef: string
  readonly question: ManualQuestionProjection
}

function invalid(message: string): never {
  throw new HumanGateOperationError('human-gate-operation-manifest-invalid', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) {
    invalid(`manual-question-open ${key} is invalid`)
  }
  return field
}

function nonNegativeInteger(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    invalid(`manual-question-open ${key} is invalid`)
  }
  return field as number
}

function decodeQuestion(value: unknown): ManualQuestionProjection {
  if (!isRecord(value)) invalid('manual-question-open projection is invalid')
  if (
    value.sourceKind !== 'manual' ||
    value.roleKind !== 'designer' ||
    value.iteration !== 0 ||
    value.loopIter !== 0 ||
    value.defaultTargetNodeId !== null ||
    value.dispatchedAt !== null ||
    value.dispatchedBy !== null ||
    value.triggerRunId !== null ||
    value.autoDispatchDeferredAt !== null ||
    value.sealedAt !== null ||
    value.sealedBy !== null ||
    value.confirmation !== 'open' ||
    value.confirmedBy !== null ||
    value.confirmedByRole !== null ||
    value.confirmedAt !== null ||
    value.lastReassignedBy !== null ||
    value.lastReassignedAt !== null
  ) {
    invalid('manual-question-open mutable projection is invalid')
  }
  const createdAt = nonNegativeInteger(value, 'createdAt')
  const updatedAt = nonNegativeInteger(value, 'updatedAt')
  const stagedAt = nonNegativeInteger(value, 'stagedAt')
  if (createdAt !== updatedAt || createdAt !== stagedAt) {
    invalid('manual-question-open timestamps are not one snapshot')
  }
  const manualCreatedBy = stringField(value, 'manualCreatedBy')
  if (stringField(value, 'stagedBy') !== manualCreatedBy) {
    invalid('manual-question-open actor snapshot changed')
  }
  return {
    id: stringField(value, 'id'),
    taskId: stringField(value, 'taskId'),
    originNodeRunId: stringField(value, 'originNodeRunId'),
    questionId: stringField(value, 'questionId'),
    questionTitle: stringField(value, 'questionTitle'),
    sourceKind: 'manual',
    roleKind: 'designer',
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: null,
    overrideTargetNodeId: stringField(value, 'overrideTargetNodeId'),
    dispatchedAt: null,
    dispatchedBy: null,
    triggerRunId: null,
    stagedAt,
    stagedBy: manualCreatedBy,
    autoDispatchDeferredAt: null,
    sealedAt: null,
    sealedBy: null,
    confirmation: 'open',
    confirmedBy: null,
    confirmedByRole: null,
    confirmedAt: null,
    lastReassignedBy: null,
    lastReassignedAt: null,
    manualBody: stringField(value, 'manualBody'),
    manualCreatedBy,
    createdAt,
    updatedAt,
  }
}

export function manualQuestionProjectionDigest(input: {
  readonly sourceSnapshotDigest: string
  readonly question: ManualQuestionProjection
}): string {
  return sha256Hex(canonicalHumanGateValueJson(input))
}

export function encodeManualQuestionOpenManifest(manifest: ManualQuestionOpenManifest): string {
  return canonicalHumanGateValueJson(manifest)
}

export function decodeManualQuestionOpenManifest(raw: string): ManualQuestionOpenManifest {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    invalid('manual-question-open manifest is invalid JSON')
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'manual-question-open') {
    invalid('manual-question-open envelope is invalid')
  }
  const question = decodeQuestion(value.question)
  const gateRef = stringField(value, 'gateRef')
  const sourceSnapshotDigest = stringField(value, 'sourceSnapshotDigest')
  const nodeProjectionDigest = stringField(value, 'nodeProjectionDigest')
  if (
    gateRef !== `questions:${question.taskId}:manual:${question.id}` ||
    manualQuestionProjectionDigest({ sourceSnapshotDigest, question }) !== nodeProjectionDigest
  ) {
    invalid('manual-question-open identity or projection digest changed')
  }
  return {
    schemaVersion: 1,
    kind: 'manual-question-open',
    gateRef,
    sourceSnapshotDigest,
    nodeProjectionDigest,
    committedEventRef: stringField(value, 'committedEventRef'),
    question,
  }
}
