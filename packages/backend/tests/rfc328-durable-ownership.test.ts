// RFC-328 core correctness matrix. These fixtures use the real migration and
// SQLite adapters; no clock sleeps or process-global task map is involved.

import { describe, expect, test } from 'bun:test'
import { and, eq, isNull } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  nodeRuns,
  nodeRunOutputs,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionMaintenanceClaims,
  taskExecutionMaintenanceMembers,
  taskExecutionOwners,
  tasks,
} from '@/db/schema'
import { createTaskExecutionTestModule } from '@/modules/task-execution/composition'
import {
  createExclusiveDaemonLockProof,
  createVerifiedOutcomeUnknownClosure,
  createVerifiedStopProof,
  decideOwnerTransition,
} from '@/modules/task-execution/domain/ownership'
import {
  finalizeTaskExecutionRecovery,
  prepareTaskExecutionRecovery,
} from '@/modules/task-execution/application/recoverTaskExecutions'
import {
  aggregateEffectOutcome,
  canonicalResourceKeySet,
  operationFamilyKey,
  requestHash,
} from '@/modules/task-execution/domain/executionEffect'
import {
  canonicalJson,
  mayAuthorizeReplay,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import { recoverInterruptedTaskDeletes } from '@/services/taskDelete'
import { archiveTaskTree } from '@/services/taskArchive'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createLocalEffectAttemptObserver } from '@/modules/task-execution/application/localEffectObserver'
import { buildCodeHostRecoveryDescriptor } from '@/modules/task-execution/domain/codeHostRecovery'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function db(): DbClient {
  return createInMemoryDb(MIGRATIONS)
}

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

function seedTask(
  database: DbClient,
  taskId: string,
  status: 'pending' | 'done' = 'pending',
): void {
  database
    .insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'workflow-rfc328',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      workflowVersion: 1,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status,
      inputs: '{}',
      startedAt: 1,
      finishedAt: status === 'done' ? 2 : null,
      executionLineageId: taskId,
      lineageSlotPathJson: canonicalJson(rootPath(taskId)),
    })
    .run()
}

function continuation(
  taskId: string,
  kind: CanonicalContinuationRequest['kind'] = 'launch',
  generation = 0,
): CanonicalContinuationRequest {
  return {
    taskId,
    kind,
    source: kind === 'launch' ? 'rest' : 'mcp',
    actorUserId: 'actor-1',
    expectedTaskRevision: 1,
    scope: {
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPath: rootPath(taskId),
      operationGeneration: generation,
    },
    payload: { v: 1 },
  }
}

describe('RFC-328 ownership domain and durable owner adapter', () => {
  test('continuation admission compares migrated lineage JSON semantically', () => {
    const database = db()
    seedTask(database, 'task-migrated-lineage')
    // SQLite json_object() preserves this insertion order. The application
    // encoder sorts keys, so a raw-string comparison would reject the same
    // lineage after migration and break every manual continuation.
    database
      .update(tasks)
      .set({
        lineageSlotPathJson:
          '[{"stableNodeKey":"task-root","frozenOccurrenceKey":"task-migrated-lineage","workflowRevision":1}]',
      })
      .where(eq(tasks.id, 'task-migrated-lineage'))
      .run()

    const module = createTaskExecutionTestModule('daemon-migrated-lineage')
    expect(
      module.intents.submit({
        db: database,
        request: continuation('task-migrated-lineage', 'resume', 1),
        intentId: 'intent-migrated-lineage',
      }).state,
    ).toBe('pending')
  })

  test('transition oracle never reuses an epoch and timeout alone cannot take over', () => {
    expect(decideOwnerTransition({ current: 'absent', operation: 'initial-claim' })).toEqual({
      from: 'absent',
      to: 'claimed',
      incrementsEpoch: true,
    })
    expect(decideOwnerTransition({ current: 'claimed', operation: 'takeover' })).toBeNull()
    expect(decideOwnerTransition({ current: 'revoked', operation: 'takeover' })).toEqual({
      from: 'revoked',
      to: 'claimed',
      incrementsEpoch: true,
    })
    expect(decideOwnerTransition({ current: 'released', operation: 'initial-claim' })).toEqual({
      from: 'released',
      to: 'claimed',
      incrementsEpoch: true,
    })
  })

  test('one pending intent has one winner; a revoked epoch writes zero domain rows', () => {
    const database = db()
    seedTask(database, 'task-owner')
    const module = createTaskExecutionTestModule('daemon-owner')
    const submitted = module.intents.submit({
      db: database,
      request: continuation('task-owner'),
      intentId: 'intent-owner-1',
      now: 10,
    })
    const claimed = module.claim({ db: database, intentId: submitted.intentId, now: 11 })
    module.claimGate.leave(claimed.permit)

    expect(() => module.claim({ db: database, intentId: submitted.intentId, now: 12 })).toThrow(
      expect.objectContaining({ code: 'task-execution-owner-conflict' }),
    )
    const before = module.ownership.read(database, 'task-owner')!
    module.ownership.revokeExact({
      db: database,
      owner: {
        taskId: before.taskId,
        ownerId: before.ownerId,
        daemonGeneration: before.daemonGeneration,
        epoch: before.epoch,
      },
      expectedRevision: before.revision,
      now: 13,
    })
    expect(() =>
      module.ownership.withOwnedTaskTx({
        db: database,
        token: claimed.token,
        now: 14,
        run: (tx) =>
          tx
            .update(tasks)
            .set({ errorSummary: 'stale-write' })
            .where(eq(tasks.id, 'task-owner'))
            .run(),
      }),
    ).toThrow(expect.objectContaining({ code: 'task-execution-stale-owner' }))
    expect(database.select({ value: tasks.errorSummary }).from(tasks).get()?.value).toBeNull()

    const revoked = module.ownership.read(database, 'task-owner')!
    module.ownership.releaseAfterStop({
      db: database,
      token: claimed.token,
      intentId: submitted.intentId,
      proof: createVerifiedStopProof({
        taskId: 'task-owner',
        ownerRevision: revoked.revision,
        epoch: claimed.token.epoch,
        evidenceDigest: 'reaped-owner-epoch-1',
        verifiedAt: 15,
      }),
      now: 15,
    })
    const nextIntent = module.intents.submit({
      db: database,
      request: continuation('task-owner', 'resume', 1),
      intentId: 'intent-owner-2',
      now: 16,
    })
    const successor = module.claim({ db: database, intentId: nextIntent.intentId, now: 17 })
    module.claimGate.leave(successor.permit)
    expect(successor.token.epoch).toBe(claimed.token.epoch + 1)
  })
})

