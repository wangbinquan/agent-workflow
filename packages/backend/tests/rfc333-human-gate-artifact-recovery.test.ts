import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { collaborationGateArtifacts, collaborationGateOperations } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { HumanGateOperationRecovery } from '@/modules/collaboration/application/recoverHumanGateOperations'
import type {
  HumanGateArtifactStore,
  PlannedReviewArtifact,
} from '@/modules/collaboration/application/ports/humanGateArtifactStore'
import { DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS } from '@/modules/collaboration/application/ports/humanGateOperationStore'
import type { CanonicalHumanGateRequest } from '@/modules/collaboration/domain/canonicalGateRequest'
import {
  FsHumanGateArtifactStore,
  readCommittedReviewArtifactBody,
} from '@/modules/collaboration/infrastructure/fsHumanGateArtifactStore'
import { SqliteHumanGateOperationStore } from '@/modules/collaboration/infrastructure/sqliteHumanGateOperationStore'
import { MIGRATIONS } from './migration-freeze'

const NOW = 1_788_970_000_000
const tempHomes: string[] = []

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rfc333-artifacts-'))
  tempHomes.push(home)
  return home
}

function absolute(appHome: string, relativePath: string): string {
  return join(appHome, ...relativePath.split('/'))
}

function seedTask(db: ReturnType<typeof createInMemoryDb>): void {
  db.run(sql`
    INSERT INTO tasks (
      id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
      base_branch, branch, status, inputs, started_at
    ) VALUES (
      'task-333', 'task-333', 'workflow-333',
      '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      '/tmp/rfc333', '/tmp/rfc333', 'main', 'agent-workflow/task-333',
      'running', '{}', ${NOW}
    )
  `)
}

function openRequest(manifestDigest = 'source-v1'): CanonicalHumanGateRequest {
  return {
    schemaVersion: 1,
    taskId: 'task-333',
    gateKind: 'review',
    operationKind: 'open',
    gateRef: 'review:node-a:iteration-1',
    actorUserId: null,
    expectedTaskRevision: 7,
    expectedGateRevision: 0,
    payload: { kind: 'open', manifestDigest },
  }
}

function prepareReviewOperation(input: {
  db: ReturnType<typeof createInMemoryDb>
  operations: SqliteHumanGateOperationStore
  artifacts: FsHumanGateArtifactStore
  operationId: string
  idempotencyKey: string
  body: string
  finalPath?: string
}): PlannedReviewArtifact {
  const plan = input.artifacts.planReviewArtifact({
    operationId: input.operationId,
    artifactKey: 'doc:0001',
    finalPath: input.finalPath ?? 'runs/task-333/review/node-a/answer/v1-item-0001.md',
    body: input.body,
  })
  dbTxSync(input.db, (tx) => {
    input.operations.beginTx({
      tx,
      operationId: input.operationId,
      request: openRequest(),
      idempotencyKey: input.idempotencyKey,
      now: NOW,
    })
    input.operations.declareArtifactsTx({
      tx,
      operationId: input.operationId,
      artifacts: [plan],
      now: NOW + 1,
    })
  })
  const receiptJson = input.artifacts.stageReviewArtifact(plan, input.body)
  dbTxSync(input.db, (tx) => {
    input.operations.transitionArtifactTx({
      tx,
      operationId: input.operationId,
      artifactKey: plan.artifactKey,
      from: 'declared',
      to: 'staged',
      receiptJson,
      now: NOW + 2,
    })
    input.operations.markPreparedTx({
      tx,
      operationId: input.operationId,
      expectedClaimEpoch: 1,
      manifestJson: JSON.stringify({
        schemaVersion: 1,
        kind: 'review-open',
        items: [plan],
      }),
      now: NOW + 3,
    })
  })
  return plan
}

function commitPrepared(input: {
  db: ReturnType<typeof createInMemoryDb>
  operations: SqliteHumanGateOperationStore
  operationId: string
}): void {
  dbTxSync(input.db, (tx) => {
    input.operations.commitTx({
      tx,
      operationId: input.operationId,
      expectedClaimEpoch: 1,
      receiptJson: JSON.stringify({ operationId: input.operationId, parked: true }),
      now: NOW + 4,
    })
  })
}

