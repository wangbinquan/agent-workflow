// RFC-333 T6 — immutable review-open manifest consumed by TaskParkTx.

import { sha256Hex } from '@/util/hash'
import { canonicalHumanGateValueJson } from './canonicalGateRequest'
import { HumanGateOperationError } from './humanGateOperation'

export type ReviewGateNodeProjection = Readonly<{
  mode: 'mint' | 'reuse-pending' | 'reuse-awaiting'
  id: string
  taskId: string
  nodeId: string
  /** RFC-354 — the frame the review park row lives in. */
  containerRunId: string | null
  iteration: number
  reviewIteration: number
  previousConsumedUpstreamRunsJson: string | null
  consumedUpstreamRunsJson: string
  startedAt: number
}>

export type ReviewGateDocumentSelection = 'unselected' | 'accepted' | 'not_accepted'

export type ReviewGateDocumentProjection = Readonly<{
  id: string
  taskId: string
  reviewNodeId: string
  reviewNodeRunId: string
  sourceNodeId: string
  sourcePortName: string
  versionIndex: number
  reviewIteration: number
  bodyPath: string
  commentsJson: '[]'
  decision: 'pending'
  decisionReason: null
  promptSnapshot: string | null
  sourceFilePath: string | null
  itemIndex: number | null
  selection: ReviewGateDocumentSelection | null
  itemPath: string | null
  selectionStale: boolean | null
  roundGeneration: number | null
  createdAt: number
  decidedAt: null
  decidedBy: null
  decidedByRole: null
  artifactKey: string
  bodySha256: string
  byteSize: number
}>

export interface ReviewGateOpenManifest {
  readonly schemaVersion: 1
  readonly kind: 'review-open'
  readonly gateRef: string
  readonly sourceSnapshotDigest: string
  readonly nodeProjectionDigest: string
  readonly committedEventRef: string
  readonly node: ReviewGateNodeProjection
  readonly supersedePendingDocumentIds: readonly string[]
  readonly documents: readonly ReviewGateDocumentProjection[]
}

function invalid(message: string): never {
  throw new HumanGateOperationError('human-gate-operation-manifest-invalid', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) invalid(`review-open ${key} is invalid`)
  return field
}

function nonNegativeInteger(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    invalid(`review-open ${key} is invalid`)
  }
  return field as number
}

function nullableString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  if (field !== null && typeof field !== 'string') invalid(`review-open ${key} is invalid`)
  return field as string | null
}

function decodeNode(value: unknown): ReviewGateNodeProjection {
  if (!isRecord(value)) invalid('review-open node projection is invalid')
  const mode = value.mode
  if (mode !== 'mint' && mode !== 'reuse-pending' && mode !== 'reuse-awaiting') {
    invalid('review-open node projection mode is invalid')
  }
  const previousConsumedUpstreamRunsJson = nullableString(value, 'previousConsumedUpstreamRunsJson')
  const consumedUpstreamRunsJson = stringField(value, 'consumedUpstreamRunsJson')
  for (const [label, raw] of [
    ['consumed', consumedUpstreamRunsJson],
    ['previous consumed', previousConsumedUpstreamRunsJson],
  ] as const) {
    if (raw === null) continue
    try {
      const consumed: unknown = JSON.parse(raw)
      if (!isRecord(consumed)) invalid(`review-open ${label} upstream projection is invalid`)
    } catch (error) {
      if (error instanceof HumanGateOperationError) throw error
      invalid(`review-open ${label} upstream projection is invalid JSON`)
    }
  }
  if ((mode === 'reuse-awaiting') !== (previousConsumedUpstreamRunsJson !== null)) {
    invalid('review-open previous upstream projection does not match node mode')
  }
  return {
    mode,
    id: stringField(value, 'id'),
    taskId: stringField(value, 'taskId'),
    nodeId: stringField(value, 'nodeId'),
    containerRunId: nullableString(value, 'containerRunId'),
    iteration: nonNegativeInteger(value, 'iteration'),
    reviewIteration: nonNegativeInteger(value, 'reviewIteration'),
    previousConsumedUpstreamRunsJson,
    consumedUpstreamRunsJson,
    startedAt: nonNegativeInteger(value, 'startedAt'),
  }
}

