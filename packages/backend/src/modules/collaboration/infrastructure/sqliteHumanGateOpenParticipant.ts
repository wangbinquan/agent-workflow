// RFC-333 — collaboration's offered participant for an owned TaskParkTx.

import type { DbTxSync } from '@/db/txSync'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { SYSTEM_DECIDER } from '@agent-workflow/shared'
import {
  clarifyRounds,
  collaborationGateOperations,
  docVersions,
  nodeRunEvents,
  nodeRuns,
  reviewComments,
  taskQuestions,
} from '@/db/schema'
import { transitionNodeRunStatusTx } from '@/services/lifecycle'
import { mintNodeRunTx } from '@/services/nodeRunMint'
import { sha256Hex } from '@/util/hash'
import type {
  HumanGateOpenParticipantInTx,
  HumanGateOpenParticipantResult,
} from '../application/ports/humanGateOpenParticipant'
import type { HumanGateOperationStore } from '../application/ports/humanGateOperationStore'
import { HumanGateOperationError } from '../domain/humanGateOperation'
import {
  decodeClarifyGateOpenManifest,
  type ClarifyGateOpenManifest,
} from '../domain/clarifyGateOpen'
import {
  decodeManualQuestionOpenManifest,
  type ManualQuestionOpenManifest,
} from '../domain/manualQuestionOpen'
import { decodeReviewGateOpenManifest, type ReviewGateOpenManifest } from '../domain/reviewGateOpen'

interface PreparedOpenManifest {
  readonly schemaVersion: 1
  readonly kind: 'review-open' | 'clarify-open' | 'questions-open' | 'manual-question-open'
  readonly gateRef: string
  readonly nodeProjectionDigest: string
  readonly committedEventRef: string
}

function decodePreparedOpenManifest(raw: string): PreparedOpenManifest {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'prepared human-gate open manifest is not valid JSON',
    )
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'prepared human-gate open manifest must be an object',
    )
  }
  const value = decoded as Partial<PreparedOpenManifest>
  if (
    value.schemaVersion !== 1 ||
    !['review-open', 'clarify-open', 'questions-open', 'manual-question-open'].includes(
      value.kind ?? '',
    ) ||
    typeof value.gateRef !== 'string' ||
    value.gateRef.length === 0 ||
    typeof value.nodeProjectionDigest !== 'string' ||
    value.nodeProjectionDigest.length === 0 ||
    typeof value.committedEventRef !== 'string' ||
    value.committedEventRef.length === 0
  ) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'prepared human-gate open manifest lacks its exact projection or event identity',
    )
  }
  return value as PreparedOpenManifest
}