describe('RFC-328 exact-token runtime registry', () => {
  test('sticky stop closes both stop-first and attach-first claim windows', async () => {
    const database = db()
    seedTask(database, 'task-stop-first')
    seedTask(database, 'task-attach-first')
    const module = createTaskExecutionTestModule('daemon-runtime')

    const firstIntent = module.intents.submit({
      db: database,
      request: continuation('task-stop-first'),
      intentId: 'intent-stop-first',
    })
    const first = module.claim({ db: database, intentId: firstIntent.intentId })
    const firstTicket = module.runtimeRegistry.requestStop(first.token, 'cancel-before-attach')
    const firstController = new AbortController()
    expect(
      module.runtimeRegistry.tryAttach({
        token: first.token,
        intentId: first.intentId,
        permit: first.permit,
        controller: firstController,
      }),
    ).toBe('rejected-stopped')
    expect(firstController.signal.aborted).toBe(true)
    module.claimGate.leave(first.permit)
    expect((await module.runtimeRegistry.awaitStopped(firstTicket)).kind).toBe('released')

    const secondIntent = module.intents.submit({
      db: database,
      request: continuation('task-attach-first'),
      intentId: 'intent-attach-first',
    })
    const second = module.claim({ db: database, intentId: secondIntent.intentId })
    const secondController = new AbortController()
    expect(
      module.runtimeRegistry.tryAttach({
        token: second.token,
        intentId: second.intentId,
        permit: second.permit,
        controller: secondController,
      }),
    ).toBe('attached')
    module.claimGate.leave(second.permit)
    const secondTicket = module.runtimeRegistry.requestStop(second.token, 'cancel-after-attach')
    expect(secondController.signal.aborted).toBe(true)
    expect(
      module.runtimeRegistry.release({ token: second.token, controller: secondController }),
    ).toBe(true)
    expect((await module.runtimeRegistry.awaitStopped(secondTicket)).kind).toBe('released')
  })

  test('module disposal seals admission, drains permits, and stops exact handles', async () => {
    const database = db()
    seedTask(database, 'task-module-dispose')
    const module = createTaskExecutionTestModule('daemon-module-dispose')
    const intent = module.intents.submit({
      db: database,
      request: continuation('task-module-dispose'),
      intentId: 'intent-module-dispose',
    })
    const claim = module.claim({ db: database, intentId: intent.intentId })
    const controller = new AbortController()
    expect(
      module.runtimeRegistry.tryAttach({
        token: claim.token,
        intentId: claim.intentId,
        permit: claim.permit,
        controller,
      }),
    ).toBe('attached')
    module.claimGate.leave(claim.permit)

    const tickets = await module.dispose('test-daemon-dispose')
    expect(tickets).toHaveLength(1)
    expect(controller.signal.aborted).toBe(true)
    expect(() => module.claimGate.enter()).toThrow(
      expect.objectContaining({ code: 'task-execution-shutting-down' }),
    )
    expect(module.runtimeRegistry.release({ token: claim.token, controller })).toBe(true)
    expect((await module.runtimeRegistry.awaitStopped(tickets[0]!)).kind).toBe('released')
  })
})

