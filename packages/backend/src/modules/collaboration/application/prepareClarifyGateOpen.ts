// RFC-333 T7 — prepare one complete clarify round before TaskParkTx.

import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { sha256Hex } from '@/util/hash'
import type { ClarifyQuestionSnapshotReader } from './ports/clarifyQuestionSnapshotReader'
import type { HumanGateOperationStore } from './ports/humanGateOperationStore'
import type { CanonicalHumanGateRequest } from '../domain/canonicalGateRequest'
import {
  clarifyGateProjectionDigest,
  decodeClarifyGateOpenManifest,
  encodeClarifyGateOpenManifest,
  type ClarifyGateNodeProjection,
  type ClarifyGateOpenManifest,
  type ClarifyGateQuestionProjection,
  type ClarifyGateRoundProjection,
} from '../domain/clarifyGateOpen'
import {
  HumanGateOperationError,
  preparedHumanGateRef,
  type HumanGateOperationSnapshot,
  type PreparedHumanGateRef,
} from '../domain/humanGateOperation'

export interface ClarifyGateOpenQuestionDraft {
  readonly id: string
  readonly title: string
}

export interface ClarifyGateOpenReuseNodeRun {
  readonly id: string
  readonly status: 'pending' | 'running' | 'awaiting_human'
  readonly iteration: number
  readonly parentNodeRunId: string | null
  readonly shardKey: string | null
  readonly startedAt: number | null
}

export interface PrepareClarifyGateOpenInput {
  readonly taskId: string
  readonly kind: 'self' | 'cross'
  readonly askingNodeId: string
  readonly askingNodeRunId: string
  readonly askingShardKey: string | null
  readonly intermediaryNodeId: string
  readonly targetConsumerNodeId: string | null
  readonly parentNodeRunId: string | null
  readonly loopIter: number
  readonly iteration: number
  readonly questionsJson: string
  readonly questions: readonly ClarifyGateOpenQuestionDraft[]
  readonly truncationWarningsJson: string | null
  readonly sourceSnapshotDigest: string
  readonly idempotencyKey: string
  readonly expectedTaskRevision: number
  readonly expectedGateRevision?: number
  readonly actorUserId?: string | null
  readonly reuseNodeRun?: ClarifyGateOpenReuseNodeRun
  readonly now?: number
}

export type PreparedClarifyGateOpen = Readonly<{
  kind: 'prepared'
  operation: HumanGateOperationSnapshot
  prepared: PreparedHumanGateRef
  manifest: ClarifyGateOpenManifest
}>

export type CommittedClarifyGateOpen = Readonly<{
  kind: 'already-committed'
  operation: HumanGateOperationSnapshot
  manifest: ClarifyGateOpenManifest
}>

export type PrepareClarifyGateOpenResult = PreparedClarifyGateOpen | CommittedClarifyGateOpen

function assertInput(input: PrepareClarifyGateOpenInput): void {
  if (
    input.taskId.length === 0 ||
    input.askingNodeId.length === 0 ||
    input.askingNodeRunId.length === 0 ||
    input.intermediaryNodeId.length === 0 ||
    input.sourceSnapshotDigest.length === 0 ||
    input.idempotencyKey.length === 0 ||
    input.questions.length === 0 ||
    !Number.isSafeInteger(input.expectedTaskRevision) ||
    input.expectedTaskRevision < 0 ||
    !Number.isSafeInteger(input.iteration) ||
    input.iteration < 0 ||
    !Number.isSafeInteger(input.loopIter) ||
    input.loopIter < 0 ||
    (input.expectedGateRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedGateRevision) || input.expectedGateRevision < 0)) ||
    (input.kind === 'self' && (input.targetConsumerNodeId !== null || input.loopIter !== 0)) ||
    (input.kind === 'cross' && input.askingShardKey !== null) ||
    new Set(input.questions.map((question) => question.id)).size !== input.questions.length ||
    input.questions.some((question) => question.id.length === 0 || question.title.length === 0)
  ) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'clarify-open preparation identity or projection is invalid',
    )
  }
  try {
    const questions: unknown = JSON.parse(input.questionsJson)
    const warnings: unknown =
      input.truncationWarningsJson === null ? [] : JSON.parse(input.truncationWarningsJson)
    if (!Array.isArray(questions) || !Array.isArray(warnings)) throw new Error('not-array')
  } catch {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'clarify-open questions or warnings are invalid JSON',
    )
  }
  if (
    input.reuseNodeRun !== undefined &&
    (input.reuseNodeRun.id.length === 0 ||
      !Number.isSafeInteger(input.reuseNodeRun.iteration) ||
      input.reuseNodeRun.iteration < 0 ||
      (input.reuseNodeRun.startedAt !== null &&
        (!Number.isSafeInteger(input.reuseNodeRun.startedAt) || input.reuseNodeRun.startedAt < 0)))
  ) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'clarify-open reused node projection is invalid',
    )
  }
}