/** The collaboration-owned review projection applied inside TaskParkTx. */
function projectReviewGateOpenTx(tx: DbTxSync, manifest: ReviewGateOpenManifest): void {
  const node = manifest.node
  if (node.mode === 'mint') {
    if (tx.select({ id: nodeRuns.id }).from(nodeRuns).where(eq(nodeRuns.id, node.id)).get()) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `review-open node projection '${node.id}' already exists`,
      )
    }
    mintNodeRunTx(tx, {
      id: node.id,
      taskId: node.taskId,
      nodeId: node.nodeId,
      status: 'awaiting_review',
      cause: 'review-park',
      iteration: node.iteration,
      overrides: {
        reviewIteration: node.reviewIteration,
        consumedUpstreamRunsJson: node.consumedUpstreamRunsJson,
        startedAt: node.startedAt,
      },
    })
  } else {
    const existing = tx
      .select({
        id: nodeRuns.id,
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        iteration: nodeRuns.iteration,
        reviewIteration: nodeRuns.reviewIteration,
        status: nodeRuns.status,
        consumedUpstreamRunsJson: nodeRuns.consumedUpstreamRunsJson,
      })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.id, node.id),
          eq(nodeRuns.taskId, node.taskId),
          eq(nodeRuns.nodeId, node.nodeId),
        ),
      )
      .get()
    const expectedStatus = node.mode === 'reuse-pending' ? 'pending' : 'awaiting_review'
    if (
      existing === undefined ||
      existing.status !== expectedStatus ||
      existing.iteration !== node.iteration ||
      existing.reviewIteration !== node.reviewIteration ||
      (node.mode === 'reuse-awaiting' &&
        existing.consumedUpstreamRunsJson !== node.previousConsumedUpstreamRunsJson)
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `review-open reused node projection '${node.id}' changed before park`,
      )
    }
    if (node.mode === 'reuse-pending') {
      transitionNodeRunStatusTx({
        tx,
        nodeRunId: node.id,
        event: { kind: 'park-review' },
        extra: {
          startedAt: node.startedAt,
          consumedUpstreamRunsJson: node.consumedUpstreamRunsJson,
        },
      })
    } else {
      const sourcePortName = manifest.documents[0]!.sourcePortName
      const currentPendingIds = tx
        .select({ id: docVersions.id })
        .from(docVersions)
        .where(
          and(
            eq(docVersions.reviewNodeRunId, node.id),
            eq(docVersions.sourcePortName, sourcePortName),
            eq(docVersions.decision, 'pending'),
          ),
        )
        .all()
        .map((document) => document.id)
        .sort()
      if (
        currentPendingIds.length !== manifest.supersedePendingDocumentIds.length ||
        currentPendingIds.some(
          (documentId, index) => documentId !== manifest.supersedePendingDocumentIds[index],
        )
      ) {
        throw new HumanGateOperationError(
          'human-gate-operation-stale',
          `review-open pending document set for '${node.id}' changed before refresh`,
        )
      }
      if (currentPendingIds.length > 0) {
        tx.delete(reviewComments)
          .where(inArray(reviewComments.docVersionId, currentPendingIds))
          .run()
        tx.update(docVersions)
          .set({
            decision: 'superseded',
            decisionReason: 'upstream-refreshed',
            decidedBy: SYSTEM_DECIDER,
            decidedAt: node.startedAt,
          })
          .where(inArray(docVersions.id, currentPendingIds))
          .run()
      }
      tx.update(nodeRuns)
        .set({ consumedUpstreamRunsJson: node.consumedUpstreamRunsJson })
        .where(eq(nodeRuns.id, node.id))
        .run()
    }
  }

  for (const document of manifest.documents) {
    tx.insert(docVersions)
      .values({
        id: document.id,
        taskId: document.taskId,
        reviewNodeId: document.reviewNodeId,
        reviewNodeRunId: document.reviewNodeRunId,
        sourceNodeId: document.sourceNodeId,
        sourcePortName: document.sourcePortName,
        versionIndex: document.versionIndex,
        reviewIteration: document.reviewIteration,
        bodyPath: document.bodyPath,
        commentsJson: document.commentsJson,
        decision: document.decision,
        decisionReason: document.decisionReason,
        promptSnapshot: document.promptSnapshot,
        sourceFilePath: document.sourceFilePath,
        itemIndex: document.itemIndex,
        selection: document.selection,
        itemPath: document.itemPath,
        selectionStale: document.selectionStale,
        roundGeneration: document.roundGeneration,
        createdAt: document.createdAt,
        decidedAt: document.decidedAt,
        decidedBy: document.decidedBy,
        decidedByRole: document.decidedByRole,
      })
      .run()
  }
  tx.insert(nodeRunEvents)
    .values({
      nodeRunId: node.id,
      ts: node.startedAt,
      kind: 'text',
      payload: `[rfc333/review-opened] ${JSON.stringify({
        eventRef: manifest.committedEventRef,
        gateRef: manifest.gateRef,
        documents: manifest.documents.length,
        sourceSnapshotDigest: manifest.sourceSnapshotDigest,
      })}`,
    })
    .run()
}