describe('RFC-328 logical effect, fence, watermark and unknown closure', () => {
  test('local effect generations follow their own retained family, not the task continuation count', () => {
    const database = db()
    seedTask(database, 'task-local-generation')
    const module = createTaskExecutionTestModule('daemon-local-generation')
    const intent = module.intents.submit({
      db: database,
      request: continuation('task-local-generation', 'resume', 7),
      intentId: 'intent-local-generation',
    })
    const claim = module.claim({ db: database, intentId: intent.intentId })
    module.claimGate.leave(claim.permit)
    const context = createTaskExecutionContext({
      db: database,
      intentId: intent.intentId,
      token: claim.token,
    })
    const prepare = () =>
      createLocalEffectAttemptObserver({
        db: database,
        taskId: 'task-local-generation',
        kind: 'workspace-rollback',
        stableActionOrdinal: 'workspace-rollback',
        candidateId: 'generation-fixture',
        request: { v: 1, target: 'snapshot-a' },
        resourceKeys: ['workspace:/tmp/worktree'],
        context,
      })!

    const first = prepare()
    first.beforeAct()
    first.succeed({ snapshot: 'snapshot-a' })
    expect(
      database
        .select({ generation: taskExecutionEffects.operationGeneration })
        .from(taskExecutionEffects)
        .all()
        .map((row) => row.generation),
    ).toEqual([0])

    const second = prepare()
    second.beforeAct()
    expect(
      database
        .select({ generation: taskExecutionEffects.operationGeneration })
        .from(taskExecutionEffects)
        .all()
        .map((row) => row.generation)
        .sort(),
    ).toEqual([0, 1])
  })

  test('a stop between probe authorization and resend releases the owner without losing the retry', () => {
    const database = db()
    seedTask(database, 'task-probe-stop-window')
    const module = createTaskExecutionTestModule('daemon-probe-stop-window')
    const intent = module.intents.submit({
      db: database,
      request: continuation('task-probe-stop-window'),
      intentId: 'intent-probe-stop-window',
    })
    const claim = module.claim({ db: database, intentId: intent.intentId })
    module.claimGate.leave(claim.permit)
    const pathJson = canonicalJson(rootPath('task-probe-stop-window'))
    const family = operationFamilyKey({
      executionLineageId: 'task-probe-stop-window',
      slotPath: rootPath('task-probe-stop-window'),
      effectKind: 'code-host-mutation',
      stableActionOrdinal: 'pipeline-retry',
    })
    const prepared = module.effects.prepareAndAcquire({
      db: database,
      token: claim.token,
      intentId: intent.intentId,
      operationKey: 'pipeline-retry',
      executionLineageId: 'task-probe-stop-window',
      operationFamilyKey: family,
      operationGeneration: 0,
      kind: 'code-host-mutation',
      requestHash: requestHash({ pipeline: 17 }),
      slotPathJson: pathJson,
      slotPathDigest: requestHash(pathJson),
      candidateId: 'pipeline.retry:c0:t1',
      recoveryClass: 'R-RUN-RETRY',
      classifierVersion: 'test-v1',
      transportPolicyVersion: 'test-v1',
      retryAuthority: 'none',
      resourceKeys: ['code-host:gitlab:pipeline:17'],
      now: 40,
    })
    module.effects.settle({
      db: database,
      token: claim.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'retry-authorized',
      applicationEvidence: 'definitely-not-applied',
      retryAuthority: 'probe',
      now: 41,
    })
    const owner = module.ownership.read(database, 'task-probe-stop-window')!
    expect(() =>
      module.ownership.releaseAfterStop({
        db: database,
        token: claim.token,
        intentId: intent.intentId,
        proof: createVerifiedStopProof({
          taskId: 'task-probe-stop-window',
          ownerRevision: owner.revision,
          epoch: claim.token.epoch,
          evidenceDigest: 'exact-runtime-stop-after-probe',
          verifiedAt: 42,
        }),
        now: 42,
      }),
    ).not.toThrow()
    expect(module.ownership.read(database, 'task-probe-stop-window')?.state).toBe('released')
    expect(
      module.effects.planCodeHostAttempt({
        db: database,
        executionLineageId: 'task-probe-stop-window',
        operationFamilyKey: family,
      }),
    ).toEqual({ operationGeneration: 0, retryAuthority: 'probe' })
  })

  test('record-before-act holds every resource and settles projection + watermark atomically', () => {
    const database = db()
    seedTask(database, 'task-effect')
    const module = createTaskExecutionTestModule('daemon-effect')
    const intent = module.intents.submit({
      db: database,
      request: continuation('task-effect'),
      intentId: 'intent-effect',
    })
    const claim = module.claim({ db: database, intentId: intent.intentId })
    module.claimGate.leave(claim.permit)
    const pathJson = canonicalJson(rootPath('task-effect'))
    const family = operationFamilyKey({
      executionLineageId: 'task-effect',
      slotPath: rootPath('task-effect'),
      effectKind: 'repository',
      stableActionOrdinal: 'publish-main',
    })
    const prepared = module.effects.prepareAndAcquire({
      db: database,
      token: claim.token,
      intentId: intent.intentId,
      operationKey: 'root:publish-main',
      executionLineageId: 'task-effect',
      operationFamilyKey: family,
      operationGeneration: 0,
      kind: 'repository',
      requestHash: requestHash({ ref: 'main' }),
      slotPathJson: pathJson,
      slotPathDigest: requestHash(pathJson),
      candidateId: 'git-push',
      recoveryClass: 'local-convergent',
      classifierVersion: 'test-v1',
      transportPolicyVersion: 'test-v1',
      retryAuthority: 'none',
      resourceKeys: ['workspace:/tmp/worktree', 'repository:origin/main'],
      now: 20,
    })
    expect(
      database
        .select({ key: taskExecutionEffectFences.fenceKey })
        .from(taskExecutionEffectFences)
        .where(eq(taskExecutionEffectFences.effectAttemptId, prepared.attemptId))
        .all()
        .map((row) => row.key)
        .sort(),
    ).toEqual(['repository:origin/main', 'workspace:/tmp/worktree'])

    module.effects.settle({
      db: database,
      token: claim.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'succeeded',
      applicationEvidence: 'applied',
      retryAuthority: 'none',
      receiptJson: '{"ok":true}',
      now: 21,
      onSettledTx: (tx) => {
        tx.update(tasks)
          .set({ errorSummary: 'projection-committed' })
          .where(eq(tasks.id, 'task-effect'))
          .run()
      },
    })
    expect(database.select({ value: tasks.errorSummary }).from(tasks).get()?.value).toBe(
      'projection-committed',
    )
    expect(
      database
        .select({ state: taskExecutionEffects.state })
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, prepared.effectId))
        .get()?.state,
    ).toBe('succeeded')
    expect(
      database
        .select({ releasedAt: taskExecutionEffectFences.releasedAt })
        .from(taskExecutionEffectFences)
        .where(eq(taskExecutionEffectFences.effectAttemptId, prepared.attemptId))
        .all()
        .every((row) => row.releasedAt === 21),
    ).toBe(true)
    expect(
      module.effects.nextOperationGeneration({
        db: database,
        executionLineageId: 'task-effect',
        operationFamilyKey: family,
      }),
    ).toBe(1)
  })

  test('resource collision has one acting winner and task-wide closure retains actor replay', () => {
    const database = db()
    seedTask(database, 'task-unknown')
    const module = createTaskExecutionTestModule('daemon-unknown')
    const intent = module.intents.submit({
      db: database,
      request: continuation('task-unknown'),
      intentId: 'intent-unknown',
    })
    const claim = module.claim({ db: database, intentId: intent.intentId })
    module.claimGate.leave(claim.permit)
    const pathJson = canonicalJson(rootPath('task-unknown'))
    const firstFamily = operationFamilyKey({
      executionLineageId: 'task-unknown',
      slotPath: rootPath('task-unknown'),
      effectKind: 'outbound-mutation',
      stableActionOrdinal: 'first',
    })
    const prepare = (ordinal: string, key: string) =>
      module.effects.prepareAndAcquire({
        db: database,
        token: claim.token,
        intentId: intent.intentId,
        operationKey: key,
        executionLineageId: 'task-unknown',
        operationFamilyKey:
          ordinal === 'first'
            ? firstFamily
            : operationFamilyKey({
                executionLineageId: 'task-unknown',
                slotPath: rootPath('task-unknown'),
                effectKind: 'outbound-mutation',
                stableActionOrdinal: ordinal,
              }),
        operationGeneration: 0,
        kind: 'outbound-mutation' as const,
        requestHash: requestHash({ ordinal }),
        slotPathJson: pathJson,
        slotPathDigest: requestHash(pathJson),
        candidateId: ordinal,
        recoveryClass: 'R-ACTOR',
        classifierVersion: 'test-v1',
        transportPolicyVersion: 'test-v1',
        retryAuthority: 'none' as const,
        resourceKeys: ['provider-object:shared'],
      })
    const winner = prepare('first', 'first')
    expect(() => prepare('second', 'second')).toThrow()
    expect(
      database
        .select({ id: taskExecutionEffectAttempts.id })
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.state, 'acting'))
        .all(),
    ).toHaveLength(1)
    module.effects.settle({
      db: database,
      token: claim.token,
      effectId: winner.effectId,
      attemptId: winner.attemptId,
      state: 'recovery-required',
      applicationEvidence: 'ambiguous',
      retryAuthority: 'none',
      failureCode: 'response-lost',
    })
    const owner = module.ownership.read(database, 'task-unknown')!
    module.effects.closeOutcomeUnknownAndRelease({
      db: database,
      token: claim.token,
      intentId: intent.intentId,
      proof: createVerifiedOutcomeUnknownClosure({
        taskId: 'task-unknown',
        ownerRevision: owner.revision,
        epoch: owner.epoch,
        quiescenceDigest: 'task-wide-runtime-and-hold-digest',
        unresolvedEffectIds: [winner.effectId],
        verifiedAt: 30,
      }),
      now: 30,
    })
    expect(module.ownership.read(database, 'task-unknown')?.state).toBe('released')
    const decision = database
      .select()
      .from(taskExecutionLineageOperationRecords)
      .where(eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'))
      .get()!
    expect(
      database
        .select({ state: taskExecutionLineageOperationRecords.decisionState })
        .from(taskExecutionLineageOperationRecords)
        .where(eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'))
        .get()?.state,
    ).toBe('requires-actor')
    expect(
      database
        .select({ id: taskExecutionEffectFences.effectAttemptId })
        .from(taskExecutionEffectFences)
        .where(isNull(taskExecutionEffectFences.releasedAt))
        .all(),
    ).toHaveLength(0)
    expect(mayAuthorizeReplay({ kind: 'retry-node', source: 'rest', actorUserId: 'actor' })).toBe(
      true,
    )
    expect(
      mayAuthorizeReplay({ kind: 'gate-continuation', source: 'internal', actorUserId: 'actor' }),
    ).toBe(false)
    expect(mayAuthorizeReplay({ kind: 'resume', source: 'auto', actorUserId: null })).toBe(false)

    // The unknown only pauses actorless auto. An allowlisted manual command
    // binds the exact decision and can really create generation N+1.
    const authorizationScopeJson = canonicalJson({
      executionLineageId: 'task-unknown',
      slotPath: rootPath('task-unknown'),
      operationGeneration: 1,
    })
    dbTxSync(database, (tx) => {
      module.intents.submitTx({
        tx,
        request: continuation('task-unknown', 'retry-node', 1),
        intentId: 'intent-unknown-manual',
        replayAuthorizationId: 'authorization-1',
        authorizationScopeJson,
        now: 31,
      })
      tx.update(taskExecutionLineageOperationRecords)
        .set({
          decisionState: 'actor-replay-authorized',
          replayAuthorizationId: 'authorization-1',
          authorizationScopeJson,
          actorUserId: 'actor-1',
          authorizationSource: 'rest',
          boundIntentId: 'intent-unknown-manual',
          recordRevision: decision.recordRevision + 1,
          updatedAt: 31,
        })
        .where(
          and(
            eq(taskExecutionLineageOperationRecords.id, decision.id),
            eq(taskExecutionLineageOperationRecords.recordRevision, decision.recordRevision),
            eq(taskExecutionLineageOperationRecords.decisionState, 'requires-actor'),
          ),
        )
        .run()
    })
    const manualClaim = module.claim({
      db: database,
      intentId: 'intent-unknown-manual',
      now: 32,
    })
    module.claimGate.leave(manualClaim.permit)
    const replay = module.effects.prepareAndAcquire({
      db: database,
      token: manualClaim.token,
      intentId: 'intent-unknown-manual',
      operationKey: 'first',
      executionLineageId: 'task-unknown',
      operationFamilyKey: firstFamily,
      operationGeneration: 1,
      kind: 'outbound-mutation',
      requestHash: requestHash({ ordinal: 'first' }),
      slotPathJson: pathJson,
      slotPathDigest: requestHash(pathJson),
      candidateId: 'manual-replay',
      recoveryClass: 'R-ACTOR',
      classifierVersion: 'test-v1',
      transportPolicyVersion: 'test-v1',
      retryAuthority: 'none',
      resourceKeys: ['provider-object:shared'],
    })
    expect(replay.attemptNo).toBe(1)
    expect(
      database
        .select({ state: taskExecutionLineageOperationRecords.decisionState })
        .from(taskExecutionLineageOperationRecords)
        .where(eq(taskExecutionLineageOperationRecords.id, decision.id))
        .get()?.state,
    ).toBe('consumed')
  })

  test('same-task agent and script effects stay parallel unless they share a real resource', () => {
    const database = db()
    seedTask(database, 'task-parallel-effects')
    const module = createTaskExecutionTestModule('daemon-parallel-effects')
    const intent = module.intents.submit({
      db: database,
      request: continuation('task-parallel-effects'),
      intentId: 'intent-parallel-effects',
    })
    const claim = module.claim({ db: database, intentId: intent.intentId })
    module.claimGate.leave(claim.permit)
    const slotPath = rootPath('task-parallel-effects')
    const slotPathJson = canonicalJson(slotPath)
    const prepare = (input: {
      ordinal: string
      candidateId: string
      resourceKeys: readonly string[]
    }) =>
      module.effects.prepareAndAcquire({
        db: database,
        token: claim.token,
        intentId: intent.intentId,
        operationKey: `root:${input.ordinal}`,
        executionLineageId: 'task-parallel-effects',
        operationFamilyKey: operationFamilyKey({
          executionLineageId: 'task-parallel-effects',
          slotPath,
          effectKind: 'process',
          stableActionOrdinal: input.ordinal,
        }),
        operationGeneration: 0,
        kind: 'process' as const,
        requestHash: requestHash({ candidateId: input.candidateId }),
        slotPathJson,
        slotPathDigest: requestHash(slotPathJson),
        candidateId: input.candidateId,
        recoveryClass: 'process-exact-identity',
        classifierVersion: 'test-v1',
        transportPolicyVersion: 'test-v1',
        retryAuthority: 'none' as const,
        resourceKeys: input.resourceKeys,
      })

    prepare({
      ordinal: 'agent-node-a',
      candidateId: 'agent',
      resourceKeys: [
        'process:task-parallel-effects:node-a:attempt-1',
        'workspace:/tmp/worktree/iso-node-a',
      ],
    })
    prepare({
      ordinal: 'script-node-b',
      candidateId: 'script',
      resourceKeys: [
        'process:task-parallel-effects:node-b:attempt-1',
        'workspace:/tmp/worktree/iso-node-b',
      ],
    })
    expect(
      database
        .select({ id: taskExecutionEffectAttempts.id })
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.state, 'acting'))
        .all(),
    ).toHaveLength(2)

    prepare({
      ordinal: 'merge-node-c',
      candidateId: 'merge-c',
      resourceKeys: [
        'process:task-parallel-effects:node-c:attempt-1',
        'workspace:/tmp/worktree/shared-merge-root',
      ],
    })
    expect(() =>
      prepare({
        ordinal: 'merge-node-d',
        candidateId: 'merge-d',
        resourceKeys: [
          'process:task-parallel-effects:node-d:attempt-1',
          'workspace:/tmp/worktree/shared-merge-root',
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'task-execution-resource-conflict' }))
  })
})

