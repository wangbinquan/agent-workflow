import {
  createCollaborationCommandContext,
  resolveCollaborationCommandContext,
} from '@/modules/collaboration/composition/commandContext'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
import { ReviewGateOpenPreparation } from '@/modules/collaboration/application/prepareReviewGateOpen'
import { CommittedHumanGateFinalizer } from '@/modules/collaboration/application/finalizeCommittedHumanGate'
import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'

import { collaborationGateArtifacts, collaborationGateOperations } from '@/db/schema'
import { HumanGateOperationRecovery } from '@/modules/collaboration/application/recoverHumanGateOperations'
import type {
  HumanGateArtifactStore,
  PlannedReviewArtifact,
} from '@/modules/collaboration/application/ports/humanGateArtifactStore'
import { DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS } from '@/modules/collaboration/application/ports/humanGateOperationStore'
import type { CanonicalHumanGateRequest } from '@/modules/collaboration/domain/canonicalGateRequest'
import { FsHumanGateArtifactStore } from '@/modules/collaboration/infrastructure/fsHumanGateArtifactStore'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { DatabaseHumanGateOperationJournal } from '@/modules/collaboration/infrastructure/humanGateOperationJournal'
import { DatabaseHumanGateOperationPersistence } from '@/modules/collaboration/infrastructure/humanGateOperationPersistence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'

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

