// RFC-370 C2-W2-E: original effect SQL uses new preparation or issued receipt.
// These cases exercise real selected Task claims and both database providers.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunOutputs,
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionLineageOperationRecords,
  taskExecutionOwners,
  taskRepos,
  taskSpaceNodes,
  tasks,
  workflows,
} from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import type {
  TaskEffectAttemptPreparation,
  TaskEffectAttemptSettlement,
} from '@/modules/task-execution/application/ports/taskExecutionEffectStore'
import { sha256Hex } from '@/modules/task-execution/domain/digest'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import {
  canonicalJson,
  encodeLineageSlotPath,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import { describeEachProvider } from './helpers/eachProvider'
import { seedTaskHostIntent, taskHostFixture } from './helpers/taskHostExecution'

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

async function effectFixture(
  db: ProviderNeutralDatabase,
  tag: string,
  options: Parameters<typeof taskHostFixture>[2] = {},
) {
  const h = await taskHostFixture(db, `effect-${tag}-${ulid()}`, options)
  const claimed = await h.claim()
  h.module.claimGate.leave(claimed.permit)
  const runId = `run-${h.taskId}`
  const prepRunId = `prep-${h.taskId}`
  const slotPathJson = encodeLineageSlotPath(rootPath(h.taskId))
  await db.insert(nodeRuns).values([
    {
      id: runId,
      taskId: h.taskId,
      nodeId: 'worker',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      continuationSlotKey: `${h.taskId}:root:0`,
      lineageSlotPathJson: slotPathJson,
    },
    {
      id: prepRunId,
      taskId: h.taskId,
      nodeId: 'repo-prep',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      continuationSlotKey: `${h.taskId}:root:0`,
      lineageSlotPathJson: slotPathJson,
    },
  ])
  return {
    h,
    taskId: h.taskId,
    intentId: h.intentId,
    token: claimed.token,
    effects: h.persistence.effects,
    runId,
    prepRunId,
    slotPathJson,
    familyKey: operationFamilyKey({
      executionLineageId: h.taskId,
      slotPath: rootPath(h.taskId),
      effectKind: 'repository',
      stableActionOrdinal: 'host-effect-write',
    }),
  }
}

type Fixture = Awaited<ReturnType<typeof effectFixture>>
type PreparationFacts = Pick<
  Fixture,
  'taskId' | 'intentId' | 'token' | 'slotPathJson' | 'familyKey'
>

function preparation(
  fixture: PreparationFacts,
  overrides: Partial<TaskEffectAttemptPreparation> = {},
): TaskEffectAttemptPreparation {
  return {
    token: fixture.token,
    intentId: fixture.intentId,
    operationKey: `${fixture.taskId}:root:repository:host-effect-write`,
    executionLineageId: fixture.taskId,
    operationFamilyKey: fixture.familyKey,
    operationGeneration: 0,
    kind: 'repository',
    requestHash: requestHash({ v: 1, probe: 'host-effect-write' }),
    slotPathJson: fixture.slotPathJson,
    slotPathDigest: sha256Hex(fixture.slotPathJson),
    candidateId: 'host-effect-candidate',
    recoveryClass: 'local-probe-or-actor',
    classifierVersion: 'rfc328-local-effect-v1',
    transportPolicyVersion: 'rfc328-local-effect-direct-v1',
    retryAuthority: 'none',
    resourceKeys: [`host-effect:${fixture.taskId}`],
    ...overrides,
  }
}

function settlement(
  fixture: PreparationFacts,
  prepared: { readonly effectId: string; readonly attemptId: string },
  overrides: Partial<TaskEffectAttemptSettlement> = {},
): TaskEffectAttemptSettlement {
  return {
    token: fixture.token,
    effectId: prepared.effectId,
    attemptId: prepared.attemptId,
    state: 'succeeded',
    applicationEvidence: 'applied',
    retryAuthority: 'none',
    receiptJson: JSON.stringify({ v: 1, result: 'actual-issued-result' }),
    ...overrides,
  }
}

async function effectRows(db: ProviderNeutralDatabase, taskId: string) {
  return {
    owners: await db
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, taskId))
      .orderBy(taskExecutionOwners.taskId),
    effects: await db
      .select()
      .from(taskExecutionEffects)
      .where(eq(taskExecutionEffects.taskId, taskId))
      .orderBy(taskExecutionEffects.id),
    attempts: (
      await db
        .select({ attempt: taskExecutionEffectAttempts })
        .from(taskExecutionEffectAttempts)
        .innerJoin(
          taskExecutionEffects,
          eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
        )
        .where(eq(taskExecutionEffects.taskId, taskId))
        .orderBy(taskExecutionEffectAttempts.id)
    ).map(({ attempt }) => attempt),
    fences: (
      await db
        .select({ fence: taskExecutionEffectFences })
        .from(taskExecutionEffectFences)
        .innerJoin(
          taskExecutionEffectAttempts,
          eq(taskExecutionEffectAttempts.id, taskExecutionEffectFences.effectAttemptId),
        )
        .innerJoin(
          taskExecutionEffects,
          eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
        )
        .where(eq(taskExecutionEffects.taskId, taskId))
        .orderBy(taskExecutionEffectFences.effectAttemptId, taskExecutionEffectFences.fenceKey)
    ).map(({ fence }) => fence),
    operationRecords: await db
      .select()
      .from(taskExecutionLineageOperationRecords)
      .where(eq(taskExecutionLineageOperationRecords.executionLineageId, taskId))
      .orderBy(taskExecutionLineageOperationRecords.id),
  }
}