describe('RFC-328 successor-daemon effect recovery', () => {
  test('the orphan barrier preserves auto-resume for known process launches and non-launches', async () => {
    const database = db()
    const oldModule = createTaskExecutionTestModule('daemon-before-restart')
    const processEffects = new Map<string, { effectId: string; attemptId: string }>()

    for (const input of [
      { taskId: 'task-process-activated', receipt: true },
      { taskId: 'task-process-not-activated', receipt: false },
    ]) {
      seedTask(database, input.taskId)
      const nodeRunId = `${input.taskId}-run`
      database
        .insert(nodeRuns)
        .values({
          id: nodeRunId,
          taskId: input.taskId,
          nodeId: 'agent-node',
          iteration: 0,
          retryIndex: 0,
          status: 'running',
          startedAt: 100,
          pid: input.receipt ? 42 : null,
          spawnBinaryPath: input.receipt ? '/opt/opencode' : null,
          spawnLaunchNonce: input.receipt ? `${input.taskId}-nonce` : null,
        })
        .run()
      const intent = oldModule.intents.submit({
        db: database,
        request: continuation(input.taskId),
        intentId: `${input.taskId}-intent`,
      })
      const claim = oldModule.claim({ db: database, intentId: intent.intentId })
      oldModule.claimGate.leave(claim.permit)
      const pathJson = canonicalJson(rootPath(input.taskId))
      const effect = oldModule.effects.prepareAndAcquire({
        db: database,
        token: claim.token,
        intentId: intent.intentId,
        operationKey: `${input.taskId}:process:agent`,
        executionLineageId: input.taskId,
        operationFamilyKey: operationFamilyKey({
          executionLineageId: input.taskId,
          slotPath: rootPath(input.taskId),
          effectKind: 'process',
          stableActionOrdinal: 'managed-agent',
        }),
        operationGeneration: 0,
        kind: 'process',
        requestHash: requestHash({ argv: ['/opt/opencode'], cwd: '/tmp/worktree' }),
        slotPathJson: pathJson,
        slotPathDigest: requestHash(pathJson),
        candidateId: `agent:${nodeRunId}`,
        recoveryClass: 'managed-process-preactivation',
        classifierVersion: 'rfc328-managed-process-v1',
        transportPolicyVersion: 'rfc328-preactivation-v1',
        retryAuthority: 'none',
        resourceKeys: [`process:${input.taskId}:${nodeRunId}`],
      })
      if (input.receipt) {
        database
          .update(taskExecutionEffectAttempts)
          .set({
            receiptJson: JSON.stringify({
              v: 1,
              phase: 'spawn-receipt',
              pid: 42,
              spawnBinaryPath: '/opt/opencode',
              launchNonce: `${input.taskId}-nonce`,
            }),
          })
          .where(eq(taskExecutionEffectAttempts.id, effect.attemptId))
          .run()
      }
      processEffects.set(input.taskId, effect)
    }

    // A genuinely ambiguous remote act remains actor-governed. It must not
    // change the two independently recoverable process tasks above.
    seedTask(database, 'task-remote-unknown')
    const remoteIntent = oldModule.intents.submit({
      db: database,
      request: continuation('task-remote-unknown'),
      intentId: 'task-remote-unknown-intent',
    })
    const remoteClaim = oldModule.claim({ db: database, intentId: remoteIntent.intentId })
    oldModule.claimGate.leave(remoteClaim.permit)
    const remotePathJson = canonicalJson(rootPath('task-remote-unknown'))
    const remoteEffect = oldModule.effects.prepareAndAcquire({
      db: database,
      token: remoteClaim.token,
      intentId: remoteIntent.intentId,
      operationKey: 'task-remote-unknown:mr.approve',
      executionLineageId: 'task-remote-unknown',
      operationFamilyKey: operationFamilyKey({
        executionLineageId: 'task-remote-unknown',
        slotPath: rootPath('task-remote-unknown'),
        effectKind: 'code-host-mutation',
        stableActionOrdinal: 'mr.approve',
      }),
      operationGeneration: 0,
      kind: 'code-host-mutation',
      requestHash: requestHash({ action: 'mr.approve' }),
      slotPathJson: remotePathJson,
      slotPathDigest: requestHash(remotePathJson),
      candidateId: 'mr.approve:github:c0:t1',
      recoveryClass: 'R-ACTOR',
      classifierVersion: 'rfc328-codehost-matrix-v1',
      transportPolicyVersion: 'rfc328-codehost-transport-v1',
      retryAuthority: 'none',
      resourceKeys: ['provider-object:github:owner/repo:mr:1'],
    })

    const lockProof = createExclusiveDaemonLockProof({
      daemonGeneration: 'daemon-after-restart',
      acquiredAt: 200,
      lockReceiptDigest: 'exclusive-daemon-lock-receipt',
    })
    expect(
      [
        ...prepareTaskExecutionRecovery({ db: database, lockProof, now: 201 }).revokedTaskIds,
      ].sort(),
    ).toEqual(['task-process-activated', 'task-process-not-activated', 'task-remote-unknown'])
    database.update(tasks).set({ status: 'interrupted' }).run()
    database.update(nodeRuns).set({ status: 'interrupted', finishedAt: 202 }).run()

    const finalized = await finalizeTaskExecutionRecovery({
      db: database,
      lockProof,
      processEvidence: {
        orphanReaperCompleted: true,
        orphanTasks: 3,
        orphanRuns: 2,
        repairedRuntimeLeases: 0,
      },
      now: 203,
    })
    expect([...finalized.releasedTaskIds].sort()).toEqual([
      'task-process-activated',
      'task-process-not-activated',
    ])
    expect(finalized.outcomeUnknownTaskIds).toEqual(['task-remote-unknown'])
    expect([...finalized.recoveredProcessEffectIds].sort()).toEqual(
      [...processEffects.values()].map((effect) => effect.effectId).sort(),
    )
    expect(
      database
        .select({ state: taskExecutionEffects.state })
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, processEffects.get('task-process-activated')!.effectId))
        .get()?.state,
    ).toBe('succeeded')
    expect(
      database
        .select({ state: taskExecutionEffects.state })
        .from(taskExecutionEffects)
        .where(
          eq(taskExecutionEffects.id, processEffects.get('task-process-not-activated')!.effectId),
        )
        .get()?.state,
    ).toBe('failed')
    expect(
      database
        .select({ state: taskExecutionEffects.state })
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, remoteEffect.effectId))
        .get()?.state,
    ).toBe('outcome-unknown')
    expect(
      database
        .select({ id: taskExecutionEffectFences.effectAttemptId })
        .from(taskExecutionEffectFences)
        .where(isNull(taskExecutionEffectFences.releasedAt))
        .all(),
    ).toHaveLength(0)
  })

  test('boot probes adopt known code-host success and preserve a same-generation retry', async () => {
    const database = db()
    const oldModule = createTaskExecutionTestModule('daemon-codehost-before-restart')
    const effects = new Map<
      string,
      { effectId: string; attemptId: string; family: string; request: string }
    >()
    for (const spec of [
      {
        taskId: 'task-codehost-recovered-applied',
        action: 'pipeline.cancel' as const,
        candidateId: 'pipeline.cancel:c0',
        recoveryClass: 'R-STATE',
        method: 'POST',
        pathname: '/projects/group%2Frepo/pipelines/31/cancel',
      },
      {
        taskId: 'task-codehost-recovered-retry',
        action: 'review.draft-discard' as const,
        candidateId: 'review.draft-discard:c0',
        recoveryClass: 'R-PARTIAL',
        method: 'DELETE',
        pathname: '/projects/group%2Frepo/merge_requests/9/draft_notes/73',
      },
    ]) {
      seedTask(database, spec.taskId)
      database.update(tasks).set({ status: 'running' }).where(eq(tasks.id, spec.taskId)).run()
      const nodeRunId = `${spec.taskId}-run`
      database
        .insert(nodeRuns)
        .values({
          id: nodeRunId,
          taskId: spec.taskId,
          nodeId: 'code-host-node',
          iteration: 0,
          retryIndex: 0,
          status: 'running',
          startedAt: 100,
        })
        .run()
      const intent = oldModule.intents.submit({
        db: database,
        request: continuation(spec.taskId),
        intentId: `${spec.taskId}-intent`,
      })
      const claim = oldModule.claim({ db: database, intentId: intent.intentId })
      oldModule.claimGate.leave(claim.permit)
      const pathJson = canonicalJson(rootPath(spec.taskId))
      const family = operationFamilyKey({
        executionLineageId: spec.taskId,
        slotPath: rootPath(spec.taskId),
        effectKind: 'code-host-mutation',
        stableActionOrdinal: spec.action,
      })
      const request = requestHash({ provider: 'gitlab', action: spec.action })
      const effect = oldModule.effects.prepareAndAcquire({
        db: database,
        token: claim.token,
        intentId: intent.intentId,
        operationKey: `${spec.taskId}:${spec.action}`,
        executionLineageId: spec.taskId,
        operationFamilyKey: family,
        operationGeneration: 0,
        kind: 'code-host-mutation',
        requestHash: request,
        slotPathJson: pathJson,
        slotPathDigest: requestHash(pathJson),
        candidateId: `${spec.candidateId}:t1`,
        recoveryClass: spec.recoveryClass,
        recoveryDescriptorJson: JSON.stringify(
          buildCodeHostRecoveryDescriptor(
            {
              provider: 'gitlab',
              action: spec.action,
              candidateId: spec.candidateId,
              method: spec.method,
              pathname: spec.pathname,
              query: {},
              baseUrl: 'https://gitlab.example/api/v4',
              connectionGeneration: 'connection-generation-1',
            },
            nodeRunId,
          ),
        ),
        classifierVersion: 'rfc328-codehost-matrix-v1',
        transportPolicyVersion: 'rfc328-codehost-transport-v1',
        retryAuthority: 'none',
        resourceKeys: [`code-host:gitlab:${spec.taskId}`],
      })
      effects.set(spec.taskId, { ...effect, family, request })
    }

    const lockProof = createExclusiveDaemonLockProof({
      daemonGeneration: 'daemon-codehost-after-restart',
      acquiredAt: 200,
      lockReceiptDigest: 'exclusive-codehost-recovery-lock',
    })
    expect(
      [
        ...prepareTaskExecutionRecovery({ db: database, lockProof, now: 201 }).revokedTaskIds,
      ].sort(),
    ).toEqual(['task-codehost-recovered-applied', 'task-codehost-recovered-retry'])
    database.update(tasks).set({ status: 'interrupted' }).run()
    database.update(nodeRuns).set({ status: 'interrupted', finishedAt: 202 }).run()

    const finalized = await finalizeTaskExecutionRecovery({
      db: database,
      lockProof,
      processEvidence: { orphanReaperCompleted: true },
      async codeHostProbe(descriptor) {
        return descriptor.action === 'pipeline.cancel'
          ? {
              kind: 'applied',
              proofCode: 'pipeline-canceled',
              responseStatus: 200,
              responseBody: '{"status":"canceled"}',
            }
          : {
              kind: 'definitely-not-applied',
              proofCode: 'exact-draft-still-exists',
              responseStatus: 200,
              responseBody: '{"id":73}',
            }
      },
      now: 203,
    })
    expect([...finalized.releasedTaskIds].sort()).toEqual([
      'task-codehost-recovered-applied',
      'task-codehost-recovered-retry',
    ])
    expect(finalized.outcomeUnknownTaskIds).toEqual([])
    expect(finalized.recoveredCodeHostEffectIds).toEqual([
      effects.get('task-codehost-recovered-applied')!.effectId,
    ])
    expect(finalized.retryAuthorizedCodeHostEffectIds).toEqual([
      effects.get('task-codehost-recovered-retry')!.effectId,
    ])
    expect(
      database
        .select({ state: taskExecutionEffects.state })
        .from(taskExecutionEffects)
        .where(
          eq(taskExecutionEffects.id, effects.get('task-codehost-recovered-applied')!.effectId),
        )
        .get()?.state,
    ).toBe('succeeded')
    expect(
      database
        .select({ status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, 'task-codehost-recovered-applied-run'))
        .get()?.status,
    ).toBe('done')
    expect(
      database
        .select({ port: nodeRunOutputs.portName, content: nodeRunOutputs.content })
        .from(nodeRunOutputs)
        .where(eq(nodeRunOutputs.nodeRunId, 'task-codehost-recovered-applied-run'))
        .all()
        .sort((left, right) => left.port.localeCompare(right.port)),
    ).toEqual([
      { port: 'response', content: '{"status":"canceled"}' },
      { port: 'status', content: '200' },
    ])
    expect(
      database
        .select({ state: taskExecutionEffectAttempts.state })
        .from(taskExecutionEffectAttempts)
        .where(
          eq(
            taskExecutionEffectAttempts.id,
            effects.get('task-codehost-recovered-retry')!.attemptId,
          ),
        )
        .get()?.state,
    ).toBe('retry-authorized')
    expect(
      oldModule.effects.planCodeHostAttempt({
        db: database,
        executionLineageId: 'task-codehost-recovered-retry',
        operationFamilyKey: effects.get('task-codehost-recovered-retry')!.family,
      }),
    ).toEqual({ operationGeneration: 0, retryAuthority: 'probe' })
  })
})

