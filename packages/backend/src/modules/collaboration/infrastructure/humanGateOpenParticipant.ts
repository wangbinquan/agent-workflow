// RFC-359 W4-D25 —— human-gate 开启参与者：一份实现，两个引擎共用。
//
// 合一前这里是两份：`sqliteHumanGateOpenParticipant.ts`（RFC-333，`DbTxSync` 同步、经
// `SqliteHumanGateOperationStore` 记账）与 `postgresqlHumanGateOpenParticipant.ts`（RFC-349，
// 自己内联了一套更弱的 commit / complete）。正典取 SQLite 那份的**语义**：逐点的陈旧原因文案、
// 提交与完成的幂等重放、以及「提交要求工件全 staged / 完成要求工件全 finalized」两条判据——它们
// 在中立记账 `DatabaseHumanGateOperationJournal` 里已经逐行照搬，这里直接用，不再另写一套。
//
// 事务是中立的 `DatabaseTransaction`：调用方（task-execution 的 park 原子）在
// `withTaskExecutionSerializable` 体内把它交进来，本文件只做 collaboration 自己的投影与记账。

import { SYSTEM_DECIDER } from '@agent-workflow/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'

import {
  clarifyRounds,
  collaborationGateOperations,
  docVersions,
  nodeRunEvents,
  nodeRuns,
  reviewComments,
  taskQuestions,
} from '@/db/schema'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import { insertInBatches } from '@/platform/persistence/batchInsert'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import type {
  HumanGateNodeRunLifecycleParticipantInTx,
  HumanGateNodeRunMintParticipantInTx,
  HumanGateOpenParticipantInTx,
  HumanGateOpenParticipantResult,
} from '../application/ports/humanGateOpenParticipant'
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
import { appendHumanGateOpenedCommittedEvent } from './collaborationCommittedEvents'
import type { HumanGateOperationJournal } from './humanGateOperationJournal'

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

/**
 * 停靠一条既有 node run。正典是合一前 SQLite 的那条（走共享转移表的事务内 CAS）；这里改用
 * task-execution 提供的生命周期参与者，是为了不让 collaboration 直接 import 对方的 infrastructure。
 * 两者判据一致：调用点在这之前已经逐字校过该行的 status，所以 `allowedFrom` 只有一个合法源。
 */
async function parkGateNodeRun(
  nodeRunLifecycle: HumanGateNodeRunLifecycleParticipantInTx,
  input: {
    readonly nodeRunId: string
    readonly allowedFrom: 'pending' | 'running'
    readonly event: 'park-review' | 'park-human'
    readonly extra: Readonly<{ startedAt: number | null; consumedUpstreamRunsJson?: string | null }>
  },
): Promise<void> {
  await nodeRunLifecycle.set({
    nodeRunId: input.nodeRunId,
    to: input.event === 'park-review' ? 'awaiting_review' : 'awaiting_human',
    allowedFrom: [input.allowedFrom],
    extra: input.extra,
    reason: input.event,
  })
}