async function drain(fixture: Fixture) {
  fixture.h.lose()
  await fixture.h.selected.context.drain(fixture.h.receipt)
}

function originalWorkStillOpen(fixture: Fixture) {
  expect(fixture.h.events).toEqual(['admission'])
  expect(fixture.h.leases).toHaveLength(1)
  expect(fixture.h.completed).toBe(0)
}

describeEachProvider('RFC-370 real Task effect preparation and issued receipt', (harness) => {
  test('prepare returns the original attempt identity and resource set without completing work', async () => {
    const f = await effectFixture(harness.db, 'prepare')
    try {
      const prepared = await f.effects.prepareAndAcquire(preparation(f))
      expect(Reflect.ownKeys(prepared)).toEqual([
        'effectId',
        'attemptId',
        'attemptNo',
        'resourceKeys',
      ])
      expect(prepared.attemptNo).toBe(1)
      expect(prepared.resourceKeys).toEqual([`host-effect:${f.taskId}`])
      const rows = await effectRows(harness.db, f.taskId)
      expect(rows.effects).toHaveLength(1)
      expect(rows.effects[0]?.id).toBe(prepared.effectId)
      expect(rows.effects[0]?.operationGeneration).toBe(0)
      expect(rows.effects[0]?.requestHash).toBe(preparation(f).requestHash)
      expect(rows.attempts).toHaveLength(1)
      expect(rows.attempts[0]?.id).toBe(prepared.attemptId)
      expect(rows.attempts[0]?.state).toBe('acting')
      expect(rows.fences).toHaveLength(1)
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('loss after the original prepare body rolls back every ledger and owner revision', async () => {
    let revoke = () => {}
    const f = await effectFixture(harness.db, 'prepare-loss', {
      beforeNewWork: () => revoke(),
    })
    try {
      const before = await effectRows(harness.db, f.taskId)
      revoke = () => f.h.lose()
      const recording = harness.recordStatements()
      try {
        await expect(f.effects.prepareAndAcquire(preparation(f))).rejects.toThrow(
          'host-execution-write-context-unavailable',
        )
        expect(
          recording.statements.some(({ sql }) =>
            /insert into (?:(?:"agent_workflow"|agent_workflow)\.)?["`]?task_execution_effects["`]?\b/i.test(
              sql,
            ),
          ),
        ).toBe(true)
        expect(
          recording.statements.some(({ sql }) =>
            /insert into (?:(?:"agent_workflow"|agent_workflow)\.)?["`]?task_execution_effect_attempts["`]?\b/i.test(
              sql,
            ),
          ),
        ).toBe(true)
        expect(recording.statements.some(({ sql }) => /rollback/i.test(sql))).toBe(true)
      } finally {
        recording.stop()
      }
      expect(await effectRows(harness.db, f.taskId)).toEqual(before)
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('settle acknowledges the original attempt while draining', async () => {
    const f = await effectFixture(harness.db, 'settle')
    try {
      const prepared = await f.effects.prepareAndAcquire(preparation(f))
      await drain(f)
      await f.effects.settle(settlement(f, prepared))
      const rows = await effectRows(harness.db, f.taskId)
      expect(rows.attempts[0]?.state).toBe('succeeded')
      expect(rows.attempts[0]?.receiptJson).toBe(settlement(f, prepared).receiptJson)
      expect(rows.effects[0]?.state).toBe('succeeded')
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('settleGateRollback acknowledges completed rollback and the original source projection', async () => {
    const f = await effectFixture(harness.db, 'gate-completed')
    try {
      await harness.db
        .update(nodeRuns)
        .set({ status: 'failed', errorMessage: 'superseded-by-review-rejected: earlier' })
        .where(eq(nodeRuns.id, f.runId))
      const prepared = await f.effects.prepareAndAcquire(
        preparation(f, { kind: 'workspace-rollback' }),
      )
      await drain(f)
      await f.effects.settleGateRollback({
        token: f.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        operationId: 'host-gate-op',
        planDigest: 'host-gate-digest',
        sourceNodeRunIds: [f.runId],
        outcome: {
          kind: 'completed',
          rolledBack: true,
          applicationEvidence: 'applied',
          receipt: { restored: 1 },
          successfulSourceNodeRunIds: [f.runId],
        },
      })
      const run = (await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.runId)))[0]!
      expect(run.rolledBack).toBe(true)
      expect(run.errorMessage).toBe('superseded-by-review-rejected-rollback: earlier')
      expect((await effectRows(harness.db, f.taskId)).effects[0]?.state).toBe('succeeded')
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('settleGateRollback acknowledges a thrown result without changing source facts', async () => {
    const f = await effectFixture(harness.db, 'gate-threw')
    try {
      const prepared = await f.effects.prepareAndAcquire(
        preparation(f, { kind: 'workspace-rollback' }),
      )
      const before = await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.runId))
      await drain(f)
      await f.effects.settleGateRollback({
        token: f.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        operationId: 'host-gate-threw',
        planDigest: 'host-gate-digest',
        sourceNodeRunIds: [f.runId],
        outcome: { kind: 'threw', error: 'actual-rollback-error' },
      })
      const rows = await effectRows(harness.db, f.taskId)
      expect(rows.attempts[0]?.state).toBe('recovery-required')
      expect(rows.attempts[0]?.failureCode).toBe('human-gate-workspace-rollback-threw')
      expect(await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.runId))).toEqual(
        before,
      )
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('settleCodeHostNode acknowledges the original output and node transition', async () => {
    const f = await effectFixture(harness.db, 'code-host')
    try {
      const prepared = await f.effects.prepareAndAcquire(preparation(f))
      const finishedAt = Date.now()
      await drain(f)
      await f.effects.settleCodeHostNode({
        settlement: settlement(f, prepared),
        projection: {
          nodeRunId: f.runId,
          status: 'done',
          reason: 'host-code-host-result',
          finishedAt,
          outputs: [{ portName: 'pr_url', content: 'https://example.invalid/pr/12' }],
        },
      })
      const run = (await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.runId)))[0]!
      expect(run.status).toBe('done')
      expect(run.finishedAt).toBe(finishedAt)
      const outputs = await harness.db
        .select()
        .from(nodeRunOutputs)
        .where(eq(nodeRunOutputs.nodeRunId, f.runId))
      expect(outputs.map(({ portName, content }) => [portName, content])).toEqual([
        ['pr_url', 'https://example.invalid/pr/12'],
      ])
      expect((await effectRows(harness.db, f.taskId)).effects[0]?.state).toBe('succeeded')
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('settleWorkspacePreparation acknowledges original Task, repos, spaces and prep node facts', async () => {
    const f = await effectFixture(harness.db, 'workspace')
    try {
      const prepared = await f.effects.prepareAndAcquire(preparation(f))
      const finishedAt = Date.now()
      const worktreePath = `/tmp/wt/${f.taskId}`
      await drain(f)
      await f.effects.settleWorkspacePreparation({
        settlement: settlement(f, prepared),
        projection: {
          taskId: f.taskId,
          prepNodeRunId: f.prepRunId,
          finishedAt,
          task: {
            worktreePath,
            branch: `agent-workflow/${f.taskId}`,
            baseCommit: 'deadbeef',
            repoPath: '/tmp/repo/effect',
            repoUrl: null,
            cachedRepoId: null,
            baseBranch: 'main',
            repoCount: 1,
          },
          repositories: [
            {
              taskId: f.taskId,
              repoIndex: 0,
              repoPath: '/tmp/repo/effect',
              repoUrl: null,
              cachedRepoId: null,
              baseBranch: 'main',
              branch: `agent-workflow/${f.taskId}`,
              workingBranch: null,
              baseCommit: 'deadbeef',
              worktreePath,
              worktreeDirName: f.taskId,
              mountPath: '',
              subdir: '',
              readonly: false,
              readonlyDirtyCount: null,
              workspaceProfileVersion: null,
              workspaceProfileDigest: null,
              hasSubmodules: false,
              submoduleInitOk: true,
              submoduleInitError: null,
              schemaVersion: 1,
            },
          ],
          nodePaths: ['host-effect-node'],
        },
      })
      const task = (await harness.db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]!
      expect(task.worktreePath).toBe(worktreePath)
      expect(task.baseCommit).toBe('deadbeef')
      const repos = await harness.db.select().from(taskRepos).where(eq(taskRepos.taskId, f.taskId))
      expect(repos).toHaveLength(1)
      expect(repos[0]?.worktreeDirName).toBe(f.taskId)
      const spaces = await harness.db
        .select()
        .from(taskSpaceNodes)
        .where(eq(taskSpaceNodes.taskId, f.taskId))
      expect(spaces.map(({ nodePath }) => nodePath)).toEqual(['host-effect-node'])
      const prep = (
        await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.prepRunId))
      )[0]!
      expect(prep.status).toBe('done')
      expect(prep.finishedAt).toBe(finishedAt)
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('recordProcessSpawn acknowledges the original PID, binary, nonce and runtime params', async () => {
    const f = await effectFixture(harness.db, 'spawn')
    try {
      const prepared = await f.effects.prepareAndAcquire(preparation(f))
      await drain(f)
      await f.effects.recordProcessSpawn({
        token: f.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        nodeRunId: f.runId,
        pid: 4242,
        spawnBinaryPath: '/usr/local/bin/opencode',
        launchNonce: 'host-effect-nonce',
        runtimeParamsJson: JSON.stringify({ model: 'host-effect' }),
      })
      const rows = await effectRows(harness.db, f.taskId)
      expect(rows.attempts[0]?.state).toBe('acting')
      expect(JSON.parse(rows.attempts[0]!.receiptJson!)).toEqual({
        v: 1,
        phase: 'spawn-receipt',
        pid: 4242,
        spawnBinaryPath: '/usr/local/bin/opencode',
        launchNonce: 'host-effect-nonce',
      })
      const run = (await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.runId)))[0]!
      expect(run.pid).toBe(4242)
      expect(run.spawnBinaryPath).toBe('/usr/local/bin/opencode')
      expect(run.spawnLaunchNonce).toBe('host-effect-nonce')
      expect(run.runtimeParamsJson).toBe(JSON.stringify({ model: 'host-effect' }))
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('an acknowledged retry authority does not permit a new attempt after loss', async () => {
    const f = await effectFixture(harness.db, 'retry')
    try {
      const prepared = await f.effects.prepareAndAcquire(preparation(f))
      await drain(f)
      await f.effects.settle(
        settlement(f, prepared, {
          state: 'retry-authorized',
          applicationEvidence: 'ambiguous',
          retryAuthority: 'transport-policy',
        }),
      )
      const before = await effectRows(harness.db, f.taskId)
      expect(before.attempts[0]?.state).toBe('retry-authorized')
      await expect(
        f.effects.prepareAndAcquire(preparation(f, { retryAuthority: 'transport-policy' })),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(await effectRows(harness.db, f.taskId)).toEqual(before)
      expect(before.attempts).toHaveLength(1)
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('selected preparation needs the original admitted work on that token', async () => {
    const f = await effectFixture(harness.db, 'missing-work')
    try {
      const token = createOwnershipToken({
        taskId: f.taskId,
        identity: createWorkerIdentity({
          ownerId: f.token.ownerId,
          daemonGeneration: f.token.daemonGeneration,
        }),
        epoch: f.token.epoch,
        leaseUntil: f.token.leaseUntil,
        ownerRevision: f.token.ownerRevision,
      })
      const before = await effectRows(harness.db, f.taskId)
      await expect(f.effects.prepareAndAcquire(preparation(f, { token }))).rejects.toThrow(
        'task-host-admitted-work-required',
      )
      expect(await effectRows(harness.db, f.taskId)).toEqual(before)
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('a native persistence cannot consume a selected token without its binding', async () => {
    const f = await effectFixture(harness.db, 'missing-binding')
    try {
      const native = createTaskExecutionPersistence(harness.db)
      const before = await effectRows(harness.db, f.taskId)
      await expect(native.effects.prepareAndAcquire(preparation(f))).rejects.toThrow(
        'task-host-write-selection-incomplete',
      )
      expect(await effectRows(harness.db, f.taskId)).toEqual(before)
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('the original immutable-input and receipt errors retain priority after loss', async () => {
    const f = await effectFixture(harness.db, 'business-errors')
    try {
      const prepared = await f.effects.prepareAndAcquire(preparation(f))
      const before = await effectRows(harness.db, f.taskId)
      await drain(f)
      await expect(
        f.effects.prepareAndAcquire(
          preparation(f, { requestHash: requestHash({ v: 1, changed: true }) }),
        ),
      ).rejects.toMatchObject({
        code: 'task-continuation-conflict',
        message: 'logical effect identity was reused with different immutable input',
      })
      await expect(
        f.effects.settle(settlement(f, prepared, { receiptJson: '{invalid' })),
      ).rejects.toMatchObject({
        code: 'task-continuation-conflict',
        message: 'effect receipt is not valid JSON',
      })
      expect(await effectRows(harness.db, f.taskId)).toEqual(before)
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('a failed original ACK transaction retains its attempt for a later successful receipt', async () => {
    let rejectAck = false
    const originalError = new Error('original-ACK-commit-failure')
    const f = await effectFixture(harness.db, 'ack-failure', {
      beforeIssuedAck: () => {
        if (rejectAck) throw originalError
      },
    })
    try {
      const prepared = await f.effects.prepareAndAcquire(preparation(f))
      await drain(f)
      const before = await effectRows(harness.db, f.taskId)
      rejectAck = true
      await expect(f.effects.settle(settlement(f, prepared))).rejects.toBe(originalError)
      expect(await effectRows(harness.db, f.taskId)).toEqual(before)
      rejectAck = false
      await f.effects.settle(settlement(f, prepared))
      expect((await effectRows(harness.db, f.taskId)).effects[0]?.state).toBe('succeeded')
      originalWorkStillOpen(f)
    } finally {
      f.h.module.resetForTesting()
    }
  })

  test('native original claims retain preparation and settlement behavior', async () => {
    const db = harness.db
    const taskId = `native-effect-${ulid()}`
    const snapshot = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
    await db.insert(workflows).values({
      id: `workflow-${taskId}`,
      name: taskId,
      description: '',
      definition: snapshot,
      version: 1,
      schemaVersion: 2,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: taskId,
      workflowId: `workflow-${taskId}`,
      workflowSnapshot: snapshot,
      workflowVersion: 1,
      repoPath: '/tmp/repo',
      worktreePath: `/tmp/worktree/${taskId}`,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      executionLineageId: taskId,
      lineageSlotPathJson: canonicalJson(rootPath(taskId)),
    })
    const intentId = `intent-${taskId}`
    await seedTaskHostIntent(db, taskId, intentId)
    const persistence = createTaskExecutionPersistence(db)
    const module = createProviderTaskExecutionModule({
      daemonGeneration: `native-${taskId}`,
      persistence,
    })
    try {
      const claimed = await module.claimPersisted({ intentId })
      module.claimGate.leave(claimed.permit)
      const f: PreparationFacts = {
        taskId,
        intentId,
        token: claimed.token,
        slotPathJson: encodeLineageSlotPath(rootPath(taskId)),
        familyKey: operationFamilyKey({
          executionLineageId: taskId,
          slotPath: rootPath(taskId),
          effectKind: 'repository',
          stableActionOrdinal: 'host-effect-write',
        }),
      }
      const prepared = await persistence.effects.prepareAndAcquire(preparation(f))
      expect(prepared.attemptNo).toBe(1)
      expect(prepared.resourceKeys).toEqual([`host-effect:${taskId}`])
      await persistence.effects.settle(settlement(f, prepared))
      const rows = await effectRows(db, taskId)
      expect(rows.effects[0]?.state).toBe('succeeded')
      expect(rows.attempts[0]?.receiptJson).toBe(settlement(f, prepared).receiptJson)
    } finally {
      module.resetForTesting()
    }
  })
})