/** The collaboration-owned clarify node + round + eager question projection. */
export function projectClarifyGateOpenTx(tx: DbTxSync, manifest: ClarifyGateOpenManifest): void {
  const node = manifest.node
  if (node.mode === 'mint') {
    if (tx.select({ id: nodeRuns.id }).from(nodeRuns).where(eq(nodeRuns.id, node.id)).get()) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `clarify-open node projection '${node.id}' already exists`,
      )
    }
    mintNodeRunTx(tx, {
      id: node.id,
      taskId: node.taskId,
      nodeId: node.nodeId,
      status: 'awaiting_human',
      cause: node.cause,
      iteration: node.runIteration,
      overrides: {
        parentNodeRunId: node.parentNodeRunId,
        shardKey: node.shardKey,
        startedAt: node.startedAt,
      },
    })
  } else {
    const existing = tx
      .select({
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        iteration: nodeRuns.iteration,
        parentNodeRunId: nodeRuns.parentNodeRunId,
        shardKey: nodeRuns.shardKey,
        startedAt: nodeRuns.startedAt,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, node.id))
      .get()
    const expectedStatus =
      node.mode === 'reuse-pending'
        ? 'pending'
        : node.mode === 'reuse-running'
          ? 'running'
          : 'awaiting_human'
    if (
      existing === undefined ||
      existing.taskId !== node.taskId ||
      existing.nodeId !== node.nodeId ||
      existing.status !== expectedStatus ||
      existing.iteration !== node.runIteration ||
      existing.parentNodeRunId !== node.parentNodeRunId ||
      existing.shardKey !== node.shardKey ||
      existing.startedAt !== node.previousStartedAt
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `clarify-open reused node projection '${node.id}' changed before park`,
      )
    }
    if (node.mode === 'reuse-pending' || node.mode === 'reuse-running') {
      transitionNodeRunStatusTx({
        tx,
        nodeRunId: node.id,
        event: { kind: 'park-human' },
        extra: { startedAt: node.startedAt },
      })
    }
  }

  if (
    tx
      .select({ id: clarifyRounds.id })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, manifest.round.id))
      .get()
  ) {
    throw new HumanGateOperationError(
      'human-gate-operation-stale',
      `clarify-open round projection '${manifest.round.id}' already exists`,
    )
  }
  tx.insert(clarifyRounds).values(manifest.round).run()

  for (const question of manifest.questions) {
    if (question.mode === 'insert') {
      const conflict = tx
        .select({ id: taskQuestions.id })
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.originNodeRunId, question.originNodeRunId),
            eq(taskQuestions.questionId, question.questionId),
            eq(taskQuestions.roleKind, question.roleKind),
          ),
        )
        .get()
      if (conflict !== undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-stale',
          `clarify-open question projection '${question.questionId}' appeared before park`,
        )
      }
      tx.insert(taskQuestions)
        .values({
          id: question.id,
          taskId: question.taskId,
          originNodeRunId: question.originNodeRunId,
          questionId: question.questionId,
          questionTitle: question.questionTitle,
          sourceKind: question.sourceKind,
          roleKind: question.roleKind,
          iteration: question.iteration,
          loopIter: question.loopIter,
          defaultTargetNodeId: question.defaultTargetNodeId,
          overrideTargetNodeId: null,
          dispatchedAt: null,
          dispatchedBy: null,
          triggerRunId: null,
          stagedAt: null,
          stagedBy: null,
          autoDispatchDeferredAt: null,
          sealedAt: null,
          sealedBy: null,
          confirmation: 'open',
          confirmedBy: null,
          confirmedByRole: null,
          confirmedAt: null,
          lastReassignedBy: null,
          lastReassignedAt: null,
          manualBody: null,
          manualCreatedBy: null,
          createdAt: question.createdAt,
          updatedAt: question.updatedAt,
        })
        .run()
      continue
    }
    const existing = tx.select().from(taskQuestions).where(eq(taskQuestions.id, question.id)).get()
    if (
      existing === undefined ||
      existing.taskId !== question.taskId ||
      existing.originNodeRunId !== question.originNodeRunId ||
      existing.questionId !== question.questionId ||
      existing.sourceKind !== question.sourceKind ||
      existing.roleKind !== question.roleKind ||
      existing.iteration !== question.iteration ||
      existing.loopIter !== question.loopIter ||
      existing.createdAt !== question.createdAt ||
      existing.questionTitle !== question.previousQuestionTitle ||
      existing.defaultTargetNodeId !== question.previousDefaultTargetNodeId ||
      existing.updatedAt !== question.previousUpdatedAt
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `clarify-open existing question projection '${question.questionId}' changed before park`,
      )
    }
    tx.update(taskQuestions)
      .set({
        questionTitle: question.questionTitle,
        defaultTargetNodeId: question.defaultTargetNodeId,
        updatedAt: question.updatedAt,
      })
      .where(eq(taskQuestions.id, question.id))
      .run()
  }
  tx.insert(nodeRunEvents)
    .values({
      nodeRunId: node.id,
      ts: manifest.round.createdAt,
      kind: 'text',
      payload: `[rfc333/clarify-opened] ${JSON.stringify({
        eventRef: manifest.committedEventRef,
        gateRef: manifest.gateRef,
        kind: manifest.round.kind,
        roundId: manifest.round.id,
        questions: manifest.questions.length,
        sourceSnapshotDigest: manifest.sourceSnapshotDigest,
      })}`,
    })
    .run()
}

