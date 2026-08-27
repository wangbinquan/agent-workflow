// RFC-333 T6 — prepare the complete review round before TaskParkTx.

import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { sha256Hex } from '@/util/hash'
import type { HumanGateArtifactStore, PlannedReviewArtifact } from './ports/humanGateArtifactStore'
import type { HumanGateOperationStore } from './ports/humanGateOperationStore'
import type { CanonicalHumanGateRequest } from '../domain/canonicalGateRequest'
import {
  HumanGateOperationError,
  preparedHumanGateRef,
  type HumanGateOperationSnapshot,
  type PreparedHumanGateRef,
} from '../domain/humanGateOperation'
import {
  decodeReviewGateOpenManifest,
  encodeReviewGateOpenManifest,
  reviewGateProjectionDigest,
  type ReviewGateDocumentProjection,
  type ReviewGateDocumentSelection,
  type ReviewGateNodeProjection,
  type ReviewGateOpenManifest,
} from '../domain/reviewGateOpen'

export interface ReviewGateOpenDocumentDraft {
  readonly body: string
  readonly sourceNodeId: string
  readonly sourcePortName: string
  readonly versionIndex: number
  readonly reviewIteration: number
  readonly promptSnapshot?: string | null
  readonly sourceFilePath?: string | null
  readonly itemIndex?: number | null
  readonly selection?: ReviewGateDocumentSelection | null
  readonly itemPath?: string | null
  readonly selectionStale?: boolean | null
  readonly roundGeneration?: number | null
}

export interface PrepareReviewGateOpenInput {
  readonly taskId: string
  readonly reviewNodeId: string
  readonly iteration: number
  readonly reviewIteration: number
  readonly consumedUpstreamRunsJson: string
  readonly sourceSnapshotDigest: string
  readonly idempotencyKey: string
  readonly expectedTaskRevision: number
  readonly expectedGateRevision?: number
  readonly actorUserId?: string | null
  readonly reusePendingNodeRunId?: string
  readonly reuseAwaitingNodeRun?: Readonly<{
    id: string
    consumedUpstreamRunsJson: string
  }>
  readonly supersedePendingDocumentIds?: readonly string[]
  readonly documents: readonly ReviewGateOpenDocumentDraft[]
  readonly now?: number
}

export type PreparedReviewGateOpen = Readonly<{
  kind: 'prepared'
  operation: HumanGateOperationSnapshot
  prepared: PreparedHumanGateRef
  manifest: ReviewGateOpenManifest
}>

export type CommittedReviewGateOpen = Readonly<{
  kind: 'already-committed'
  operation: HumanGateOperationSnapshot
  manifest: ReviewGateOpenManifest
}>

export type PrepareReviewGateOpenResult = PreparedReviewGateOpen | CommittedReviewGateOpen

function reviewBodyPath(input: {
  taskId: string
  reviewNodeId: string
  sourcePortName: string
  operationId: string
  versionIndex: number
  itemIndex: number | null
}): string {
  const item = input.itemIndex === null ? '' : `/item_${input.itemIndex}`
  return `runs/${input.taskId}/review/${input.reviewNodeId}/${input.sourcePortName}/round_${input.operationId}${item}/v${input.versionIndex}.md`
}

function assertInput(input: PrepareReviewGateOpenInput): void {
  const supersedePendingDocumentIds = input.supersedePendingDocumentIds ?? []
  if (
    input.taskId.length === 0 ||
    input.reviewNodeId.length === 0 ||
    input.idempotencyKey.length === 0 ||
    input.sourceSnapshotDigest.length === 0 ||
    !Number.isSafeInteger(input.expectedTaskRevision) ||
    input.expectedTaskRevision < 0 ||
    (input.expectedGateRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedGateRevision) || input.expectedGateRevision < 0)) ||
    input.documents.length === 0 ||
    (input.reusePendingNodeRunId !== undefined && input.reuseAwaitingNodeRun !== undefined) ||
    (input.reuseAwaitingNodeRun === undefined &&
      (input.supersedePendingDocumentIds?.length ?? 0) !== 0) ||
    (input.reuseAwaitingNodeRun !== undefined &&
      (input.reuseAwaitingNodeRun.id.length === 0 ||
        input.reuseAwaitingNodeRun.consumedUpstreamRunsJson.length === 0)) ||
    new Set(supersedePendingDocumentIds).size !== supersedePendingDocumentIds.length ||
    supersedePendingDocumentIds.some((documentId) => documentId.length === 0)
  ) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'review-open preparation identity or revision is invalid',
    )
  }
  if (input.reuseAwaitingNodeRun !== undefined) {
    try {
      const consumed: unknown = JSON.parse(input.reuseAwaitingNodeRun.consumedUpstreamRunsJson)
      if (consumed === null || typeof consumed !== 'object' || Array.isArray(consumed)) {
        throw new Error('invalid-consumed-upstream-runs')
      }
    } catch {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        'review-open previous upstream projection is invalid',
      )
    }
  }
  for (const document of input.documents) {
    if (
      !Number.isSafeInteger(document.versionIndex) ||
      document.versionIndex <= 0 ||
      !Number.isSafeInteger(document.reviewIteration) ||
      document.reviewIteration < 0 ||
      (document.itemIndex !== undefined &&
        document.itemIndex !== null &&
        (!Number.isSafeInteger(document.itemIndex) || document.itemIndex < 0))
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        'review-open document ordinal is invalid',
      )
    }
  }
}

