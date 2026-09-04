// RFC-333 / RFC-349 / RFC-359 — collaboration clarify decision transaction participant.
//
// RFC-359 W1-T2b：一份实现，两个引擎。此前只有 SQLite 的 dbTxSync 版本（journal 用
// `SqliteHumanGateOperationStore`、决定接受走 `bindTaskDecisionParticipantInTx`），PostgreSQL
// 上快速澄清命令根本没有实现。现在 replay / prepare 跑在 `ProviderNeutralDatabase` 上，
// 参与者在 seal 的 `DatabaseTransaction` 里复用已合一的原子：`DatabaseHumanGateOperationJournal`
// / `acceptHumanGateDecisionTx` / `appendHumanGateDecisionCommittedEvent`。
// 文件名沿用（多条源锁钉住路径），W4 pair-deletion 时统一改名。

import { and, desc, eq, isNotNull, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { collaborationGateOperations, nodeRuns } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type { CanonicalHumanGateRequest } from '@/modules/collaboration/public/types'
import { acceptHumanGateDecisionTx } from '@/modules/task-execution/infrastructure/taskDecisionParticipant'
import { humanGateNodeProjectionFence } from '@/modules/task-execution/public/participants'
import type { ClarifySealDecisionParticipantInTx } from './legacySqliteClarify/seal'
import { ConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type { ClarifyAnswer, ClarifyDirective, TaskActorRole } from '@agent-workflow/shared'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import { appendHumanGateDecisionCommittedEvent } from './collaborationCommittedEvents'
import {
  canonicalHumanGateRequestHash,
  canonicalHumanGateValueJson,
  deriveHumanGateCompatibilityKey,
} from '../domain/canonicalGateRequest'
import {
  decodeClarifyDecisionManifest,
  decodeClarifyDecisionReceipt,
  encodeClarifyDecisionManifest,
  encodeClarifyDecisionReceipt,
  type ClarifyDecisionManifest,
  type ClarifyDecisionReceiptEnvelope,
} from '../domain/clarifyDecision'
import { gateDecisionReceipt } from '../domain/gateReceipt'
import {
  DatabaseHumanGateOperationJournal,
  type HumanGateOperationJournal,
} from './humanGateOperationJournal'

export interface ClarifyDecisionArgs {
  readonly expectedTaskRevision?: number
  readonly expectedGateRevision?: number
  readonly idempotencyKey?: string
}

export interface PreparedClarifyDecision {
  readonly operationId: string
  readonly participant: ClarifySealDecisionParticipantInTx
  readonly capture: {
    envelope?: ClarifyDecisionReceiptEnvelope
    eventRefs?: readonly CommittedEventRef[]
  }
}

function clarifyDecisionPayload(input: {
  roundId: string
  answers: readonly ClarifyAnswer[]
  directive: ClarifyDirective
  actorRole: TaskActorRole
}) {
  return {
    kind: 'clarify-decision' as const,
    roundId: input.roundId,
    directive: input.directive,
    answersJson: canonicalHumanGateValueJson(input.answers),
    releaseGate: true,
    actorRole: input.actorRole,
  }
}

function projectionMember(row: typeof nodeRuns.$inferSelect) {
  return {
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    parentNodeRunId: row.parentNodeRunId,
    iteration: row.iteration,
    shardKey: row.shardKey,
    retryIndex: row.retryIndex,
    reviewIteration: row.reviewIteration,
    status: row.status,
    failureCode: row.failureCode,
    preSnapshot: row.preSnapshot,
    preSnapshotReposJson: row.preSnapshotReposJson,
    rerunCause: row.rerunCause,
    supersededByReview: row.supersededByReview,
    rolledBack: row.rolledBack,
    continuationSlotKey: row.continuationSlotKey,
    lineageSlotPathJson: row.lineageSlotPathJson,
    operationGeneration: row.operationGeneration,
  }
}

async function ensureLegacyClarifyGateRevisionTx(input: {
  tx: DatabaseTransaction
  operations: HumanGateOperationJournal
  taskId: string
  originNodeRunId: string
  expectedTaskRevision: number
  now: number
}): Promise<number> {
  const gateRef = `clarify:${input.originNodeRunId}`
  const current = await input.operations.latestGateRevisionTx({
    tx: input.tx,
    gateKind: 'clarify',
    gateRef,
  })
  if (current !== 0) return current
  const request: CanonicalHumanGateRequest = {
    schemaVersion: 1,
    taskId: input.taskId,
    gateKind: 'clarify',
    operationKind: 'legacy-seed',
    gateRef,
    actorUserId: null,
    expectedTaskRevision: input.expectedTaskRevision,
    expectedGateRevision: 0,
    payload: {
      kind: 'legacy-seed',
      factDigest: sha256Hex(
        canonicalHumanGateValueJson({
          taskId: input.taskId,
          originNodeRunId: input.originNodeRunId,
        }),
      ),
    },
  }
  const begun = await input.operations.beginTx({
    tx: input.tx,
    operationId: ulid(input.now),
    request,
    idempotencyKey: `legacy:clarify:${input.originNodeRunId}:1`,
    now: input.now,
  })
  await input.operations.commitTx({
    tx: input.tx,
    operationId: begun.operation.id,
    expectedClaimEpoch: begun.operation.claimEpoch,
    receiptJson: canonicalHumanGateValueJson({
      schemaVersion: 1,
      kind: 'legacy-seed',
      gateRef,
      gateRevision: 1,
    }),
    now: input.now,
  })
  await input.operations.completeTx({
    tx: input.tx,
    operationId: begun.operation.id,
    expectedClaimEpoch: begun.operation.claimEpoch,
    now: input.now,
  })
  return 1
}

export async function replayCommittedClarifyDecision(input: {
  db: ProviderNeutralDatabase
  taskId: string
  originNodeRunId: string
  roundId: string
  actorUserId: string
  actorRole: TaskActorRole
  answers: readonly ClarifyAnswer[]
  directive: ClarifyDirective
  decision: ClarifyDecisionArgs
}): Promise<ClarifyDecisionReceiptEnvelope | null> {
  const gateRef = `clarify:${input.originNodeRunId}`
  const payload = clarifyDecisionPayload(input)
  const rows = await input.db
    .select()
    .from(collaborationGateOperations)
    .where(
      and(
        eq(collaborationGateOperations.taskId, input.taskId),
        eq(collaborationGateOperations.gateKind, 'clarify'),
        eq(collaborationGateOperations.gateRef, gateRef),
        eq(collaborationGateOperations.operationKind, 'decide'),
      ),
    )
    .orderBy(desc(collaborationGateOperations.createdAt))
  const explicit = input.decision.idempotencyKey
  const candidate = rows.find((row) => {
    if (explicit !== undefined && row.idempotencyKey !== explicit) return false
    if (row.receiptJson === null || row.actorUserId !== input.actorUserId) return false
    let manifest: ClarifyDecisionManifest
    try {
      manifest = decodeClarifyDecisionManifest(row.manifestJson)
    } catch {
      return false
    }
    const request: CanonicalHumanGateRequest = {
      schemaVersion: 1,
      taskId: input.taskId,
      gateKind: 'clarify',
      operationKind: 'decide',
      gateRef,
      actorUserId: input.actorUserId,
      expectedTaskRevision: input.decision.expectedTaskRevision ?? row.expectedTaskRevision,
      expectedGateRevision: input.decision.expectedGateRevision ?? row.expectedGateRevision,
      payload,
    }
    const legacyRequest: CanonicalHumanGateRequest | null =
      manifest.request.payload.kind === 'clarify-decision' &&
      manifest.request.payload.actorRole === undefined
        ? {
            ...request,
            payload: {
              kind: 'clarify-decision',
              roundId: payload.roundId,
              directive: payload.directive,
              answersJson: payload.answersJson,
              releaseGate: payload.releaseGate,
            },
          }
        : null
    return (
      (canonicalHumanGateRequestHash(request) === row.requestHash ||
        (legacyRequest !== null &&
          canonicalHumanGateRequestHash(legacyRequest) === row.requestHash)) &&
      canonicalHumanGateRequestHash(manifest.request) === row.requestHash
    )
  })
  if (candidate === undefined) {
    if (explicit !== undefined && rows.some((row) => row.idempotencyKey === explicit)) {
      throw new ConflictError(
        'human-gate-idempotency-conflict',
        'clarify decision idempotency key is already bound to another request',
      )
    }
    return null
  }
  return decodeClarifyDecisionReceipt(candidate.receiptJson!)
}

export async function prepareClarifyDecision(input: {
  db: ProviderNeutralDatabase
  taskId: string
  originNodeRunId: string
  roundId: string
  actorUserId: string
  actorRole: TaskActorRole
  answers: readonly ClarifyAnswer[]
  directive: ClarifyDirective
  taskRevision: number
  decision: ClarifyDecisionArgs
}): Promise<PreparedClarifyDecision> {
  const gateRef = `clarify:${input.originNodeRunId}`
  const latestGateRevision =
    (
      await input.db
        .select({ revision: collaborationGateOperations.resultGateRevision })
        .from(collaborationGateOperations)
        .where(
          and(
            eq(collaborationGateOperations.gateKind, 'clarify'),
            eq(collaborationGateOperations.gateRef, gateRef),
            isNotNull(collaborationGateOperations.resultGateRevision),
          ),
        )
        .orderBy(desc(collaborationGateOperations.resultGateRevision))
        .limit(1)
    )[0]?.revision ?? 0
  const capturedGateRevision =
    input.decision.expectedGateRevision ?? (latestGateRevision === 0 ? 1 : latestGateRevision)
  const request: CanonicalHumanGateRequest = {
    schemaVersion: 1,
    taskId: input.taskId,
    gateKind: 'clarify',
    operationKind: 'decide',
    gateRef,
    actorUserId: input.actorUserId,
    expectedTaskRevision: input.decision.expectedTaskRevision ?? input.taskRevision,
    expectedGateRevision: capturedGateRevision,
    payload: clarifyDecisionPayload(input),
  }
  const manifest: ClarifyDecisionManifest = {
    schemaVersion: 1,
    kind: 'clarify-decision',
    request,
    sourceNodeRunIds: [input.originNodeRunId],
    workspaceRollbackPlan: null,
  }
  const manifestJson = encodeClarifyDecisionManifest(manifest)
  const operationId = ulid()
  const idempotencyKey = input.decision.idempotencyKey ?? deriveHumanGateCompatibilityKey(request)
  const capture: PreparedClarifyDecision['capture'] = {}
  const participant: ClarifySealDecisionParticipantInTx = {
    async acceptTx(sealed) {
      if (
        sealed.taskId !== input.taskId ||
        sealed.roundId !== input.roundId ||
        sealed.originNodeRunId !== input.originNodeRunId ||
        !sealed.roundFullySealed
      ) {
        throw new ConflictError(
          'clarify-decision-stale',
          `clarify round ${input.originNodeRunId} changed before decision commit`,
        )
      }
      const operations = new DatabaseHumanGateOperationJournal()
      const currentGateRevision = await ensureLegacyClarifyGateRevisionTx({
        tx: sealed.tx,
        operations,
        taskId: input.taskId,
        originNodeRunId: input.originNodeRunId,
        expectedTaskRevision: request.expectedTaskRevision,
        now: sealed.now,
      })
      if (currentGateRevision !== capturedGateRevision) {
        throw new ConflictError(
          'human-gate-operation-stale',
          `clarify gate revision changed (expected ${capturedGateRevision}, current ${currentGateRevision})`,
        )
      }
      const begun = await operations.beginTx({
        tx: sealed.tx,
        operationId,
        request,
        idempotencyKey,
        now: sealed.now,
      })
      if (begun.replayed) {
        if (begun.operation.receiptJson === null) {
          throw new ConflictError(
            'human-gate-operation-conflict',
            `clarify decision operation '${begun.operation.id}' has not committed`,
          )
        }
        capture.envelope = decodeClarifyDecisionReceipt(begun.operation.receiptJson)
        return
      }
      await operations.markPreparedTx({
        tx: sealed.tx,
        operationId: begun.operation.id,
        expectedClaimEpoch: begun.operation.claimEpoch,
        manifestJson,
        now: sealed.now,
      })
      const sourceRows = await sealed.tx
        .select()
        .from(nodeRuns)
        .where(inArray(nodeRuns.id, [input.originNodeRunId]))
        .limit(1)
      const accepted = await acceptHumanGateDecisionTx(sealed.tx, {
        taskId: input.taskId,
        gate: { kind: 'clarify', ref: gateRef },
        expectedTaskRevision: request.expectedTaskRevision,
        expectedNodeProjection: humanGateNodeProjectionFence(sourceRows.map(projectionMember)),
        continuationLineage: {
          sourceNodeRunIds: [input.originNodeRunId],
          rerunNodeRunIds: [],
        },
        operationId: begun.operation.id,
        now: sealed.now,
        nodeChanges: sourceRows.map((row) => ({
          nodeRunId: row.id,
          nodeId: row.nodeId,
          status: 'done' as const,
          cause: 'clarify-answered',
        })),
      })
      const envelope: ClarifyDecisionReceiptEnvelope = {
        schemaVersion: 1,
        kind: 'clarify-decision',
        decision: gateDecisionReceipt({
          operationId: begun.operation.id,
          gate: { kind: 'clarify', ref: gateRef },
          gateRevision: capturedGateRevision + 1,
          taskRevision: accepted.taskRevision,
          acceptedAt: sealed.now,
          replayed: false,
        }),
        result: {
          taskId: input.taskId,
          roundId: input.roundId,
          continuationRef: accepted.continuationRef,
          sealedQuestionIds: sealed.sealedQuestionIds,
          roundFullySealed: sealed.roundFullySealed,
        },
      }
      await operations.commitTx({
        tx: sealed.tx,
        operationId: begun.operation.id,
        expectedClaimEpoch: begun.operation.claimEpoch,
        receiptJson: encodeClarifyDecisionReceipt(envelope),
        now: sealed.now,
      })
      await operations.completeTx({
        tx: sealed.tx,
        operationId: begun.operation.id,
        expectedClaimEpoch: begun.operation.claimEpoch,
        now: sealed.now,
      })
      const collaborationEventRef = await appendHumanGateDecisionCommittedEvent(sealed.tx, {
        family: 'clarify',
        gate: {
          taskId: input.taskId,
          nodeRunId: input.originNodeRunId,
          gateKind: 'clarify',
          gateId: gateRef,
          roundId: input.roundId,
        },
        decision: { gateKind: 'clarify', kind: input.directive },
        gateStatus: 'committed',
        continuationRef: accepted.continuationRef,
        occurredAt: sealed.now,
        identity: {
          operationRef: begun.operation.id,
          eventGroupOrdinal: 1,
          correlationRef: `human-gate-node-run:${input.originNodeRunId}`,
        },
      })
      capture.envelope = envelope
      capture.eventRefs =
        collaborationEventRef === null
          ? accepted.eventRefs
          : [...accepted.eventRefs, collaborationEventRef]
    },
  }
  return { operationId, participant, capture }
}