function manualQuestionStillOutstanding(
  tx: DbTxSync,
  manifest: ManualQuestionOpenManifest,
): boolean {
  const expected = manifest.question
  const row = tx.select().from(taskQuestions).where(eq(taskQuestions.id, expected.id)).get()
  if (row === undefined) return false
  if (
    row.taskId !== expected.taskId ||
    row.originNodeRunId !== expected.originNodeRunId ||
    row.questionId !== expected.questionId ||
    row.questionTitle !== expected.questionTitle ||
    row.sourceKind !== 'manual' ||
    row.roleKind !== 'designer' ||
    row.manualBody !== expected.manualBody ||
    row.manualCreatedBy !== expected.manualCreatedBy ||
    row.createdAt !== expected.createdAt
  ) {
    throw new HumanGateOperationError(
      'human-gate-operation-stale',
      `manual question '${expected.id}' identity changed before its park obligation`,
    )
  }
  // A mixed-cause batch may dispatch one predecessor rerun and atomically mark
  // this lower-priority manual entry for automatic follow-up.  That durable
  // marker means no human action is outstanding: parking before the DAG tick
  // would prevent the predecessor from finishing, so the follow-up could
  // never dispatch.  The DAG's ordinary undispatched-entry park remains the
  // fallback if the queued handoff later cannot make progress.
  return (
    row.confirmation === 'open' && row.dispatchedAt === null && row.autoDispatchDeferredAt === null
  )
}

export class SqliteHumanGateOpenParticipantInTx implements HumanGateOpenParticipantInTx {
  constructor(
    private readonly tx: DbTxSync,
    private readonly operations: HumanGateOperationStore,
  ) {}

  listPreparedManualQuestionParksTx(taskId: string): readonly string[] {
    return this.tx
      .select({ id: collaborationGateOperations.id })
      .from(collaborationGateOperations)
      .where(
        and(
          eq(collaborationGateOperations.taskId, taskId),
          eq(collaborationGateOperations.gateKind, 'questions'),
          eq(collaborationGateOperations.operationKind, 'manual-question-open'),
          eq(collaborationGateOperations.state, 'prepared'),
        ),
      )
      .orderBy(asc(collaborationGateOperations.createdAt), asc(collaborationGateOperations.id))
      .all()
      .map((operation) => operation.id)
  }