/** The collaboration-owned review projection applied inside the park transaction. */
async function projectReviewGateOpen(
  tx: DatabaseTransaction,
  nodeRunMint: HumanGateNodeRunMintParticipantInTx<Promise<string>>,
  nodeRunLifecycle: HumanGateNodeRunLifecycleParticipantInTx,
  manifest: ReviewGateOpenManifest,
): Promise<void> {
  const node = manifest.node
  if (node.mode === 'mint') {
    const existing = await tx
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, node.id))
      .limit(1)
    if (existing[0] !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `review-open node projection '${node.id}' already exists`,
      )
    }
    await nodeRunMint.mint({
      id: node.id,
      taskId: node.taskId,
      nodeId: node.nodeId,
      status: 'awaiting_review',
      cause: 'review-park',
      containerRunId: node.containerRunId,
      iteration: node.iteration,
      overrides: {
        reviewIteration: node.reviewIteration,
        consumedUpstreamRunsJson: node.consumedUpstreamRunsJson,
        startedAt: node.startedAt,
      },
    })
  } else {
    const existing = (
      await tx
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
        .limit(1)
    )[0]
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
      await parkGateNodeRun(nodeRunLifecycle, {
        nodeRunId: node.id,
        allowedFrom: 'pending',
        event: 'park-review',
        extra: {
          startedAt: node.startedAt,
          consumedUpstreamRunsJson: node.consumedUpstreamRunsJson,
        },
      })
    } else {
      const sourcePortName = manifest.documents[0]!.sourcePortName
      const currentPendingIds = (
        await tx
          .select({ id: docVersions.id })
          .from(docVersions)
          .where(
            and(
              eq(docVersions.reviewNodeRunId, node.id),
              eq(docVersions.sourcePortName, sourcePortName),
              eq(docVersions.decision, 'pending'),
            ),
          )
      )
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

  // RFC-359 W6-T25 —— 文档投影按批落库。`manifest.documents` 的条数**无界**（它来自 agent 输出端口
  // 的 splitListItems，review 路径没有 wrapper-fanout 那道 256 闸），而这段跑在
  // `withTaskExecutionSerializable` 体内——SQLite 上那是全库独占，逐行写的 N 次往返阻塞的是所有任务。
  // 陈旧探测在**循环之外**（上面按 node 各做一次），所以这里是真正的 N→1。
  await insertInBatches(
    tx,
    docVersions,
    manifest.documents.map((document) => ({
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
    })),
    (batch) =>
      tx
        .insert(docVersions)
        .values([...batch])
        .run(),
  )
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

/** The collaboration-owned clarify node + round + eager question projection. */
export async function projectClarifyGateOpen(
  tx: DatabaseTransaction,
  nodeRunMint: HumanGateNodeRunMintParticipantInTx<Promise<string>>,
  nodeRunLifecycle: HumanGateNodeRunLifecycleParticipantInTx,
  manifest: ClarifyGateOpenManifest,
): Promise<void> {
  const node = manifest.node
  if (node.mode === 'mint') {
    const existing = await tx
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, node.id))
      .limit(1)
    if (existing[0] !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `clarify-open node projection '${node.id}' already exists`,
      )
    }
    await nodeRunMint.mint({
      id: node.id,
      taskId: node.taskId,
      nodeId: node.nodeId,
      status: 'awaiting_human',
      cause: node.cause,
      containerRunId: node.containerRunId,
      iteration: node.runIteration,
      overrides: {
        parentNodeRunId: node.parentNodeRunId,
        shardKey: node.shardKey,
        startedAt: node.startedAt,
      },
    })
  } else {
    const existing = (
      await tx
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
    )[0]
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
      await parkGateNodeRun(nodeRunLifecycle, {
        nodeRunId: node.id,
        allowedFrom: node.mode === 'reuse-pending' ? 'pending' : 'running',
        event: 'park-human',
        extra: { startedAt: node.startedAt },
      })
    }
  }

  const round = await tx
    .select({ id: clarifyRounds.id })
    .from(clarifyRounds)
    .where(eq(clarifyRounds.id, manifest.round.id))
    .limit(1)
  if (round[0] !== undefined) {
    throw new HumanGateOperationError(
      'human-gate-operation-stale',
      `clarify-open round projection '${manifest.round.id}' already exists`,
    )
  }
  await tx.insert(clarifyRounds).values(manifest.round).run()

  for (const question of manifest.questions) {
    if (question.mode === 'insert') {
      const conflict = (
        await tx
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
      )[0]
      if (conflict !== undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-stale',
          `clarify-open question projection '${question.questionId}' appeared before park`,
        )
      }
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
    const existing = (
      await tx.select().from(taskQuestions).where(eq(taskQuestions.id, question.id)).limit(1)
    )[0]
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
    await tx
      .update(taskQuestions)
      .set({
        questionTitle: question.questionTitle,
        defaultTargetNodeId: question.defaultTargetNodeId,
        updatedAt: question.updatedAt,
      })
      .where(eq(taskQuestions.id, question.id))
      .run()
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
  tx: DatabaseTransaction,
  manifest: ManualQuestionOpenManifest,
): Promise<boolean> {
  const expected = manifest.question
  const row = (
    await tx.select().from(taskQuestions).where(eq(taskQuestions.id, expected.id)).limit(1)
  )[0]
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

export class DatabaseHumanGateOpenParticipantInTx implements HumanGateOpenParticipantInTx {
  constructor(
    private readonly tx: DatabaseTransaction,
    private readonly journal: HumanGateOperationJournal,
    private readonly nodeRunMint: HumanGateNodeRunMintParticipantInTx<Promise<string>>,
    private readonly nodeRunLifecycle: HumanGateNodeRunLifecycleParticipantInTx,
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
    const operation = await this.journal.getTx(this.tx, input.operationId)
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
      (await this.journal.listArtifactsTx(this.tx, operation.id)).length !== 0
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
    const committed = await this.journal.commitTx({
      tx: this.tx,
      operationId: operation.id,
      expectedClaimEpoch: operation.claimEpoch,
      receiptJson,
      now: input.now,
    })
    await this.journal.completeTx({
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

  async consumePreparedGateTx(
    input: Parameters<HumanGateOpenParticipantInTx['consumePreparedGateTx']>[0],
  ): Promise<HumanGateOpenParticipantResult> {
    const operation = await this.journal.getTx(this.tx, input.prepared.operationId)
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
    const artifacts = await this.journal.listArtifactsTx(this.tx, operation.id)
    if (artifacts.some((artifact) => artifact.state !== 'staged')) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `prepared human-gate operation '${operation.id}' has un-staged artifacts`,
        { operationId: operation.id },
      )
    }
    let collaborationEventRef: CommittedEventRef | null = null
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
      collaborationEventRef = await appendHumanGateOpenedCommittedEvent(this.tx, {
        family: 'review',
        gate: {
          taskId: operation.taskId,
          nodeRunId: reviewManifest.node.id,
          gateKind: 'review',
          gateId: operation.gateRef,
          roundId: reviewManifest.node.id,
        },
        occurredAt: input.now,
        identity: {
          operationRef: operation.id,
          eventGroupOrdinal: 1,
        },
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
      collaborationEventRef = await appendHumanGateOpenedCommittedEvent(this.tx, {
        family: 'clarify',
        gate: {
          taskId: operation.taskId,
          nodeRunId: clarifyManifest.node.id,
          gateKind: 'clarify',
          gateId: operation.gateRef,
          roundId: clarifyManifest.round.id,
        },
        occurredAt: input.now,
        identity: {
          operationRef: operation.id,
          eventGroupOrdinal: 1,
        },
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
    const committed = await this.journal.commitTx({
      tx: this.tx,
      operationId: operation.id,
      expectedClaimEpoch: operation.claimEpoch,
      receiptJson,
      now: input.now,
    })
    if (manifest.kind === 'clarify-open') {
      await this.journal.completeTx({
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
      eventRefs: collaborationEventRef === null ? [] : [collaborationEventRef],
    }
  }
}