function assertReplayMatches(
  manifest: ClarifyGateOpenManifest,
  input: PrepareClarifyGateOpenInput,
): void {
  if (
    manifest.sourceSnapshotDigest !== input.sourceSnapshotDigest ||
    manifest.round.taskId !== input.taskId ||
    manifest.round.kind !== input.kind ||
    manifest.round.askingNodeId !== input.askingNodeId ||
    manifest.round.askingNodeRunId !== input.askingNodeRunId ||
    manifest.round.intermediaryNodeId !== input.intermediaryNodeId ||
    manifest.round.questionsJson !== input.questionsJson ||
    manifest.round.truncationWarningsJson !== input.truncationWarningsJson
  ) {
    throw new HumanGateOperationError(
      'human-gate-idempotency-conflict',
      `clarify-open idempotency key is already bound to operation '${manifest.committedEventRef}'`,
    )
  }
}

export class ClarifyGateOpenPreparation {
  constructor(
    private readonly db: DbClient,
    private readonly operations: HumanGateOperationStore,
    private readonly questions: ClarifyQuestionSnapshotReader,
  ) {}

  prepare(input: PrepareClarifyGateOpenInput): PrepareClarifyGateOpenResult {
    assertInput(input)
    const requestedAt = input.now ?? Date.now()
    return dbTxSync(this.db, (tx) => {
      const existing = this.operations.findByIdempotencyTx({
        tx,
        taskId: input.taskId,
        gateKind: 'clarify',
        operationKind: 'open',
        idempotencyKey: input.idempotencyKey,
      })
      if (existing !== null) {
        if (
          existing.state !== 'prepared' &&
          existing.state !== 'committed' &&
          existing.state !== 'completed'
        ) {
          throw new HumanGateOperationError(
            'human-gate-operation-stale',
            `clarify-open operation '${existing.id}' cannot resume from '${existing.state}'`,
            { operationId: existing.id, currentState: existing.state },
          )
        }
        const manifest = decodeClarifyGateOpenManifest(existing.manifestJson)
        assertReplayMatches(manifest, input)
        if (existing.state === 'prepared') {
          return {
            kind: 'prepared',
            operation: existing,
            prepared: preparedHumanGateRef(existing),
            manifest,
          }
        }
        return { kind: 'already-committed', operation: existing, manifest }
      }

      const operationId = ulid(requestedAt)
      const nodeRunId = input.reuseNodeRun?.id ?? operationId
      const gateRef = `clarify:${nodeRunId}`
      const latestGateRevision = this.operations.latestGateRevisionTx({
        tx,
        gateKind: 'clarify',
        gateRef,
      })
      const expectedGateRevision = input.expectedGateRevision ?? latestGateRevision
      if (expectedGateRevision !== latestGateRevision) {
        throw new HumanGateOperationError(
          'human-gate-operation-stale',
          `clarify-open gate '${gateRef}' revision changed before preparation`,
          { expectedGateRevision, currentGateRevision: latestGateRevision },
        )
      }
      const reused = input.reuseNodeRun
      const node: ClarifyGateNodeProjection = {
        mode:
          reused === undefined
            ? 'mint'
            : reused.status === 'pending'
              ? 'reuse-pending'
              : reused.status === 'running'
                ? 'reuse-running'
                : 'reuse-awaiting',
        id: nodeRunId,
        taskId: input.taskId,
        nodeId: input.intermediaryNodeId,
        runIteration: reused?.iteration ?? (input.kind === 'self' ? 0 : input.loopIter),
        parentNodeRunId: reused === undefined ? input.parentNodeRunId : reused.parentNodeRunId,
        shardKey: reused === undefined ? input.askingShardKey : reused.shardKey,
        previousStartedAt: reused?.startedAt ?? null,
        startedAt:
          reused === undefined
            ? requestedAt
            : reused.status === 'awaiting_human'
              ? reused.startedAt
              : (reused.startedAt ?? requestedAt),
        cause: input.kind === 'self' ? 'clarify-park' : 'cross-clarify-park',
      }
      const round: ClarifyGateRoundProjection = {
        id: `${operationId}:round`,
        taskId: input.taskId,
        kind: input.kind,
        askingNodeId: input.askingNodeId,
        askingNodeRunId: input.askingNodeRunId,
        askingShardKey: input.kind === 'self' ? input.askingShardKey : null,
        intermediaryNodeId: input.intermediaryNodeId,
        intermediaryNodeRunId: nodeRunId,
        targetConsumerNodeId: input.kind === 'cross' ? input.targetConsumerNodeId : null,
        loopIter: input.kind === 'cross' ? input.loopIter : 0,
        iteration: input.iteration,
        questionsJson: input.questionsJson,
        answersJson: null,
        directive: null,
        status: 'awaiting_human',
        truncationWarningsJson: input.kind === 'self' ? input.truncationWarningsJson : null,
        designerRunTriggeredAt: null,
        abandonedAt: null,
        createdAt: requestedAt,
        answeredAt: null,
        answeredBy: null,
        submittedByRole: null,
        answerAttributionsJson: null,
        draftAnswersJson: null,
      }
      const sourceKind = input.kind
      const roleKind = input.kind === 'self' ? 'self' : 'questioner'
      const questions: ClarifyGateQuestionProjection[] = input.questions.map((question, index) => {
        const previous = this.questions.findTx({
          tx,
          originNodeRunId: nodeRunId,
          questionId: question.id,
          roleKind,
        })
        if (
          previous !== null &&
          (previous.taskId !== input.taskId ||
            previous.sourceKind !== sourceKind ||
            previous.iteration !== input.iteration ||
            previous.loopIter !== round.loopIter)
        ) {
          throw new HumanGateOperationError(
            'human-gate-operation-stale',
            `clarify-open question '${question.id}' conflicts with its existing snapshot`,
          )
        }
        return {
          mode: previous === null ? 'insert' : 'refresh-existing',
          id: previous?.id ?? `${operationId}:question:${String(index).padStart(6, '0')}`,
          taskId: input.taskId,
          originNodeRunId: nodeRunId,
          questionId: question.id,
          questionTitle: question.title,
          sourceKind,
          roleKind,
          iteration: input.iteration,
          loopIter: round.loopIter,
          defaultTargetNodeId: input.askingNodeId,
          createdAt: previous?.createdAt ?? requestedAt,
          updatedAt: requestedAt,
          previousQuestionTitle: previous?.questionTitle ?? null,
          previousDefaultTargetNodeId: previous?.defaultTargetNodeId ?? null,
          previousUpdatedAt: previous?.updatedAt ?? null,
        }
      })
      const nodeProjectionDigest = clarifyGateProjectionDigest({
        sourceSnapshotDigest: input.sourceSnapshotDigest,
        node,
        round,
        questions,
      })
      const manifest: ClarifyGateOpenManifest = {
        schemaVersion: 1,
        kind: 'clarify-open',
        gateRef,
        sourceSnapshotDigest: input.sourceSnapshotDigest,
        nodeProjectionDigest,
        committedEventRef: `clarify-open:${operationId}`,
        node,
        round,
        questions,
      }
      const manifestJson = encodeClarifyGateOpenManifest(manifest)
      const request: CanonicalHumanGateRequest = {
        schemaVersion: 1,
        taskId: input.taskId,
        gateKind: 'clarify',
        operationKind: 'open',
        gateRef,
        actorUserId: input.actorUserId ?? null,
        expectedTaskRevision: input.expectedTaskRevision,
        expectedGateRevision,
        payload: { kind: 'open', manifestDigest: sha256Hex(manifestJson) },
      }
      const begun = this.operations.beginTx({
        tx,
        operationId,
        request,
        idempotencyKey: input.idempotencyKey,
        now: requestedAt,
      })
      if (begun.replayed) {
        throw new HumanGateOperationError(
          'human-gate-operation-conflict',
          `clarify-open operation '${begun.operation.id}' raced its preparation`,
          { winnerOperationId: begun.operation.id },
        )
      }
      const operation = this.operations.markPreparedTx({
        tx,
        operationId,
        expectedClaimEpoch: begun.operation.claimEpoch,
        manifestJson,
        now: requestedAt,
      })
      return {
        kind: 'prepared',
        operation,
        prepared: preparedHumanGateRef(operation),
        manifest,
      }
    })
  }
}