  consumeManualQuestionParkTx(input: {
    readonly operationId: string
    readonly taskId: string
    readonly now: number
  }): Readonly<{
    outstanding: boolean
    nodeProjectionDigest: string
    committedEventRef: string
  }> {
    const operation = this.operations.getTx(this.tx, input.operationId)
    if (
      operation === null ||
      operation.state !== 'prepared' ||
      operation.taskId !== input.taskId ||
      operation.gateKind !== 'questions' ||
      operation.operationKind !== 'manual-question-open'
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `manual-question operation '${input.operationId}' changed before owner settle`,
        { operationId: input.operationId },
      )
    }
    const manifest = decodeManualQuestionOpenManifest(operation.manifestJson)
    if (
      manifest.question.taskId !== operation.taskId ||
      manifest.gateRef !== operation.gateRef ||
      this.operations.listArtifactsTx(this.tx, operation.id).length !== 0
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        'manual-question operation identity or artifact set changed',
      )
    }
    const outstanding = manualQuestionStillOutstanding(this.tx, manifest)
    const receiptJson = JSON.stringify({
      v: 1,
      operationId: operation.id,
      gate: { kind: operation.gateKind, ref: operation.gateRef },
      nodeProjectionDigest: manifest.nodeProjectionDigest,
      committedEventRef: manifest.committedEventRef,
      acceptedAt: input.now,
      outstanding,
    })
    const committed = this.operations.commitTx({
      tx: this.tx,
      operationId: operation.id,
      expectedClaimEpoch: operation.claimEpoch,
      receiptJson,
      now: input.now,
    })
    this.operations.completeTx({
      tx: this.tx,
      operationId: operation.id,
      expectedClaimEpoch: committed.claimEpoch,
      now: input.now,
    })
    return {
      outstanding,
      nodeProjectionDigest: manifest.nodeProjectionDigest,
      committedEventRef: manifest.committedEventRef,
    }
  }

  consumePreparedGateTx(
    input: Parameters<HumanGateOpenParticipantInTx['consumePreparedGateTx']>[0],
  ): HumanGateOpenParticipantResult {
    const operation = this.operations.getTx(this.tx, input.prepared.operationId)
    if (
      operation === null ||
      operation.state !== 'prepared' ||
      (operation.operationKind !== 'open' && operation.operationKind !== 'manual-question-open') ||
      operation.taskId !== input.prepared.taskId ||
      operation.gateKind !== input.prepared.gateKind ||
      operation.expectedTaskRevision !== input.taskRevision ||
      sha256Hex(operation.manifestJson) !== input.prepared.manifestDigest
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `prepared human-gate operation '${input.prepared.operationId}' changed before TaskParkTx`,
        { operationId: input.prepared.operationId },
      )
    }
    const manifest = decodePreparedOpenManifest(operation.manifestJson)
    if (manifest.gateRef !== operation.gateRef) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        'prepared human-gate manifest gate identity changed',
      )
    }
    const artifacts = this.operations.listArtifactsTx(this.tx, operation.id)
    if (artifacts.some((artifact) => artifact.state !== 'staged')) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `prepared human-gate operation '${operation.id}' has un-staged artifacts`,
        { operationId: operation.id },
      )
    }
    if (manifest.kind === 'review-open') {
      const reviewManifest = decodeReviewGateOpenManifest(operation.manifestJson)
      if (
        reviewManifest.node.taskId !== operation.taskId ||
        reviewManifest.gateRef !== operation.gateRef ||
        artifacts.length !== reviewManifest.documents.length
      ) {
        throw new HumanGateOperationError(
          'human-gate-operation-manifest-invalid',
          'review-open operation identity or artifact count changed',
        )
      }
      const artifactByKey = new Map(artifacts.map((artifact) => [artifact.artifactKey, artifact]))
      for (const document of reviewManifest.documents) {
        const artifact = artifactByKey.get(document.artifactKey)
        if (
          artifact === undefined ||
          artifact.finalPath !== document.bodyPath ||
          artifact.sha256 !== document.bodySha256 ||
          artifact.byteSize !== document.byteSize
        ) {
          throw new HumanGateOperationError(
            'human-gate-operation-manifest-invalid',
            `review-open artifact '${document.artifactKey}' changed before park`,
          )
        }
      }
      projectReviewGateOpenTx(this.tx, reviewManifest)
    } else if (manifest.kind === 'clarify-open') {
      const clarifyManifest = decodeClarifyGateOpenManifest(operation.manifestJson)
      if (
        clarifyManifest.node.taskId !== operation.taskId ||
        clarifyManifest.gateRef !== operation.gateRef ||
        operation.gateKind !== 'clarify' ||
        artifacts.length !== 0
      ) {
        throw new HumanGateOperationError(
          'human-gate-operation-manifest-invalid',
          'clarify-open operation identity or artifact set changed',
        )
      }
      projectClarifyGateOpenTx(this.tx, clarifyManifest)
    }
    const receiptJson = JSON.stringify({
      v: 1,
      operationId: operation.id,
      gate: { kind: operation.gateKind, ref: operation.gateRef },
      nodeProjectionDigest: manifest.nodeProjectionDigest,
      committedEventRef: manifest.committedEventRef,
      acceptedAt: input.now,
    })
    const committed = this.operations.commitTx({
      tx: this.tx,
      operationId: operation.id,
      expectedClaimEpoch: operation.claimEpoch,
      receiptJson,
      now: input.now,
    })
    if (manifest.kind === 'clarify-open') {
      this.operations.completeTx({
        tx: this.tx,
        operationId: operation.id,
        expectedClaimEpoch: operation.claimEpoch,
        now: input.now,
      })
    }
    if (committed.resultGateRevision === null) {
      throw new Error('committed-human-gate-open-lacks-revision')
    }
    return {
      gate: { kind: operation.gateKind, ref: operation.gateRef },
      gateRevision: committed.resultGateRevision,
      nodeProjectionDigest: manifest.nodeProjectionDigest,
      committedEventRef: manifest.committedEventRef,
    }
  }
}