function sameArtifact(
  left: {
    artifactKey: string
    stagedPath: string
    finalPath: string
    sha256: string
    byteSize: number
  },
  right: PlannedReviewArtifact,
): boolean {
  return (
    left.artifactKey === right.artifactKey &&
    left.stagedPath === right.stagedPath &&
    left.finalPath === right.finalPath &&
    left.sha256 === right.sha256 &&
    left.byteSize === right.byteSize
  )
}

export class ReviewGateOpenPreparation {
  constructor(
    private readonly db: DbClient,
    private readonly operations: HumanGateOperationStore,
    private readonly artifacts: HumanGateArtifactStore,
  ) {}

  prepare(input: PrepareReviewGateOpenInput): PrepareReviewGateOpenResult {
    assertInput(input)
    const requestedAt = input.now ?? Date.now()
    const existing = dbTxSync(this.db, (tx) =>
      this.operations.findByIdempotencyTx({
        tx,
        taskId: input.taskId,
        gateKind: 'review',
        operationKind: 'open',
        idempotencyKey: input.idempotencyKey,
      }),
    )
    const operationId = existing?.id ?? ulid(requestedAt)
    const createdAt = existing?.createdAt ?? requestedAt
    const reviewNodeRunId =
      input.reusePendingNodeRunId ?? input.reuseAwaitingNodeRun?.id ?? operationId
    const gateRef = existing?.gateRef ?? `review:${reviewNodeRunId}`
    const latestGateRevision = dbTxSync(this.db, (tx) =>
      this.operations.latestGateRevisionTx({ tx, gateKind: 'review', gateRef }),
    )
    const expectedGateRevision =
      existing?.expectedGateRevision ?? input.expectedGateRevision ?? latestGateRevision
    if (existing === null && expectedGateRevision !== latestGateRevision) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `review-open gate '${gateRef}' revision changed before preparation`,
        {
          expectedGateRevision,
          currentGateRevision: latestGateRevision,
        },
      )
    }
    const supersedePendingDocumentIds = [...(input.supersedePendingDocumentIds ?? [])].sort()
    const node: ReviewGateNodeProjection = {
      mode:
        input.reuseAwaitingNodeRun !== undefined
          ? 'reuse-awaiting'
          : input.reusePendingNodeRunId === undefined
            ? 'mint'
            : 'reuse-pending',
      id: reviewNodeRunId,
      taskId: input.taskId,
      nodeId: input.reviewNodeId,
      iteration: input.iteration,
      reviewIteration: input.reviewIteration,
      previousConsumedUpstreamRunsJson:
        input.reuseAwaitingNodeRun?.consumedUpstreamRunsJson ?? null,
      consumedUpstreamRunsJson: input.consumedUpstreamRunsJson,
      startedAt: createdAt,
    }
    const planned = input.documents.map((draft, index) => {
      const artifactKey = `review-doc:${String(index).padStart(6, '0')}`
      const itemIndex = draft.itemIndex ?? null
      const bodyPath = reviewBodyPath({
        taskId: input.taskId,
        reviewNodeId: input.reviewNodeId,
        sourcePortName: draft.sourcePortName,
        operationId,
        versionIndex: draft.versionIndex,
        itemIndex,
      })
      const plan = this.artifacts.planReviewArtifact({
        operationId,
        artifactKey,
        finalPath: bodyPath,
        body: draft.body,
      })
      const document: ReviewGateDocumentProjection = {
        id: `${operationId}:doc:${String(index).padStart(6, '0')}`,
        taskId: input.taskId,
        reviewNodeId: input.reviewNodeId,
        reviewNodeRunId,
        sourceNodeId: draft.sourceNodeId,
        sourcePortName: draft.sourcePortName,
        versionIndex: draft.versionIndex,
        reviewIteration: draft.reviewIteration,
        bodyPath,
        commentsJson: '[]',
        decision: 'pending',
        decisionReason: null,
        promptSnapshot: draft.promptSnapshot ?? null,
        sourceFilePath: draft.sourceFilePath ?? null,
        itemIndex,
        selection: itemIndex === null ? null : (draft.selection ?? 'unselected'),
        itemPath: draft.itemPath ?? null,
        selectionStale: itemIndex === null ? null : (draft.selectionStale ?? false),
        roundGeneration: itemIndex === null ? null : (draft.roundGeneration ?? null),
        createdAt,
        decidedAt: null,
        decidedBy: null,
        decidedByRole: null,
        artifactKey,
        bodySha256: plan.sha256,
        byteSize: plan.byteSize,
      }
      return { plan, document, body: draft.body }
    })
    const documents = planned.map((entry) => entry.document)
    const nodeProjectionDigest = reviewGateProjectionDigest({
      sourceSnapshotDigest: input.sourceSnapshotDigest,
      node,
      supersedePendingDocumentIds,
      documents,
    })
    const manifest: ReviewGateOpenManifest = {
      schemaVersion: 1,
      kind: 'review-open',
      gateRef,
      sourceSnapshotDigest: input.sourceSnapshotDigest,
      nodeProjectionDigest,
      committedEventRef: `review-open:${operationId}`,
      node,
      supersedePendingDocumentIds,
      documents,
    }
    const manifestJson = encodeReviewGateOpenManifest(manifest)
    const request: CanonicalHumanGateRequest = {
      schemaVersion: 1,
      taskId: input.taskId,
      gateKind: 'review',
      operationKind: 'open',
      gateRef,
      actorUserId: input.actorUserId ?? null,
      expectedTaskRevision: input.expectedTaskRevision,
      expectedGateRevision,
      payload: { kind: 'open', manifestDigest: sha256Hex(manifestJson) },
    }
    let operation = dbTxSync(this.db, (tx) => {
      const begun = this.operations.beginTx({
        tx,
        operationId,
        request,
        idempotencyKey: input.idempotencyKey,
        now: requestedAt,
      })
      if (!begun.replayed) {
        this.operations.declareArtifactsTx({
          tx,
          operationId: begun.operation.id,
          artifacts: planned.map(({ plan }) => plan),
          now: requestedAt,
        })
      } else if (begun.operation.state === 'preparing') {
        const declared = this.operations.listArtifactsTx(tx, begun.operation.id)
        if (
          declared.length !== planned.length ||
          declared.some((artifact, index) => !sameArtifact(artifact, planned[index]!.plan))
        ) {
          throw new HumanGateOperationError(
            'human-gate-idempotency-conflict',
            `review-open operation '${begun.operation.id}' artifact plan changed during replay`,
            { operationId: begun.operation.id },
          )
        }
      }
      return begun.operation
    })

    if (operation.state === 'prepared') {
      const stored = decodeReviewGateOpenManifest(operation.manifestJson)
      return {
        kind: 'prepared',
        operation,
        prepared: preparedHumanGateRef(operation),
        manifest: stored,
      }
    }
    if (operation.state === 'committed' || operation.state === 'completed') {
      return {
        kind: 'already-committed',
        operation,
        manifest: decodeReviewGateOpenManifest(operation.manifestJson),
      }
    }
    if (operation.state !== 'preparing') {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `review-open operation '${operation.id}' cannot resume from '${operation.state}'`,
        { operationId: operation.id, currentState: operation.state },
      )
    }

    for (const entry of planned) {
      const receiptJson = this.artifacts.stageReviewArtifact(entry.plan, entry.body)
      dbTxSync(this.db, (tx) =>
        this.operations.transitionArtifactTx({
          tx,
          operationId: operation.id,
          artifactKey: entry.plan.artifactKey,
          from: 'declared',
          to: 'staged',
          receiptJson,
          expectedClaimEpoch: operation.claimEpoch,
          now: requestedAt,
        }),
      )
    }
    operation = dbTxSync(this.db, (tx) =>
      this.operations.markPreparedTx({
        tx,
        operationId: operation.id,
        expectedClaimEpoch: operation.claimEpoch,
        manifestJson,
        now: requestedAt,
      }),
    )
    return {
      kind: 'prepared',
      operation,
      prepared: preparedHumanGateRef(operation),
      manifest,
    }
  }
}
