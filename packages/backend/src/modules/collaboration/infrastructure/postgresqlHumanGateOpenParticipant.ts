// RFC-349 — PostgreSQL participant consumed by task-execution's human-gate
// park atom. Collaboration owns every gate projection and journal mutation;
// task-execution supplies the already-open provider transaction.

import { SYSTEM_DECIDER } from '@agent-workflow/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'

import {
  clarifyRounds,
  collaborationGateArtifacts,
  collaborationGateOperations,
  docVersions,
  nodeRunEvents,
  nodeRuns,
  reviewComments,
  taskQuestions,
} from '@/db/schema'
import type { NodeRunLifecycleParticipantInTx } from '@/modules/task-execution/public/commands'
import type { PostgresqlCommittedEventTransaction } from '@/platform/events/committed/postgresqlPersistence'
import { DomainError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type {
  HumanGateNodeRunMintParticipantInTx,
  HumanGateOpenParticipantResult,
} from '../application/ports/humanGateOpenParticipant'
import type { PreparedHumanGateRef } from '../domain/humanGateOperation'
import {
  HumanGateOperationError,
  type HumanGateOperationSnapshot,
} from '../domain/humanGateOperation'
import {
  decodeClarifyGateOpenManifest,
  type ClarifyGateOpenManifest,
} from '../domain/clarifyGateOpen'
import {
  decodeManualQuestionOpenManifest,
  type ManualQuestionOpenManifest,
} from '../domain/manualQuestionOpen'
import { decodeReviewGateOpenManifest, type ReviewGateOpenManifest } from '../domain/reviewGateOpen'
import { DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS } from './humanGateOperationTransactionStore'
import { appendPostgresqlHumanGateOpenedEventTx } from './postgresqlCollaborationCommittedEvents'

type PgTx = PostgresqlCommittedEventTransaction

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

function operationSnapshot(
  row: typeof collaborationGateOperations.$inferSelect,
): HumanGateOperationSnapshot {
  return {
    id: row.id,
    taskId: row.taskId,
    gateKind: row.gateKind,
    operationKind: row.operationKind,
    gateRef: row.gateRef,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    actorUserId: row.actorUserId,
    expectedTaskRevision: row.expectedTaskRevision,
    expectedGateRevision: row.expectedGateRevision,
    resultGateRevision: row.resultGateRevision,
    state: row.state,
    claimEpoch: row.claimEpoch,
    claimExpiresAt: row.claimExpiresAt,
    schemaVersion: row.schemaVersion,
    manifestJson: row.manifestJson,
    receiptJson: row.receiptJson,
    failureJson: row.failureJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    committedAt: row.committedAt,
    completedAt: row.completedAt,
  }
}

async function operationById(tx: PgTx, operationId: string) {
  const rows = await tx
    .select()
    .from(collaborationGateOperations)
    .where(eq(collaborationGateOperations.id, operationId))
    .limit(1)
  return rows[0] ?? null
}

async function artifactsFor(tx: PgTx, operationId: string) {
  return await tx
    .select()
    .from(collaborationGateArtifacts)
    .where(eq(collaborationGateArtifacts.operationId, operationId))
    .orderBy(asc(collaborationGateArtifacts.artifactKey))
}

function stale(operationId: string): never {
  throw new HumanGateOperationError(
    'human-gate-operation-stale',
    `human-gate operation '${operationId}' changed before mutation`,
    { operationId },
  )
}

async function commitOperation(
  tx: PgTx,
  input: {
    operation: typeof collaborationGateOperations.$inferSelect
    receiptJson: string
    now: number
  },
): Promise<HumanGateOperationSnapshot> {
  const changed = await tx
    .update(collaborationGateOperations)
    .set({
      state: 'committed',
      resultGateRevision: input.operation.expectedGateRevision + 1,
      receiptJson: input.receiptJson,
      committedAt: input.now,
      claimExpiresAt: input.now + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(collaborationGateOperations.id, input.operation.id),
        eq(collaborationGateOperations.state, 'prepared'),
        eq(collaborationGateOperations.claimEpoch, input.operation.claimEpoch),
      ),
    )
    .returning()
  const row = changed[0]
  if (row === undefined) stale(input.operation.id)
  await tx
    .update(collaborationGateArtifacts)
    .set({ state: 'consumed', updatedAt: input.now })
    .where(
      and(
        eq(collaborationGateArtifacts.operationId, input.operation.id),
        eq(collaborationGateArtifacts.state, 'staged'),
      ),
    )
    .run()
  return operationSnapshot(row)
}

async function completeOperation(
  tx: PgTx,
  operationId: string,
  claimEpoch: number,
  now: number,
): Promise<void> {
  const unfinished = await tx
    .select({ artifactKey: collaborationGateArtifacts.artifactKey })
    .from(collaborationGateArtifacts)
    .where(
      and(
        eq(collaborationGateArtifacts.operationId, operationId),
        eq(collaborationGateArtifacts.state, 'consumed'),
      ),
    )
    .limit(1)
  if (unfinished[0] !== undefined) {
    throw new HumanGateOperationError(
      'human-gate-operation-transition-invalid',
      `human-gate artifact '${unfinished[0].artifactKey}' is not finalized`,
      { operationId, artifactKey: unfinished[0].artifactKey },
    )
  }
  const changed = await tx
    .update(collaborationGateOperations)
    .set({ state: 'completed', claimExpiresAt: null, completedAt: now, updatedAt: now })
    .where(
      and(
        eq(collaborationGateOperations.id, operationId),
        eq(collaborationGateOperations.state, 'committed'),
        eq(collaborationGateOperations.claimEpoch, claimEpoch),
      ),
    )
    .returning({ id: collaborationGateOperations.id })
  if (changed[0] === undefined) stale(operationId)
}

async function transitionGateNode(
  nodeRunLifecycle: NodeRunLifecycleParticipantInTx,
  input: {
    nodeRunId: string
    expectedStatus: 'pending' | 'running'
    event: { kind: 'park-review' } | { kind: 'park-human' }
    startedAt: number | null
    consumedUpstreamRunsJson?: string
  },
): Promise<void> {
  try {
    await nodeRunLifecycle.set({
      nodeRunId: input.nodeRunId,
      to: input.event.kind === 'park-review' ? 'awaiting_review' : 'awaiting_human',
      allowedFrom: [input.expectedStatus],
      extra: {
        startedAt: input.startedAt,
        ...(input.consumedUpstreamRunsJson === undefined
          ? {}
          : { consumedUpstreamRunsJson: input.consumedUpstreamRunsJson }),
      },
      reason: input.event.kind,
    })
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    stale(input.nodeRunId)
  }
}

async function projectReviewGateOpen(
  tx: PgTx,
  nodeRunMint: HumanGateNodeRunMintParticipantInTx<Promise<string>>,
  nodeRunLifecycle: NodeRunLifecycleParticipantInTx,
  manifest: ReviewGateOpenManifest,
): Promise<void> {
  const node = manifest.node
  if (node.mode === 'mint') {
    const existing = await tx
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, node.id))
      .limit(1)
    if (existing[0] !== undefined) stale(node.id)
    await nodeRunMint.mint({
      id: node.id,
      taskId: node.taskId,
      nodeId: node.nodeId,
      status: 'awaiting_review',
      cause: 'review-park',
      iteration: node.iteration,
      overrides: {
        reviewIteration: node.reviewIteration,
        startedAt: node.startedAt,
        consumedUpstreamRunsJson: node.consumedUpstreamRunsJson,
      },
    })
  } else {
    const existingRows = await tx
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
      .where(and(eq(nodeRuns.id, node.id), eq(nodeRuns.taskId, node.taskId)))
      .limit(1)
    const existing = existingRows[0]
    const expectedStatus = node.mode === 'reuse-pending' ? 'pending' : 'awaiting_review'
    if (
      existing === undefined ||
      existing.nodeId !== node.nodeId ||
      existing.status !== expectedStatus ||
      existing.iteration !== node.iteration ||
      existing.reviewIteration !== node.reviewIteration ||
      (node.mode === 'reuse-awaiting' &&
        existing.consumedUpstreamRunsJson !== node.previousConsumedUpstreamRunsJson)
    ) {
      stale(node.id)
    }
    if (node.mode === 'reuse-pending') {
      await transitionGateNode(nodeRunLifecycle, {
        nodeRunId: node.id,
        expectedStatus: 'pending',
        event: { kind: 'park-review' },
        startedAt: node.startedAt,
        consumedUpstreamRunsJson: node.consumedUpstreamRunsJson,
      })
    } else {
      const sourcePortName = manifest.documents[0]!.sourcePortName
      const pendingRows = await tx
        .select({ id: docVersions.id })
        .from(docVersions)
        .where(
          and(
            eq(docVersions.reviewNodeRunId, node.id),
            eq(docVersions.sourcePortName, sourcePortName),
            eq(docVersions.decision, 'pending'),
          ),
        )
      const currentPendingIds = pendingRows.map((document) => document.id).sort()
      if (
        currentPendingIds.length !== manifest.supersedePendingDocumentIds.length ||
        currentPendingIds.some(
          (documentId, index) => documentId !== manifest.supersedePendingDocumentIds[index],
        )
      ) {
        stale(node.id)
      }
      if (currentPendingIds.length > 0) {
        await tx
          .delete(reviewComments)
          .where(inArray(reviewComments.docVersionId, currentPendingIds))
          .run()
        await tx
          .update(docVersions)
          .set({
            decision: 'superseded',
            decisionReason: 'upstream-refreshed',
            decidedBy: SYSTEM_DECIDER,
            decidedAt: node.startedAt,
          })
          .where(inArray(docVersions.id, currentPendingIds))
          .run()
      }
      await tx
        .update(nodeRuns)
        .set({ consumedUpstreamRunsJson: node.consumedUpstreamRunsJson })
        .where(eq(nodeRuns.id, node.id))
        .run()
    }
  }

  for (const document of manifest.documents) {
    await tx
      .insert(docVersions)
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
  await tx
    .insert(nodeRunEvents)
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

async function projectClarifyGateOpen(
  tx: PgTx,
  nodeRunMint: HumanGateNodeRunMintParticipantInTx<Promise<string>>,
  nodeRunLifecycle: NodeRunLifecycleParticipantInTx,
  manifest: ClarifyGateOpenManifest,
): Promise<void> {
  const node = manifest.node
  if (node.mode === 'mint') {
    const existing = await tx
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, node.id))
      .limit(1)
    if (existing[0] !== undefined) stale(node.id)
    await nodeRunMint.mint({
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
    const existingRows = await tx
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
      .limit(1)
    const existing = existingRows[0]
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
      stale(node.id)
    }
    if (node.mode === 'reuse-pending' || node.mode === 'reuse-running') {
      await transitionGateNode(nodeRunLifecycle, {
        nodeRunId: node.id,
        expectedStatus: node.mode === 'reuse-pending' ? 'pending' : 'running',
        event: { kind: 'park-human' },
        startedAt: node.startedAt,
      })
    }
  }

  const roundRows = await tx
    .select({ id: clarifyRounds.id })
    .from(clarifyRounds)
    .where(eq(clarifyRounds.id, manifest.round.id))
    .limit(1)
  if (roundRows[0] !== undefined) stale(manifest.round.id)
  await tx.insert(clarifyRounds).values(manifest.round).run()

  for (const question of manifest.questions) {
    if (question.mode === 'insert') {
      const conflict = await tx
        .select({ id: taskQuestions.id })
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.originNodeRunId, question.originNodeRunId),
            eq(taskQuestions.questionId, question.questionId),
            eq(taskQuestions.roleKind, question.roleKind),
          ),
        )
        .limit(1)
      if (conflict[0] !== undefined) stale(question.id)
      await tx
        .insert(taskQuestions)
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
    const existingRows = await tx
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.id, question.id))
      .limit(1)
    const existing = existingRows[0]
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
      stale(question.id)
    }
    const changed = await tx
      .update(taskQuestions)
      .set({
        questionTitle: question.questionTitle,
        defaultTargetNodeId: question.defaultTargetNodeId,
        updatedAt: question.updatedAt,
      })
      .where(
        and(eq(taskQuestions.id, question.id), eq(taskQuestions.updatedAt, existing.updatedAt)),
      )
      .returning({ id: taskQuestions.id })
    if (changed[0] === undefined) stale(question.id)
  }
  await tx
    .insert(nodeRunEvents)
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

