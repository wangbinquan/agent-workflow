// RFC-359 W1-T1（前置）—— human-gate 操作日志（journal）与其 db-owning 端口实现在两个引擎上各跑一遍。
//
// 用例移植自 `rfc333-human-gate-operation-store.test.ts`（SQLite 同步 store 的黄金锁，仍保留）：同一段
// 断言现在跑在 `DatabaseHumanGateOperationJournal` + `DatabaseSession` 上，SQLite 与 PostgreSQL
// 都必须绿。此前 PostgreSQL 的 journal 副本从未在真库上跑过（dual-provider-parity-audit-2026-09-04）。
//
// 不移植的一条：SQLite 触发器 `human-gate-committed-receipt-immutable`（receipt 不可改）——触发器
// 还没投影到 PostgreSQL（RFC-359 W3-T16b），留在 SQLite 黄金锁里。

import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  collaborationGateArtifacts,
  collaborationGateOperations,
  tasks,
  workflows,
} from '@/db/schema'
import type { CanonicalHumanGateRequest } from '@/modules/collaboration/domain/canonicalGateRequest'
import { HumanGateOperationError } from '@/modules/collaboration/domain/humanGateOperation'
import { DatabaseHumanGateOperationJournal } from '@/modules/collaboration/infrastructure/humanGateOperationJournal'
import { DatabaseHumanGateOperationPersistence } from '@/modules/collaboration/infrastructure/humanGateOperationPersistence'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_969_612_066
const TASK_ID = 'task-359-journal'

async function seedTask(db: ProviderNeutralDatabase, taskId = TASK_ID): Promise<void> {
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: taskId,
    description: '',
    definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    repoPath: '/tmp/rfc359',
    worktreePath: '/tmp/rfc359',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW,
  })
}

function request(overrides: Partial<CanonicalHumanGateRequest> = {}): CanonicalHumanGateRequest {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
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

async function expectOperationError(
  run: () => Promise<unknown>,
  code: HumanGateOperationError['code'],
): Promise<void> {
  const error = await run().then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error, `expected HumanGateOperationError '${code}'`).toBeInstanceOf(
    HumanGateOperationError,
  )
  expect((error as HumanGateOperationError).code).toBe(code)
}

const journal = new DatabaseHumanGateOperationJournal()

function begin(
  tx: DatabaseTransaction,
  operationId: string,
  value: CanonicalHumanGateRequest,
  idempotencyKey: string,
) {
  return journal.beginTx({ tx, operationId, request: value, idempotencyKey, now: NOW })
}