describe('RFC-328 retained aggregation and terminal maintenance', () => {
  test('later success preserves capability while later failure cannot erase ambiguity', () => {
    expect(
      aggregateEffectOutcome([
        { attemptNo: 1, state: 'retry-authorized', applicationEvidence: 'ambiguous' },
        { attemptNo: 2, state: 'succeeded', applicationEvidence: 'applied' },
      ]),
    ).toEqual({ state: 'succeeded', priorAmbiguityCount: 1, appliedAttemptNo: 2 })
    expect(
      aggregateEffectOutcome([
        { attemptNo: 1, state: 'retry-authorized', applicationEvidence: 'ambiguous' },
        {
          attemptNo: 2,
          state: 'failed-not-applied',
          applicationEvidence: 'definitely-not-applied',
        },
      ]),
    ).toEqual({ state: 'outcome-unknown', priorAmbiguityCount: 1, appliedAttemptNo: null })
    expect(canonicalResourceKeySet(['process:b', 'process:a'])).toEqual(['process:a', 'process:b'])
  })

  test('maintenance claim precedes IO and blocks new continuation admission', () => {
    const database = db()
    seedTask(database, 'task-maintenance', 'done')
    const module = createTaskExecutionTestModule('daemon-maintenance')
    const members = module.terminalMaintenance.snapshotTree(database, 'task-maintenance')
    let claim = module.terminalMaintenance.claim({
      db: database,
      rootTaskId: 'task-maintenance',
      operation: 'delete',
      members,
      cleanupPlanJson: '{"v":1,"directories":[]}',
      now: 40,
    })
    expect(() =>
      module.intents.submit({
        db: database,
        request: continuation('task-maintenance', 'resume', 1),
        intentId: 'maintenance-race-intent',
      }),
    ).toThrow(expect.objectContaining({ code: 'task-terminal-maintenance-conflict' }))
    claim = module.terminalMaintenance.transition({
      db: database,
      claim,
      to: 'io-complete',
      now: 41,
    })
    claim = module.terminalMaintenance.transition({
      db: database,
      claim,
      to: 'db-finalized',
      now: 42,
    })
    module.terminalMaintenance.transition({
      db: database,
      claim,
      to: 'completed',
      releaseMembers: true,
      now: 43,
    })
    expect(
      database
        .select({ releasedAt: taskExecutionMaintenanceMembers.releasedAt })
        .from(taskExecutionMaintenanceMembers)
        .where(
          and(
            eq(taskExecutionMaintenanceMembers.taskId, 'task-maintenance'),
            isNull(taskExecutionMaintenanceMembers.releasedAt),
          ),
        )
        .all(),
    ).toHaveLength(0)
    expect(database.select().from(taskExecutionOwners).all()).toHaveLength(0)
    expect(database.select().from(taskExecutionIntents).all()).toHaveLength(0)
  })

  test('boot recovery resumes the exact delete claim after the IO/DB barrier', async () => {
    const database = db()
    seedTask(database, 'task-delete-recovery', 'done')
    const module = createTaskExecutionTestModule('daemon-delete-recovery')
    const members = module.terminalMaintenance.snapshotTree(database, 'task-delete-recovery')
    let claim = module.terminalMaintenance.claim({
      db: database,
      rootTaskId: 'task-delete-recovery',
      operation: 'delete',
      members,
      cleanupPlanJson: JSON.stringify({
        v: 2,
        taskId: 'task-delete-recovery',
        parentTaskId: null,
        worktrees: [],
        directories: [],
      }),
      now: 50,
    })
    claim = module.terminalMaintenance.transition({
      db: database,
      claim,
      to: 'io-complete',
      now: 51,
    })

    expect(await recoverInterruptedTaskDeletes(database)).toEqual({
      completed: ['task-delete-recovery'],
      cleanupPending: [],
      recoveryRequired: [],
    })
    expect(database.select().from(tasks).all()).toHaveLength(0)
    expect(
      database
        .select({ state: taskExecutionMaintenanceClaims.state })
        .from(taskExecutionMaintenanceClaims)
        .where(eq(taskExecutionMaintenanceClaims.id, claim.claimId))
        .get()?.state,
    ).toBe('completed')
  })

  test('archive exports all six execution ledgers plus the exact claim manifest', async () => {
    const database = db()
    seedTask(database, 'task-archive-ledger')
    const module = createTaskExecutionTestModule('daemon-archive-ledger')
    const intent = module.intents.submit({
      db: database,
      request: continuation('task-archive-ledger'),
      intentId: 'intent-archive-ledger',
    })
    const owned = module.claim({ db: database, intentId: intent.intentId, now: 60 })
    module.claimGate.leave(owned.permit)
    const pathJson = canonicalJson(rootPath('task-archive-ledger'))
    const family = operationFamilyKey({
      executionLineageId: 'task-archive-ledger',
      slotPath: rootPath('task-archive-ledger'),
      effectKind: 'repository',
      stableActionOrdinal: 'archive-fixture',
    })
    const effect = module.effects.prepareAndAcquire({
      db: database,
      token: owned.token,
      intentId: intent.intentId,
      operationKey: 'root:archive-fixture',
      executionLineageId: 'task-archive-ledger',
      operationFamilyKey: family,
      operationGeneration: 0,
      kind: 'repository',
      requestHash: requestHash({ operation: 'archive-fixture' }),
      slotPathJson: pathJson,
      slotPathDigest: requestHash(pathJson),
      candidateId: 'archive-fixture',
      recoveryClass: 'local-convergent',
      classifierVersion: 'test-v1',
      transportPolicyVersion: 'test-v1',
      retryAuthority: 'none',
      resourceKeys: ['repository:archive-fixture'],
      now: 61,
    })
    module.effects.settle({
      db: database,
      token: owned.token,
      effectId: effect.effectId,
      attemptId: effect.attemptId,
      state: 'succeeded',
      applicationEvidence: 'applied',
      retryAuthority: 'none',
      receiptJson: '{"ok":true}',
      now: 62,
      onSettledTx: (tx) => {
        tx.update(tasks)
          .set({ status: 'done', finishedAt: 62 })
          .where(eq(tasks.id, 'task-archive-ledger'))
          .run()
      },
    })
    const owner = module.ownership.read(database, 'task-archive-ledger')!
    module.ownership.releaseAfterStop({
      db: database,
      token: owned.token,
      intentId: intent.intentId,
      proof: createVerifiedStopProof({
        taskId: 'task-archive-ledger',
        ownerRevision: owner.revision,
        epoch: owned.token.epoch,
        evidenceDigest: 'archive-fixture-reaped',
        verifiedAt: 63,
      }),
      now: 63,
    })

    const root = mkdtempSync(join(tmpdir(), 'aw-rfc328-archive-'))
    const dirs = {
      archiveDir: join(root, 'archive'),
      runsDir: join(root, 'runs'),
      logsDir: join(root, 'logs'),
    }
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
    try {
      const archived = await archiveTaskTree(database, 'task-archive-ledger', dirs)
      const expectedRows: Record<string, number> = {
        task_execution_owners: 1,
        task_execution_intents: 1,
        task_execution_effects: 1,
        task_execution_effect_attempts: 1,
        task_execution_effect_fences: 1,
        task_execution_lineage_operation_records: 1,
      }
      for (const [name, count] of Object.entries(expectedRows)) {
        expect(archived.rows[name]).toBe(count)
        expect(
          readFileSync(join(archived.dir, 'db', `${name}.jsonl`), 'utf-8')
            .trim()
            .split('\n'),
        ).toHaveLength(count)
      }
      const manifest = JSON.parse(readFileSync(join(archived.dir, 'manifest.json'), 'utf-8')) as {
        terminalMaintenance: { claim: { id: string }; members: Array<{ taskId: string }> }
      }
      expect(manifest.terminalMaintenance.claim.id).not.toBe('')
      expect(manifest.terminalMaintenance.members).toEqual([
        expect.objectContaining({ taskId: 'task-archive-ledger' }),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