async function seedTask(db: ProviderNeutralDatabase): Promise<void> {
  await db.run(sql`
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

async function prepareReviewOperation(input: {
  db: ProviderNeutralDatabase
  operations: DatabaseHumanGateOperationJournal
  artifacts: FsHumanGateArtifactStore
  operationId: string
  idempotencyKey: string
  body: string
  finalPath?: string
}): Promise<PlannedReviewArtifact> {
  const plan = input.artifacts.planReviewArtifact({
    operationId: input.operationId,
    artifactKey: 'doc:0001',
    finalPath: input.finalPath ?? 'runs/task-333/review/node-a/answer/v1-item-0001.md',
    body: input.body,
  })
  await databaseSessionFor(input.db).transaction(async (tx) => {
    await input.operations.beginTx({
      tx,
      operationId: input.operationId,
      request: openRequest(),
      idempotencyKey: input.idempotencyKey,
      now: NOW,
    })
    await input.operations.declareArtifactsTx({
      tx,
      operationId: input.operationId,
      artifacts: [plan],
      now: NOW + 1,
    })
  })
  const receiptJson = input.artifacts.stageReviewArtifact(plan, input.body)
  await databaseSessionFor(input.db).transaction(async (tx) => {
    await input.operations.transitionArtifactTx({
      tx,
      operationId: input.operationId,
      artifactKey: plan.artifactKey,
      from: 'declared',
      to: 'staged',
      receiptJson,
      now: NOW + 2,
    })
    await input.operations.markPreparedTx({
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

async function commitPrepared(input: {
  db: ProviderNeutralDatabase
  operations: DatabaseHumanGateOperationJournal
  operationId: string
}): Promise<void> {
  await databaseSessionFor(input.db).transaction(async (tx) => {
    await input.operations.commitTx({
      tx,
      operationId: input.operationId,
      expectedClaimEpoch: 1,
      receiptJson: JSON.stringify({ operationId: input.operationId, parked: true }),
      now: NOW + 4,
    })
  })
}

function deferredEffect() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    async wait() {
      enter()
      await released
    },
  }
}

describe('RFC-333 T4 review artifact recovery', () => {
  describeEachProvider('database behavior', (harness) => {
    // RFC-370: remote durable effects may suspend. Database receipts must not
    // get ahead of content staging, publication or cleanup.
    test('awaits asynchronous staging and post-commit publication before recording receipts', async () => {
      const db = harness.db
      await seedTask(db)
      const appHome = tempHome()
      const operations = new DatabaseHumanGateOperationPersistence(databaseSessionFor(db))
      const real = new FsHumanGateArtifactStore(appHome)
      const stage = deferredEffect()
      const publish = deferredEffect()
      const artifacts: HumanGateArtifactStore = {
        planReviewArtifact: (input) => real.planReviewArtifact(input),
        async stageReviewArtifact(plan, body) {
          await stage.wait()
          return real.stageReviewArtifact(plan, body)
        },
        async finalizeReviewArtifact(artifact) {
          await publish.wait()
          return real.finalizeReviewArtifact(artifact)
        },
        cleanupReviewArtifact: (artifact) => real.cleanupReviewArtifact(artifact),
      }
      const input = {
        taskId: 'task-333',
        reviewNodeId: 'review-async',
        containerRunId: null,
        iteration: 0,
        reviewIteration: 0,
        consumedUpstreamRunsJson: '{}',
        sourceSnapshotDigest: 'source-async',
        idempotencyKey: 'async-prepare',
        expectedTaskRevision: 7,
        now: NOW,
        documents: [
          {
            body: '# async content\n',
            sourceNodeId: 'agent',
            sourcePortName: 'answer',
            versionIndex: 1,
            reviewIteration: 0,
          },
        ],
      }
      const pending = new ReviewGateOpenPreparation(operations, artifacts).prepare(input)
      try {
        await Promise.race([
          stage.entered,
          pending.then(() => {
            throw new Error('prepare returned before durable staging')
          }),
        ])
        const active = await operations.findByIdempotency({
          taskId: input.taskId,
          gateKind: 'review',
          operationKind: 'open',
          idempotencyKey: input.idempotencyKey,
        })
        expect(active?.state).toBe('preparing')
        if (active === null) throw new Error('operation was not declared')
        expect(
          (await operations.listArtifacts(active.id)).map((artifact) => artifact.state),
        ).toEqual(['declared'])
      } finally {
        stage.release()
      }
      const prepared = await pending
      expect(prepared.kind).toBe('prepared')
      expect(prepared.operation.state).toBe('prepared')
      const id = prepared.operation.id
      await operations.commit({
        operationId: id,
        expectedClaimEpoch: prepared.operation.claimEpoch,
        receiptJson: '{}',
        now: NOW + 1,
      })
      const finishing = new CommittedHumanGateFinalizer(operations, artifacts).finalize({
        operationId: id,
        now: NOW + 2,
      })
      try {
        await Promise.race([
          publish.entered,
          finishing.then(() => {
            throw new Error('finalizer returned before durable publication')
          }),
        ])
        expect((await operations.get(id))?.state).toBe('committed')
        const [artifact] = await operations.listArtifacts(id)
        expect(artifact?.state).toBe('consumed')
        if (artifact === undefined) throw new Error('artifact was not declared')
        expect(
          await new DatabaseCommittedReviewArtifactReader(
            db,
            createFileReviewArtifactContent(appHome),
          ).read(artifact.finalPath),
        ).toBe('# async content\n')
        expect(existsSync(absolute(appHome, artifact.finalPath))).toBe(false)
      } finally {
        publish.release()
      }
      await finishing
      expect((await operations.get(id))?.state).toBe('completed')
      expect((await operations.listArtifacts(id)).map((artifact) => artifact.state)).toEqual([
        'finalized',
      ])
    })

    test('recovery awaits asynchronous cleanup before releasing artifact declarations', async () => {
      const db = harness.db
      await seedTask(db)
      const appHome = tempHome()
      const journal = new DatabaseHumanGateOperationJournal()
      const real = new FsHumanGateArtifactStore(appHome)
      const plan = await prepareReviewOperation({
        db,
        operations: journal,
        artifacts: real,
        operationId: 'operation-async-cleanup',
        idempotencyKey: 'async-cleanup',
        body: '# cleanup\n',
      })
      const operations = new DatabaseHumanGateOperationPersistence(databaseSessionFor(db))
      const cleanup = deferredEffect()
      const artifacts: HumanGateArtifactStore = {
        planReviewArtifact: (input) => real.planReviewArtifact(input),
        stageReviewArtifact: (plan, body) => real.stageReviewArtifact(plan, body),
        finalizeReviewArtifact: (artifact) => real.finalizeReviewArtifact(artifact),
        async cleanupReviewArtifact(artifact) {
          await cleanup.wait()
          real.cleanupReviewArtifact(artifact)
        },
      }
      const pending = new HumanGateOperationRecovery({
        operations,
        artifacts,
        preparedInspector: { inspectPreparedOperation: () => 'cleanup-stale' },
        now: () => NOW + 3 + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1,
      }).runOnce()
      try {
        await Promise.race([
          cleanup.entered,
          pending.then(() => {
            throw new Error('recovery returned before durable cleanup')
          }),
        ])
        expect((await operations.get(plan.operationId))?.state).toBe('cleanup_pending')
        expect(await operations.listArtifacts(plan.operationId)).toHaveLength(1)
        expect(existsSync(absolute(appHome, plan.stagedPath))).toBe(true)
      } finally {
        cleanup.release()
      }
      expect(await pending).toMatchObject({ cleaned: 1, failed: 0 })
      expect((await operations.get(plan.operationId))?.state).toBe('completed')
      expect(await operations.listArtifacts(plan.operationId)).toEqual([])
      expect(existsSync(absolute(appHome, plan.stagedPath))).toBe(false)
    })

    test('composes asynchronous committed content without a local home and preserves staged fallback', async () => {
      const db = harness.db
      await seedTask(db)
      const real = new FsHumanGateArtifactStore(tempHome())
      const body = '# alternate content\n'
      const plan = await prepareReviewOperation({
        db,
        operations: new DatabaseHumanGateOperationJournal(),
        artifacts: real,
        operationId: 'operation-content-port',
        idempotencyKey: 'content-port',
        body,
      })
      await commitPrepared({
        db,
        operations: new DatabaseHumanGateOperationJournal(),
        operationId: plan.operationId,
      })
      const objects = new Map<string, Uint8Array>([[plan.stagedPath, Buffer.from(body)]])
      const reads: string[] = []
      const loaded = deferredEffect()
      let readFailure: Error | null = null
      const context = createCollaborationCommandContext({
        db,
        reviewArtifacts: {
          store: real,
          content: {
            async read(reference) {
              reads.push(reference)
              await loaded.wait()
              if (readFailure !== null) throw readFailure
              const bytes = objects.get(reference)
              return bytes === undefined ? null : { body: bytes, label: `fixture:${reference}` }
            },
          },
        },
      })
      const reader = resolveCollaborationCommandContext(context).persistence.committedArtifacts
      if (reader === undefined) throw new Error('content reader was not composed')
      expect(resolveCollaborationCommandContext(context).artifacts).toBe(real)
      const pending = reader.read(plan.finalPath)
      try {
        await Promise.race([
          loaded.entered,
          pending.then(() => {
            throw new Error('reader returned before content loaded')
          }),
        ])
        expect(reads).toEqual([plan.finalPath])
      } finally {
        loaded.release()
      }
      expect(await pending).toBe(body)
      expect(reads).toEqual([plan.finalPath, plan.stagedPath])
      objects.set(plan.finalPath, Buffer.from(body))
      objects.delete(plan.stagedPath)
      expect(await reader.read(plan.finalPath)).toBe(body)
      objects.set(plan.finalPath, Buffer.from('changed'))
      await expect(reader.read(plan.finalPath)).rejects.toMatchObject({
        code: 'human-gate-artifact-digest-mismatch',
      })
      objects.delete(plan.finalPath)
      await expect(reader.read(plan.finalPath)).rejects.toMatchObject({
        code: 'human-gate-artifact-missing',
      })
      // Legacy documents without an operation journal remain readable.
      objects.set('runs/legacy-review.md', Buffer.from('legacy'))
      expect(await reader.read('runs/legacy-review.md')).toBe('legacy')
      readFailure = new Error('fixture-content-unavailable')
      await expect(reader.read(plan.finalPath)).rejects.toThrow('fixture-content-unavailable')
    })

    test('reads committed staged content before rename, then roll-forwards exactly once', async () => {
      const db = harness.db
      await seedTask(db)
      const appHome = tempHome()
      const operations = new DatabaseHumanGateOperationJournal()
      const artifacts = new FsHumanGateArtifactStore(appHome)
      const body = '# reviewed\n\ncomplete body\n'
      const plan = await prepareReviewOperation({
        db,
        operations,
        artifacts,
        operationId: 'operation-committed',
        idempotencyKey: 'open-committed',
        body,
      })
      await commitPrepared({ db, operations, operationId: 'operation-committed' })

      expect(existsSync(absolute(appHome, plan.finalPath))).toBe(false)
      expect(
        await new DatabaseCommittedReviewArtifactReader(
          db,
          createFileReviewArtifactContent(appHome),
        ).read(plan.finalPath),
      ).toBe(body)

      const recovery = new HumanGateOperationRecovery({
        operations: new DatabaseHumanGateOperationPersistence(databaseSessionFor(db)),
        artifacts,
        preparedInspector: {
          inspectPreparedOperation: () => 'retain-for-owner-retry',
        },
        now: () => NOW + 4 + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1,
      })
      expect(await recovery.runOnce()).toMatchObject({
        claimed: 1,
        finalized: 1,
        failed: 0,
      })
      expect(readFileSync(absolute(appHome, plan.finalPath), 'utf8')).toBe(body)
      expect(existsSync(absolute(appHome, plan.stagedPath))).toBe(false)
      expect(
        await new DatabaseCommittedReviewArtifactReader(
          db,
          createFileReviewArtifactContent(appHome),
        ).read(plan.finalPath),
      ).toBe(body)
      expect(
        (
          await db
            .select({ state: collaborationGateOperations.state })
            .from(collaborationGateOperations)
            .where(eq(collaborationGateOperations.id, 'operation-committed'))
            .get()
        )?.state,
      ).toBe('completed')
      expect(
        (
          await db
            .select({ state: collaborationGateArtifacts.state })
            .from(collaborationGateArtifacts)
            .where(eq(collaborationGateArtifacts.operationId, 'operation-committed'))
            .get()
        )?.state,
      ).toBe('finalized')
      expect((await recovery.runOnce()).claimed).toBe(0)
    })

    test('keeps committed staged fallback readable after one finalize failure and retries later', async () => {
      const db = harness.db
      await seedTask(db)
      const appHome = tempHome()
      const operations = new DatabaseHumanGateOperationJournal()
      const realArtifacts = new FsHumanGateArtifactStore(appHome)
      const body = '# retryable\n'
      const plan = await prepareReviewOperation({
        db,
        operations,
        artifacts: realArtifacts,
        operationId: 'operation-retry',
        idempotencyKey: 'open-retry',
        body,
      })
      await commitPrepared({ db, operations, operationId: 'operation-retry' })

      let failFinalize = true
      const faultingArtifacts: HumanGateArtifactStore = {
        planReviewArtifact: (input) => realArtifacts.planReviewArtifact(input),
        stageReviewArtifact: (artifact, content) =>
          realArtifacts.stageReviewArtifact(artifact, content),
        finalizeReviewArtifact: async (artifact) => {
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
        operations: new DatabaseHumanGateOperationPersistence(databaseSessionFor(db)),
        artifacts: faultingArtifacts,
        preparedInspector: {
          inspectPreparedOperation: () => 'retain-for-owner-retry',
        },
        now: () => now,
      })
      expect(await firstRecovery.runOnce()).toMatchObject({ claimed: 1, failed: 1 })
      expect(
        await new DatabaseCommittedReviewArtifactReader(
          db,
          createFileReviewArtifactContent(appHome),
        ).read(plan.finalPath),
      ).toBe(body)
      expect(existsSync(absolute(appHome, plan.finalPath))).toBe(false)

      now += DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1
      const secondRecovery = new HumanGateOperationRecovery({
        operations: new DatabaseHumanGateOperationPersistence(databaseSessionFor(db)),
        artifacts: realArtifacts,
        preparedInspector: {
          inspectPreparedOperation: () => 'retain-for-owner-retry',
        },
        now: () => now,
      })
      expect(await secondRecovery.runOnce()).toMatchObject({
        claimed: 1,
        finalized: 1,
        failed: 0,
      })
      expect(readFileSync(absolute(appHome, plan.finalPath), 'utf8')).toBe(body)
    })

    test('cleans a stale prepared operation and releases the exact-gate slot for a new source', async () => {
      const db = harness.db
      await seedTask(db)
      const appHome = tempHome()
      const operations = new DatabaseHumanGateOperationJournal()
      const artifacts = new FsHumanGateArtifactStore(appHome)
      const plan = await prepareReviewOperation({
        db,
        operations,
        artifacts,
        operationId: 'operation-stale',
        idempotencyKey: 'open-stale',
        body: '# stale\n',
      })

      const recovery = new HumanGateOperationRecovery({
        operations: new DatabaseHumanGateOperationPersistence(databaseSessionFor(db)),
        artifacts,
        preparedInspector: {
          inspectPreparedOperation: () => 'cleanup-stale',
        },
        now: () => NOW + 3 + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1,
      })
      expect(await recovery.runOnce()).toMatchObject({ claimed: 1, cleaned: 1, failed: 0 })
      expect(existsSync(absolute(appHome, plan.stagedPath))).toBe(false)
      expect(
        await db
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
        await db
          .select()
          .from(collaborationGateArtifacts)
          .where(eq(collaborationGateArtifacts.operationId, 'operation-stale'))
          .all(),
      ).toEqual([])

      const reopened = await databaseSessionFor(db).transaction(
        async (tx) =>
          await operations.beginTx({
            tx,
            operationId: 'operation-new-source',
            request: openRequest('source-v2'),
            idempotencyKey: 'open-new-source',
            now: NOW + 100_000,
          }),
      )
      expect(reopened.replayed).toBe(false)
    })

    test('retains incomplete preparing work with a fenced recovery epoch', async () => {
      const db = harness.db
      await seedTask(db)
      const appHome = tempHome()
      const operations = new DatabaseHumanGateOperationJournal()
      const artifacts = new FsHumanGateArtifactStore(appHome)
      await databaseSessionFor(db).transaction(async (tx) => {
        await operations.beginTx({
          tx,
          operationId: 'operation-preparing',
          request: openRequest(),
          idempotencyKey: 'open-preparing',
          now: NOW,
        })
      })
      let now = NOW + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1
      const recovery = new HumanGateOperationRecovery({
        operations: new DatabaseHumanGateOperationPersistence(databaseSessionFor(db)),
        artifacts,
        preparedInspector: {
          inspectPreparedOperation: () => 'cleanup-stale',
        },
        now: () => now,
      })
      expect(await recovery.runOnce()).toMatchObject({ claimed: 1, retained: 1, failed: 0 })
      expect(
        await db
          .select({
            state: collaborationGateOperations.state,
            claimEpoch: collaborationGateOperations.claimEpoch,
          })
          .from(collaborationGateOperations)
          .where(eq(collaborationGateOperations.id, 'operation-preparing'))
          .get(),
      ).toEqual({ state: 'preparing', claimEpoch: 2 })
      expect((await recovery.runOnce()).claimed).toBe(0)
      now += DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS + 1
      expect((await recovery.runOnce()).claimed).toBe(1)
    })
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