function decodeDocument(value: unknown): ReviewGateDocumentProjection {
  if (!isRecord(value)) invalid('review-open document projection is invalid')
  const versionIndex = nonNegativeInteger(value, 'versionIndex')
  if (versionIndex === 0) invalid('review-open versionIndex is invalid')
  const itemIndex = value.itemIndex
  if (itemIndex !== null && (!Number.isSafeInteger(itemIndex) || (itemIndex as number) < 0)) {
    invalid('review-open itemIndex is invalid')
  }
  const selection = value.selection
  if (
    selection !== null &&
    selection !== 'unselected' &&
    selection !== 'accepted' &&
    selection !== 'not_accepted'
  ) {
    invalid('review-open selection is invalid')
  }
  const selectionStale = value.selectionStale
  if (selectionStale !== null && typeof selectionStale !== 'boolean') {
    invalid('review-open selectionStale is invalid')
  }
  const roundGeneration = value.roundGeneration
  if (
    roundGeneration !== null &&
    (!Number.isSafeInteger(roundGeneration) || (roundGeneration as number) < 0)
  ) {
    invalid('review-open roundGeneration is invalid')
  }
  if (
    value.commentsJson !== '[]' ||
    value.decision !== 'pending' ||
    value.decisionReason !== null ||
    value.decidedAt !== null ||
    value.decidedBy !== null ||
    value.decidedByRole !== null
  ) {
    invalid('review-open document terminal fields are invalid')
  }
  return {
    id: stringField(value, 'id'),
    taskId: stringField(value, 'taskId'),
    reviewNodeId: stringField(value, 'reviewNodeId'),
    reviewNodeRunId: stringField(value, 'reviewNodeRunId'),
    sourceNodeId: stringField(value, 'sourceNodeId'),
    sourcePortName: stringField(value, 'sourcePortName'),
    versionIndex,
    reviewIteration: nonNegativeInteger(value, 'reviewIteration'),
    bodyPath: stringField(value, 'bodyPath'),
    commentsJson: '[]',
    decision: 'pending',
    decisionReason: null,
    promptSnapshot: nullableString(value, 'promptSnapshot'),
    sourceFilePath: nullableString(value, 'sourceFilePath'),
    itemIndex: itemIndex as number | null,
    selection: selection as ReviewGateDocumentSelection | null,
    itemPath: nullableString(value, 'itemPath'),
    selectionStale: selectionStale as boolean | null,
    roundGeneration: roundGeneration as number | null,
    createdAt: nonNegativeInteger(value, 'createdAt'),
    decidedAt: null,
    decidedBy: null,
    decidedByRole: null,
    artifactKey: stringField(value, 'artifactKey'),
    bodySha256: stringField(value, 'bodySha256'),
    byteSize: nonNegativeInteger(value, 'byteSize'),
  }
}

export function reviewGateProjectionDigest(input: {
  readonly sourceSnapshotDigest: string
  readonly node: ReviewGateNodeProjection
  readonly supersedePendingDocumentIds: readonly string[]
  readonly documents: readonly ReviewGateDocumentProjection[]
}): string {
  return sha256Hex(
    canonicalHumanGateValueJson({
      sourceSnapshotDigest: input.sourceSnapshotDigest,
      node: input.node,
      supersedePendingDocumentIds: input.supersedePendingDocumentIds,
      documents: input.documents,
    }),
  )
}

export function encodeReviewGateOpenManifest(manifest: ReviewGateOpenManifest): string {
  return canonicalHumanGateValueJson(manifest)
}

export function decodeReviewGateOpenManifest(raw: string): ReviewGateOpenManifest {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    invalid('review-open manifest is invalid JSON')
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'review-open') {
    invalid('review-open manifest envelope is invalid')
  }
  if (!Array.isArray(value.documents) || value.documents.length === 0) {
    invalid('review-open manifest must contain at least one document')
  }
  const node = decodeNode(value.node)
  const documents = value.documents.map(decodeDocument)
  if (!Array.isArray(value.supersedePendingDocumentIds)) {
    invalid('review-open superseded document set is invalid')
  }
  const supersedePendingDocumentIds = value.supersedePendingDocumentIds.map((id) => {
    if (typeof id !== 'string' || id.length === 0) {
      invalid('review-open superseded document identity is invalid')
    }
    return id
  })
  if (
    new Set(supersedePendingDocumentIds).size !== supersedePendingDocumentIds.length ||
    (node.mode !== 'reuse-awaiting' && supersedePendingDocumentIds.length !== 0)
  ) {
    invalid('review-open superseded document set does not match node mode')
  }
  const sourceSnapshotDigest = stringField(value, 'sourceSnapshotDigest')
  const projectionDigest = reviewGateProjectionDigest({
    sourceSnapshotDigest,
    node,
    supersedePendingDocumentIds,
    documents,
  })
  const declaredDigest = stringField(value, 'nodeProjectionDigest')
  if (projectionDigest !== declaredDigest) invalid('review-open projection digest changed')
  if (
    documents.some(
      (document) =>
        document.taskId !== node.taskId ||
        document.reviewNodeId !== node.nodeId ||
        document.reviewNodeRunId !== node.id ||
        document.sourcePortName !== documents[0]!.sourcePortName,
    ) ||
    new Set(documents.map((document) => document.id)).size !== documents.length ||
    new Set(documents.map((document) => document.artifactKey)).size !== documents.length
  ) {
    invalid('review-open document set does not match its node projection')
  }
  return {
    schemaVersion: 1,
    kind: 'review-open',
    gateRef: stringField(value, 'gateRef'),
    sourceSnapshotDigest,
    nodeProjectionDigest: declaredDigest,
    committedEventRef: stringField(value, 'committedEventRef'),
    node,
    supersedePendingDocumentIds,
    documents,
  }
}