async function manualQuestionStillOutstanding(
  tx: PgTx,
  manifest: ManualQuestionOpenManifest,
): Promise<boolean> {
  const expected = manifest.question
  const rows = await tx
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.id, expected.id))
    .limit(1)
  const row = rows[0]
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
    stale(expected.id)
  }
  return (
    row.confirmation === 'open' && row.dispatchedAt === null && row.autoDispatchDeferredAt === null
  )
}

export class PostgresqlHumanGateOpenParticipantInTx {
  constructor(
    private readonly tx: PgTx,
    private readonly nodeRunMint: HumanGateNodeRunMintParticipantInTx<Promise<string>>,
    private readonly nodeRunLifecycle: NodeRunLifecycleParticipantInTx,
  ) {}

  async listPreparedManualQuestionParksTx(taskId: string): Promise<readonly string[]> {
    const rows = await this.tx
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
    return rows.map((operation) => operation.id)
  }

  async consumeManualQuestionParkTx(input: {
    readonly operationId: string
    readonly taskId: string
    readonly now: number
  }): Promise<
    Readonly<{
      outstanding: boolean
      nodeProjectionDigest: string
      committedEventRef: string
    }>
  > {
    const operation = await operationById(this.tx, input.operationId)
    if (
      operation === null ||
      operation.state !== 'prepared' ||
      operation.taskId !== input.taskId ||
      operation.gateKind !== 'questions' ||
      operation.operationKind !== 'manual-question-open'
    ) {
      stale(input.operationId)
    }
    const manifest = decodeManualQuestionOpenManifest(operation.manifestJson)
    const artifacts = await artifactsFor(this.tx, operation.id)
    if (
      manifest.question.taskId !== operation.taskId ||
      manifest.gateRef !== operation.gateRef ||
      artifacts.length !== 0
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        'manual-question operation identity or artifact set changed',
      )
    }
    const outstanding = await manualQuestionStillOutstanding(this.tx, manifest)
    const receiptJson = JSON.stringify({
      v: 1,
      operationId: operation.id,
      gate: { kind: operation.gateKind, ref: operation.gateRef },
      nodeProjectionDigest: manifest.nodeProjectionDigest,
      committedEventRef: manifest.committedEventRef,
      acceptedAt: input.now,
      outstanding,
    })
    await commitOperation(this.tx, { operation, receiptJson, now: input.now })
    await completeOperation(this.tx, operation.id, operation.claimEpoch, input.now)
    return {
      outstanding,
      nodeProjectionDigest: manifest.nodeProjectionDigest,
      committedEventRef: manifest.committedEventRef,
    }
  }

  async consumePreparedGateTx(input: {
    readonly prepared: PreparedHumanGateRef
    readonly taskRevision: number
    readonly now: number
  }): Promise<HumanGateOpenParticipantResult> {
    const operation = await operationById(this.tx, input.prepared.operationId)
    if (
      operation === null ||
      operation.state !== 'prepared' ||
      (operation.operationKind !== 'open' && operation.operationKind !== 'manual-question-open') ||
      operation.taskId !== input.prepared.taskId ||
      operation.gateKind !== input.prepared.gateKind ||
      operation.expectedTaskRevision !== input.taskRevision ||
      sha256Hex(operation.manifestJson) !== input.prepared.manifestDigest
    ) {
      stale(input.prepared.operationId)
    }
    const manifest = decodePreparedOpenManifest(operation.manifestJson)
    if (manifest.gateRef !== operation.gateRef) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        'prepared human-gate manifest gate identity changed',
      )
    }
    const artifacts = await artifactsFor(this.tx, operation.id)
    if (artifacts.some((artifact) => artifact.state !== 'staged')) {
      stale(operation.id)
    }
    let collaborationEventRef = null
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
      await projectReviewGateOpen(this.tx, this.nodeRunMint, this.nodeRunLifecycle, reviewManifest)
      collaborationEventRef = await appendPostgresqlHumanGateOpenedEventTx(this.tx, {
        family: 'review',
        gate: {
          taskId: operation.taskId,
          nodeRunId: reviewManifest.node.id,
          gateKind: 'review',
          gateId: operation.gateRef,
          roundId: reviewManifest.node.id,
        },
        occurredAt: input.now,
        identity: { operationRef: operation.id, eventGroupOrdinal: 1 },
      })
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
      await projectClarifyGateOpen(
        this.tx,
        this.nodeRunMint,
        this.nodeRunLifecycle,
        clarifyManifest,
      )
      collaborationEventRef = await appendPostgresqlHumanGateOpenedEventTx(this.tx, {
        family: 'clarify',
        gate: {
          taskId: operation.taskId,
          nodeRunId: clarifyManifest.node.id,
          gateKind: 'clarify',
          gateId: operation.gateRef,
          roundId: clarifyManifest.round.id,
        },
        occurredAt: input.now,
        identity: { operationRef: operation.id, eventGroupOrdinal: 1 },
      })
    }
    const receiptJson = JSON.stringify({
      v: 1,
      operationId: operation.id,
      gate: { kind: operation.gateKind, ref: operation.gateRef },
      nodeProjectionDigest: manifest.nodeProjectionDigest,
      committedEventRef: manifest.committedEventRef,
      acceptedAt: input.now,
    })
    const committed = await commitOperation(this.tx, {
      operation,
      receiptJson,
      now: input.now,
    })
    if (manifest.kind === 'clarify-open') {
      await completeOperation(this.tx, operation.id, operation.claimEpoch, input.now)
    }
    if (committed.resultGateRevision === null) {
      throw new Error('committed-human-gate-open-lacks-revision')
    }
    return {
      gate: { kind: operation.gateKind, ref: operation.gateRef },
      gateRevision: committed.resultGateRevision,
      nodeProjectionDigest: manifest.nodeProjectionDigest,
      committedEventRef: manifest.committedEventRef,
      eventRefs: collaborationEventRef === null ? [] : [collaborationEventRef],
    }
  }
}