describeEachProvider('RFC-359 T1 —— human-gate 操作日志', (harness) => {
  test('不会恢复认领一个有意等待任务 owner 的 manual-question 操作', async () => {
    await seedTask(harness.db)
    const persistence = new DatabaseHumanGateOperationPersistence(harness.session, journal)
    const created = await persistence.begin({
      operationId: 'manual-wait',
      request: request({
        gateKind: 'questions',
        operationKind: 'manual-question-open',
        gateRef: 'questions:manual',
        expectedGateRevision: 0,
        payload: { kind: 'manual-question-open', questionId: 'q-manual', targetNodeId: 'writer' },
      }),
      idempotencyKey: 'manual-key',
      now: NOW,
      preparedManifestJson: JSON.stringify({ schemaVersion: 1, kind: 'manual-question-open' }),
    })
    expect(created.operation.state).toBe('prepared')
    const claimed = await persistence.claimRecoveryBatch({
      now: NOW + 60_000,
      leaseMs: 30_000,
      limit: 10,
    })
    expect(claimed).toEqual([])
    expect(await persistence.get('manual-wait')).toMatchObject({ state: 'prepared', claimEpoch: 1 })
  })

  test('精确 key 重放；payload / actor 变了或同 gate 已有活跃操作 ⇒ 对应错误', async () => {
    await seedTask(harness.db)
    await harness.session.transaction(async (tx) => {
      const created = await begin(tx, 'operation-a', request(), 'decision-key')
      expect(created.replayed).toBe(false)
      expect(created.operation).toMatchObject({
        id: 'operation-a',
        state: 'preparing',
        claimEpoch: 1,
        resultGateRevision: null,
      })
      const replay = await begin(tx, 'operation-ignored', request(), 'decision-key')
      expect(replay.replayed).toBe(true)
      expect(replay.operation.id).toBe('operation-a')

      await expectOperationError(
        () =>
          begin(
            tx,
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
      await expectOperationError(
        () => begin(tx, 'operation-c', request({ actorUserId: 'user-b' }), 'decision-key'),
        'human-gate-idempotency-conflict',
      )
      await expectOperationError(
        () => begin(tx, 'operation-d', request(), 'another-key'),
        'human-gate-operation-conflict',
      )
    })
  })

  test('claim/state CAS、提交恰一次下一修订、重放保留 receipt', async () => {
    await seedTask(harness.db)
    const manifestJson = JSON.stringify({ schemaVersion: 1, kind: 'review-decision' })
    const receiptJson = JSON.stringify({ operationId: 'operation-a', accepted: true })
    await harness.session.transaction(async (tx) => {
      await begin(tx, 'operation-a', request(), 'decision-key')
      await expectOperationError(
        () =>
          journal.markPreparedTx({
            tx,
            operationId: 'operation-a',
            expectedClaimEpoch: 2,
            manifestJson,
            now: NOW + 1,
          }),
        'human-gate-operation-stale',
      )
      const prepared = await journal.markPreparedTx({
        tx,
        operationId: 'operation-a',
        expectedClaimEpoch: 1,
        manifestJson,
        now: NOW + 2,
      })
      expect(prepared.state).toBe('prepared')
      const committed = await journal.commitTx({
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
        (
          await journal.commitTx({
            tx,
            operationId: 'operation-a',
            expectedClaimEpoch: 1,
            receiptJson,
            now: NOW + 4,
          })
        ).receiptJson,
      ).toBe(receiptJson)
      await expectOperationError(
        () =>
          journal.commitTx({
            tx,
            operationId: 'operation-a',
            expectedClaimEpoch: 1,
            receiptJson: '{"changed":true}',
            now: NOW + 4,
          }),
        'human-gate-operation-stale',
      )
      expect(
        (
          await journal.completeTx({
            tx,
            operationId: 'operation-a',
            expectedClaimEpoch: 1,
            now: NOW + 5,
          })
        ).state,
      ).toBe('completed')
      expect(
        await journal.latestGateRevisionTx({
          tx,
          gateKind: 'review',
          gateRef: 'review:node-a:iteration-1',
        }),
      ).toBe(2)
    })
  })

  test('评审产物作为完整集合入账；操作体内抛错 ⇒ 整个操作回滚', async () => {
    await seedTask(harness.db)
    const openRequest = request({
      operationKind: 'open',
      actorUserId: null,
      expectedGateRevision: 0,
      payload: { kind: 'open', manifestDigest: 'manifest-digest' },
    })
    await harness.session.transaction(async (tx) => {
      await begin(tx, 'operation-artifacts', openRequest, 'open-key')
      await journal.declareArtifactsTx({
        tx,
        operationId: 'operation-artifacts',
        artifacts: [
          {
            artifactKey: 'doc:0001',
            stagedPath: '.agent-workflow/staging/operation-artifacts/doc-1.md',
            finalPath: '.agent-workflow/reviews/task-359/doc-1.md',
            sha256: 'digest-1',
            byteSize: 42,
          },
        ],
        now: NOW + 1,
      })
      await expectOperationError(
        () =>
          journal.markPreparedTx({
            tx,
            operationId: 'operation-artifacts',
            expectedClaimEpoch: 1,
            manifestJson: JSON.stringify({ schemaVersion: 1, kind: 'review-open' }),
            now: NOW + 2,
          }),
        'human-gate-operation-manifest-invalid',
      )
      await journal.transitionArtifactTx({
        tx,
        operationId: 'operation-artifacts',
        artifactKey: 'doc:0001',
        from: 'declared',
        to: 'staged',
        receiptJson: '{"written":true}',
        now: NOW + 3,
      })
      await journal.markPreparedTx({
        tx,
        operationId: 'operation-artifacts',
        expectedClaimEpoch: 1,
        manifestJson: JSON.stringify({ schemaVersion: 1, kind: 'review-open' }),
        now: NOW + 4,
      })
      await journal.commitTx({
        tx,
        operationId: 'operation-artifacts',
        expectedClaimEpoch: 1,
        receiptJson: '{"parked":true}',
        now: NOW + 5,
      })
      expect(
        (
          await tx
            .select({ state: collaborationGateArtifacts.state })
            .from(collaborationGateArtifacts)
            .where(
              and(
                eq(collaborationGateArtifacts.operationId, 'operation-artifacts'),
                eq(collaborationGateArtifacts.artifactKey, 'doc:0001'),
              ),
            )
            .get()
        )?.state,
      ).toBe('consumed')
      await expectOperationError(
        () =>
          journal.completeTx({
            tx,
            operationId: 'operation-artifacts',
            expectedClaimEpoch: 1,
            now: NOW + 6,
          }),
        'human-gate-operation-transition-invalid',
      )
      await journal.transitionArtifactTx({
        tx,
        operationId: 'operation-artifacts',
        artifactKey: 'doc:0001',
        from: 'consumed',
        to: 'finalized',
        receiptJson: '{"renamed":true}',
        now: NOW + 7,
      })
      expect(
        (
          await journal.completeTx({
            tx,
            operationId: 'operation-artifacts',
            expectedClaimEpoch: 1,
            now: NOW + 8,
          })
        ).state,
      ).toBe('completed')
      expect(
        (await journal.listArtifactsTx(tx, 'operation-artifacts')).map((a) => a.state),
      ).toEqual(['finalized'])
    })

    await expect(
      harness.session.transaction(async (tx) => {
        await begin(
          tx,
          'operation-rolled-back',
          request({ gateRef: 'review:rollback', expectedGateRevision: 0 }),
          'rollback-key',
        )
        throw new Error('inject-rollback')
      }),
    ).rejects.toThrow('inject-rollback')
    expect(
      await harness.db
        .select({ id: collaborationGateOperations.id })
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, 'operation-rolled-back'))
        .get(),
    ).toBeUndefined()
  })

  test('播种一条 legacy gate 操作并重放它，不再分配第二个修订', async () => {
    await seedTask(harness.db)
    const legacy = request({
      operationKind: 'legacy-seed',
      actorUserId: null,
      expectedGateRevision: 0,
      payload: { kind: 'legacy-seed', factDigest: 'legacy-facts-v1' },
    })
    await harness.session.transaction(async (tx) => {
      await begin(tx, 'legacy-operation', legacy, 'legacy:review:node-a:1')
      await journal.commitTx({
        tx,
        operationId: 'legacy-operation',
        expectedClaimEpoch: 1,
        receiptJson: '{"legacy":true}',
        now: NOW + 1,
      })
      await journal.completeTx({
        tx,
        operationId: 'legacy-operation',
        expectedClaimEpoch: 1,
        now: NOW + 2,
      })
      const replay = await begin(tx, 'ignored-operation', legacy, 'legacy:review:node-a:1')
      expect(replay).toMatchObject({
        replayed: true,
        operation: { id: 'legacy-operation', state: 'completed', resultGateRevision: 1 },
      })
    })
    expect(
      (
        await harness.db
          .select({ id: collaborationGateOperations.id })
          .from(collaborationGateOperations)
      ).map((row) => row.id),
    ).toEqual(['legacy-operation'])
  })

  test('恢复认领：从未认领过（claim_expires_at 为 NULL）的操作排在最前，且认领推进 claimEpoch', async () => {
    await seedTask(harness.db)
    const persistence = new DatabaseHumanGateOperationPersistence(harness.session, journal)
    await harness.session.transaction(async (tx) => {
      await begin(tx, 'op-expired', request({ gateRef: 'review:expired' }), 'k-expired')
      await begin(tx, 'op-never', request({ gateRef: 'review:never' }), 'k-never')
      // 模拟「从未被认领」：清掉租约到期时间。
      await tx
        .update(collaborationGateOperations)
        .set({ claimExpiresAt: null })
        .where(eq(collaborationGateOperations.id, 'op-never'))
        .run()
    })
    const claimed = await persistence.claimRecoveryBatch({
      now: NOW + 60_000,
      leaseMs: 30_000,
      limit: 1,
    })
    expect(
      claimed.map((op) => op.id),
      'NULL 到期时间必须排在最前——两个引擎同一顺序',
    ).toEqual(['op-never'])
    expect(claimed[0]?.claimEpoch).toBe(2)
    const renewed = await persistence.renewRecoveryClaim({
      operationId: 'op-never',
      expectedClaimEpoch: 2,
      now: NOW + 61_000,
      leaseMs: 30_000,
    })
    expect(renewed.claimExpiresAt).toBe(NOW + 91_000)
    await expectOperationError(
      () =>
        persistence.renewRecoveryClaim({
          operationId: 'op-never',
          expectedClaimEpoch: 1,
          now: NOW + 62_000,
          leaseMs: 30_000,
        }),
      'human-gate-operation-stale',
    )
  })
})
