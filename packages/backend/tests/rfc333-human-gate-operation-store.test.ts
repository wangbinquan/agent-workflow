import { describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { collaborationGateArtifacts, collaborationGateOperations } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { createCollaborationCommandContext } from '@/modules/collaboration/composition/commandContext'
import type { CanonicalHumanGateRequest } from '@/modules/collaboration/domain/canonicalGateRequest'
import {
  canonicalHumanGateJson,
  canonicalHumanGateRequestHash,
  deriveHumanGateCompatibilityKey,
} from '@/modules/collaboration/domain/canonicalGateRequest'
import { HumanGateOperationError } from '@/modules/collaboration/domain/humanGateOperation'
import { SqliteHumanGateOperationStore } from '@/modules/collaboration/infrastructure/sqliteHumanGateOperationStore'
import { createManualQuestionOpen } from '@/modules/collaboration/public/commands'
import { MIGRATIONS } from './migration-freeze'

const NOW = 1_788_969_612_066

function seedTask(db: ReturnType<typeof createInMemoryDb>, taskId = 'task-333'): void {
  db.run(sql`
    INSERT INTO tasks (
      id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
      base_branch, branch, status, inputs, started_at
    ) VALUES (
      ${taskId}, ${taskId}, 'workflow-333', '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      '/tmp/rfc333', '/tmp/rfc333', 'main', ${`agent-workflow/${taskId}`},
      'running', '{}', ${NOW}
    )
  `)
}

function request(overrides: Partial<CanonicalHumanGateRequest> = {}): CanonicalHumanGateRequest {
  return {
    schemaVersion: 1,
    taskId: 'task-333',
    gateKind: 'review',
    operationKind: 'decide',
    gateRef: 'review:node-a:iteration-1',
    actorUserId: 'user-a',
    expectedTaskRevision: 7,
    expectedGateRevision: 1,
    payload: {
      kind: 'review-decision',
      decision: 'approved',
      reviewIteration: 1,
      rejectReason: null,
      commentsJson: '[]',
      selectionsJson: '{}',
    },
    ...overrides,
  }
}

function expectOperationError(run: () => unknown, code: HumanGateOperationError['code']): void {
  try {
    run()
    throw new Error(`expected HumanGateOperationError '${code}'`)
  } catch (error) {
    expect(error).toBeInstanceOf(HumanGateOperationError)
    expect((error as HumanGateOperationError).code).toBe(code)
  }
}

function thrownCauseMessage(run: () => unknown): string {
  try {
    run()
    throw new Error('expected operation to throw')
  } catch (error) {
    return String((error as { cause?: { message?: string } }).cause?.message ?? error)
  }
}

function begin(
  tx: DbTxSync,
  store: SqliteHumanGateOperationStore,
  operationId: string,
  value: CanonicalHumanGateRequest,
  idempotencyKey: string,
) {
  return store.beginTx({
    tx,
    operationId,
    request: value,
    idempotencyKey,
    now: NOW,
  })
}

describe('RFC-333 canonical human-gate request', () => {
  test('sorts object keys, preserves array order, and binds actor plus revisions', () => {
    const first = request()
    const reordered = {
      payload: {
        selectionsJson: '{}',
        commentsJson: '[]',
        rejectReason: null,
        reviewIteration: 1,
        decision: 'approved',
        kind: 'review-decision',
      },
      expectedGateRevision: 1,
      expectedTaskRevision: 7,
      actorUserId: 'user-a',
      gateRef: 'review:node-a:iteration-1',
      operationKind: 'decide',
      gateKind: 'review',
      taskId: 'task-333',
      schemaVersion: 1,
    } as const satisfies CanonicalHumanGateRequest

    expect(canonicalHumanGateJson(reordered)).toBe(canonicalHumanGateJson(first))
    expect(canonicalHumanGateRequestHash(reordered)).toBe(canonicalHumanGateRequestHash(first))
    expect(
      canonicalHumanGateRequestHash(
        request({
          gateKind: 'questions',
          gateRef: 'questions:round-1',
          payload: { kind: 'question-dispatch', entryIds: ['a', 'b'] },
        }),
      ),
    ).not.toBe(
      canonicalHumanGateRequestHash(
        request({
          gateKind: 'questions',
          gateRef: 'questions:round-1',
          payload: { kind: 'question-dispatch', entryIds: ['b', 'a'] },
        }),
      ),
    )
    expect(canonicalHumanGateRequestHash(request({ actorUserId: 'user-b' }))).not.toBe(
      canonicalHumanGateRequestHash(first),
    )
    expect(canonicalHumanGateRequestHash(request({ expectedGateRevision: 2 }))).not.toBe(
      canonicalHumanGateRequestHash(first),
    )
    expect(deriveHumanGateCompatibilityKey(request({ actorUserId: null }))).not.toBe(
      deriveHumanGateCompatibilityKey(first),
    )
  })
})

describe('RFC-333 SQLite human-gate operation store', () => {
  test('does not recovery-claim an intentional manual-question owner wait', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db, 'task-333-manual-wait')
    const created = createManualQuestionOpen(createCollaborationCommandContext({ db }), {
      taskId: 'task-333-manual-wait',
      title: 'Question',
      body: 'Please revisit this.',
      targetNodeId: 'writer',
      actorUserId: 'user-a',
      now: NOW,
    })
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, created.operationId))
        .get()?.state,
    ).toBe('prepared')
    const claimed = dbTxSync(db, (tx) =>
      new SqliteHumanGateOperationStore().claimRecoveryBatchTx({
        tx,
        now: NOW + 60_000,
        leaseMs: 30_000,
        limit: 10,
      }),
    )
    expect(claimed).toEqual([])
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, created.operationId))
        .get(),
    ).toMatchObject({ state: 'prepared', claimEpoch: 1 })
  })

  test('replays an exact key and rejects changed payload, actor, or active exact-gate work', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db)
    const store = new SqliteHumanGateOperationStore()

    dbTxSync(db, (tx) => {
      const created = begin(tx, store, 'operation-a', request(), 'decision-key')
      expect(created.replayed).toBe(false)
      expect(created.operation).toMatchObject({
        id: 'operation-a',
        state: 'preparing',
        claimEpoch: 1,
        resultGateRevision: null,
      })

      const replay = begin(tx, store, 'operation-ignored', request(), 'decision-key')
      expect(replay.replayed).toBe(true)
      expect(replay.operation.id).toBe('operation-a')

      expectOperationError(
        () =>
          begin(
            tx,
            store,
            'operation-b',
            request({
              payload: {
                kind: 'review-decision',
                decision: 'rejected',
                reviewIteration: 1,
                rejectReason: 'revise',
                commentsJson: '[]',
                selectionsJson: '{}',
              },
            }),
            'decision-key',
          ),
        'human-gate-idempotency-conflict',
      )
      expectOperationError(
        () => begin(tx, store, 'operation-c', request({ actorUserId: 'user-b' }), 'decision-key'),
        'human-gate-idempotency-conflict',
      )
      expectOperationError(
        () => begin(tx, store, 'operation-d', request(), 'another-key'),
        'human-gate-operation-conflict',
      )
    })
  })

  test('uses claim/state CAS, commits one next revision, and preserves the receipt on replay', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db)
    const store = new SqliteHumanGateOperationStore()
    const manifestJson = JSON.stringify({ schemaVersion: 1, kind: 'review-decision' })
    const receiptJson = JSON.stringify({ operationId: 'operation-a', accepted: true })

    dbTxSync(db, (tx) => {
      begin(tx, store, 'operation-a', request(), 'decision-key')
      expectOperationError(
        () =>
          store.markPreparedTx({
            tx,
            operationId: 'operation-a',
            expectedClaimEpoch: 2,
            manifestJson,
            now: NOW + 1,
          }),
        'human-gate-operation-stale',
      )
      const prepared = store.markPreparedTx({
        tx,
        operationId: 'operation-a',
        expectedClaimEpoch: 1,
        manifestJson,
        now: NOW + 2,
      })
      expect(prepared.state).toBe('prepared')

      const committed = store.commitTx({
        tx,
        operationId: 'operation-a',
        expectedClaimEpoch: 1,
        receiptJson,
        now: NOW + 3,
      })
      expect(committed).toMatchObject({
        state: 'committed',
        resultGateRevision: 2,
        receiptJson,
        committedAt: NOW + 3,
      })
      expect(
        store.commitTx({
          tx,
          operationId: 'operation-a',
          expectedClaimEpoch: 1,
          receiptJson,
          now: NOW + 4,
        }).receiptJson,
      ).toBe(receiptJson)
      expectOperationError(
        () =>
          store.commitTx({
            tx,
            operationId: 'operation-a',
            expectedClaimEpoch: 1,
            receiptJson: '{"changed":true}',
            now: NOW + 4,
          }),
        'human-gate-operation-stale',
      )
      expect(
        store.completeTx({
          tx,
          operationId: 'operation-a',
          expectedClaimEpoch: 1,
          now: NOW + 5,
        }).state,
      ).toBe('completed')
    })

    expect(
      thrownCauseMessage(() =>
        db.run(sql`
          UPDATE collaboration_gate_operations
          SET receipt_json = '{"changed":true}'
          WHERE id = 'operation-a'
        `),
      ),
    ).toContain('human-gate-committed-receipt-immutable')
  })

  test('journals review artifacts as a complete set and rolls back the whole operation on throw', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db)
    const store = new SqliteHumanGateOperationStore()
    const openRequest = request({
      operationKind: 'open',
      actorUserId: null,
      expectedGateRevision: 0,
      payload: { kind: 'open', manifestDigest: 'manifest-digest' },
    })

    dbTxSync(db, (tx) => {
      begin(tx, store, 'operation-artifacts', openRequest, 'open-key')
      store.declareArtifactsTx({
        tx,
        operationId: 'operation-artifacts',
        artifacts: [
          {
            artifactKey: 'doc:0001',
            stagedPath: '.agent-workflow/staging/operation-artifacts/doc-1.md',
            finalPath: '.agent-workflow/reviews/task-333/doc-1.md',
            sha256: 'digest-1',
            byteSize: 42,
          },
        ],
        now: NOW + 1,
      })
      expectOperationError(
        () =>
          store.markPreparedTx({
            tx,
            operationId: 'operation-artifacts',
            expectedClaimEpoch: 1,
            manifestJson: JSON.stringify({ schemaVersion: 1, kind: 'review-open' }),
            now: NOW + 2,
          }),
        'human-gate-operation-manifest-invalid',
      )
      store.transitionArtifactTx({
        tx,
        operationId: 'operation-artifacts',
        artifactKey: 'doc:0001',
        from: 'declared',
        to: 'staged',
        receiptJson: '{"written":true}',
        now: NOW + 3,
      })
      store.markPreparedTx({
        tx,
        operationId: 'operation-artifacts',
        expectedClaimEpoch: 1,
        manifestJson: JSON.stringify({ schemaVersion: 1, kind: 'review-open' }),
        now: NOW + 4,
      })
      store.commitTx({
        tx,
        operationId: 'operation-artifacts',
        expectedClaimEpoch: 1,
        receiptJson: '{"parked":true}',
        now: NOW + 5,
      })
      expect(
        tx
          .select({ state: collaborationGateArtifacts.state })
          .from(collaborationGateArtifacts)
          .where(
            and(
              eq(collaborationGateArtifacts.operationId, 'operation-artifacts'),
              eq(collaborationGateArtifacts.artifactKey, 'doc:0001'),
            ),
          )
          .get()?.state,
      ).toBe('consumed')
      expectOperationError(
        () =>
          store.completeTx({
            tx,
            operationId: 'operation-artifacts',
            expectedClaimEpoch: 1,
            now: NOW + 6,
          }),
        'human-gate-operation-transition-invalid',
      )
      store.transitionArtifactTx({
        tx,
        operationId: 'operation-artifacts',
        artifactKey: 'doc:0001',
        from: 'consumed',
        to: 'finalized',
        receiptJson: '{"renamed":true}',
        now: NOW + 7,
      })
      expect(
        store.completeTx({
          tx,
          operationId: 'operation-artifacts',
          expectedClaimEpoch: 1,
          now: NOW + 8,
        }).state,
      ).toBe('completed')
    })

    expect(() =>
      dbTxSync(db, (tx) => {
        begin(
          tx,
          store,
          'operation-rolled-back',
          request({ gateRef: 'review:rollback', expectedGateRevision: 0 }),
          'rollback-key',
        )
        throw new Error('inject-rollback')
      }),
    ).toThrow('inject-rollback')
    expect(
      db
        .select({ id: collaborationGateOperations.id })
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, 'operation-rolled-back'))
        .get(),
    ).toBeUndefined()
  })

  test('seeds one legacy gate operation and replays it without allocating a second revision', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db)
    const store = new SqliteHumanGateOperationStore()
    const legacy = request({
      operationKind: 'legacy-seed',
      actorUserId: null,
      expectedGateRevision: 0,
      payload: { kind: 'legacy-seed', factDigest: 'legacy-facts-v1' },
    })

    dbTxSync(db, (tx) => {
      begin(tx, store, 'legacy-operation', legacy, 'legacy:review:node-a:1')
      store.commitTx({
        tx,
        operationId: 'legacy-operation',
        expectedClaimEpoch: 1,
        receiptJson: '{"legacy":true}',
        now: NOW + 1,
      })
      store.completeTx({
        tx,
        operationId: 'legacy-operation',
        expectedClaimEpoch: 1,
        now: NOW + 2,
      })
      const replay = begin(tx, store, 'ignored-operation', legacy, 'legacy:review:node-a:1')
      expect(replay).toMatchObject({
        replayed: true,
        operation: {
          id: 'legacy-operation',
          state: 'completed',
          resultGateRevision: 1,
        },
      })
    })
    expect(
      db
        .select()
        .from(collaborationGateOperations)
        .all()
        .map((row) => row.id),
    ).toEqual(['legacy-operation'])
  })
})