describe('RFC-333 T4 review artifact recovery', () => {
  test('reads committed staged content before rename, then roll-forwards exactly once', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db)
    const appHome = tempHome()
    const operations = new SqliteHumanGateOperationStore()
    const artifacts = new FsHumanGateArtifactStore(appHome)
    const body = '# reviewed\n\ncomplete body\n'
    const plan = prepareReviewOperation({
      db,
      operations,
      artifacts,
      operationId: 'operation-committed',
      idempotencyKey: 'open-committed',
      body,
    })
    commitPrepared({ db, operations, operationId: 'operation-committed' })

    expect(existsSync(absolute(appHome, plan.finalPath))).toBe(false)
    expect(readCommittedReviewArtifactBody(db, appHome, plan.finalPath)).toBe(body)

    const recovery = new HumanGateOperationRecovery({
      db,
      operations,
      artifacts,
      preparedInspector: {
        inspectPreparedOperation: () => 'retain-for-owner-retry',
      },
      now: () => NOW + 4 + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1,
    })
    expect(recovery.runOnce()).toMatchObject({
      claimed: 1,
      finalized: 1,
      failed: 0,
    })
    expect(readFileSync(absolute(appHome, plan.finalPath), 'utf8')).toBe(body)
    expect(existsSync(absolute(appHome, plan.stagedPath))).toBe(false)
    expect(readCommittedReviewArtifactBody(db, appHome, plan.finalPath)).toBe(body)
    expect(
      db
        .select({ state: collaborationGateOperations.state })
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, 'operation-committed'))
        .get()?.state,
    ).toBe('completed')
    expect(
      db
        .select({ state: collaborationGateArtifacts.state })
        .from(collaborationGateArtifacts)
        .where(eq(collaborationGateArtifacts.operationId, 'operation-committed'))
        .get()?.state,
    ).toBe('finalized')
    expect(recovery.runOnce().claimed).toBe(0)
  })

  test('keeps committed staged fallback readable after one finalize failure and retries later', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db)
    const appHome = tempHome()
    const operations = new SqliteHumanGateOperationStore()
    const realArtifacts = new FsHumanGateArtifactStore(appHome)
    const body = '# retryable\n'
    const plan = prepareReviewOperation({
      db,
      operations,
      artifacts: realArtifacts,
      operationId: 'operation-retry',
      idempotencyKey: 'open-retry',
      body,
    })
    commitPrepared({ db, operations, operationId: 'operation-retry' })

    let failFinalize = true
    const faultingArtifacts: HumanGateArtifactStore = {
      planReviewArtifact: (input) => realArtifacts.planReviewArtifact(input),
      stageReviewArtifact: (artifact, content) =>
        realArtifacts.stageReviewArtifact(artifact, content),
      finalizeReviewArtifact: (artifact) => {
        if (failFinalize) {
          failFinalize = false
          throw new Error('inject-finalize-gap')
        }
        return realArtifacts.finalizeReviewArtifact(artifact)
      },
      cleanupReviewArtifact: (artifact) => realArtifacts.cleanupReviewArtifact(artifact),
    }
    let now = NOW + 4 + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1
    const firstRecovery = new HumanGateOperationRecovery({
      db,
      operations,
      artifacts: faultingArtifacts,
      preparedInspector: {
        inspectPreparedOperation: () => 'retain-for-owner-retry',
      },
      now: () => now,
    })
    expect(firstRecovery.runOnce()).toMatchObject({ claimed: 1, failed: 1 })
    expect(readCommittedReviewArtifactBody(db, appHome, plan.finalPath)).toBe(body)
    expect(existsSync(absolute(appHome, plan.finalPath))).toBe(false)

    now += DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1
    const secondRecovery = new HumanGateOperationRecovery({
      db,
      operations,
      artifacts: realArtifacts,
      preparedInspector: {
        inspectPreparedOperation: () => 'retain-for-owner-retry',
      },
      now: () => now,
    })
    expect(secondRecovery.runOnce()).toMatchObject({
      claimed: 1,
      finalized: 1,
      failed: 0,
    })
    expect(readFileSync(absolute(appHome, plan.finalPath), 'utf8')).toBe(body)
  })

  test('cleans a stale prepared operation and releases the exact-gate slot for a new source', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db)
    const appHome = tempHome()
    const operations = new SqliteHumanGateOperationStore()
    const artifacts = new FsHumanGateArtifactStore(appHome)
    const plan = prepareReviewOperation({
      db,
      operations,
      artifacts,
      operationId: 'operation-stale',
      idempotencyKey: 'open-stale',
      body: '# stale\n',
    })

    const recovery = new HumanGateOperationRecovery({
      db,
      operations,
      artifacts,
      preparedInspector: {
        inspectPreparedOperation: () => 'cleanup-stale',
      },
      now: () => NOW + 3 + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1,
    })
    expect(recovery.runOnce()).toMatchObject({ claimed: 1, cleaned: 1, failed: 0 })
    expect(existsSync(absolute(appHome, plan.stagedPath))).toBe(false)
    expect(
      db
        .select({
          state: collaborationGateOperations.state,
          failureJson: collaborationGateOperations.failureJson,
        })
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, 'operation-stale'))
        .get(),
    ).toMatchObject({
      state: 'completed',
      failureJson: expect.stringContaining('prepared-gate-stale-cleaned'),
    })
    expect(
      db
        .select()
        .from(collaborationGateArtifacts)
        .where(eq(collaborationGateArtifacts.operationId, 'operation-stale'))
        .all(),
    ).toEqual([])

    expect(
      dbTxSync(db, (tx) =>
        operations.beginTx({
          tx,
          operationId: 'operation-new-source',
          request: openRequest('source-v2'),
          idempotencyKey: 'open-new-source',
          now: NOW + 100_000,
        }),
      ).replayed,
    ).toBe(false)
  })

  test('retains incomplete preparing work with a fenced recovery epoch', () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db)
    const appHome = tempHome()
    const operations = new SqliteHumanGateOperationStore()
    const artifacts = new FsHumanGateArtifactStore(appHome)
    dbTxSync(db, (tx) => {
      operations.beginTx({
        tx,
        operationId: 'operation-preparing',
        request: openRequest(),
        idempotencyKey: 'open-preparing',
        now: NOW,
      })
    })
    let now = NOW + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1
    const recovery = new HumanGateOperationRecovery({
      db,
      operations,
      artifacts,
      preparedInspector: {
        inspectPreparedOperation: () => 'cleanup-stale',
      },
      now: () => now,
    })
    expect(recovery.runOnce()).toMatchObject({ claimed: 1, retained: 1, failed: 0 })
    expect(
      db
        .select({
          state: collaborationGateOperations.state,
          claimEpoch: collaborationGateOperations.claimEpoch,
        })
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, 'operation-preparing'))
        .get(),
    ).toEqual({ state: 'preparing', claimEpoch: 2 })
    expect(recovery.runOnce().claimed).toBe(0)
    now += DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1
    expect(recovery.runOnce().claimed).toBe(1)
  })

  test('recovery source has no task-drive or native-timer authority', () => {
    const recoverySource = readFileSync(
      resolve(
        import.meta.dir,
        '../src/modules/collaboration/application/recoverHumanGateOperations.ts',
      ),
      'utf8',
    )
    const tickerSource = readFileSync(
      resolve(
        import.meta.dir,
        '../src/modules/collaboration/composition/humanGateRecoveryTicker.ts',
      ),
      'utf8',
    )
    expect(recoverySource).not.toContain('task-execution')
    expect(recoverySource).not.toContain('submitTaskContinuation')
    expect(recoverySource).not.toContain('resumeTask')
    expect(tickerSource).not.toContain('setInterval(')
    expect(tickerSource).toContain('startMaintenanceTicker(')
  })
})
