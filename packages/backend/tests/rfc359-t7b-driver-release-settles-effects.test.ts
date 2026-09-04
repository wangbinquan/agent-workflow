// RFC-359 W1-T7b（P0-10）—— 驱动释放时清算 process effect，两个引擎各跑一遍。
//
// dual-provider-parity-audit-2026-09-04 P0-10：PostgreSQL 的 driver lifecycle 直接
// `releaseAfterStop`，而 PG 的 owner 释放一看到还开着的 effect 就抛 `task-execution-recovery-required`
// ——每个跑过子进程的任务在 PG 上都以 owner 卡死收场。释放序列现在只有一份
// （`infrastructure/taskDriverRelease.ts`），静默清算也只有一份（`infrastructure/effectQuiescence.ts`），
// 这里通过 `TaskExecutionPersistence` 的命名端口在两个 provider 上驱动同一段序列。
// SQLite 的黄金锁（rfc328-durable-ownership.test.ts）仍保留。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionOwners,
  tasks,
  workflows,
} from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import {
  canonicalJson,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import {
  createExclusiveDaemonLockProof,
  createVerifiedStopProof,
  ownershipTuple,
} from '@/modules/task-execution/domain/ownership'
import {
  resolveQuiescedManagedProcesses,
  resolveQuiescenceAuthority,
} from '@/modules/task-execution/infrastructure/effectQuiescence'
import { releaseTaskDriverAndFinalize } from '@/modules/task-execution/infrastructure/taskDriverRelease'
import { describeEachProvider } from './helpers/eachProvider'

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

function continuation(taskId: string): CanonicalContinuationRequest {
  return {
    taskId,
    kind: 'launch',
    source: 'rest',
    actorUserId: 'actor-1',
    expectedTaskRevision: 1,
    scope: {
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPath: rootPath(taskId),
      operationGeneration: 0,
    },
    payload: { v: 1 },
  }
}

async function seedTask(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  const snapshot = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-t7b',
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(rootPath(taskId)),
  })
}

/**
 * 一个被本进程 owner 认领、挂在 runtime registry 上、带一条 pre-activated managed-process
 * attempt 的任务——即子进程节点在 driver 释放前的真实形状。
 */
async function seedOwnedProcessEffect(
  db: ProviderNeutralDatabase,
  over: {
    readonly runStatus?: 'done' | 'failed' | 'running'
    readonly spawned?: boolean
    readonly errorMessage?: string
  } = {},
) {
  const taskId = `t7b_${ulid()}`
  await seedTask(db, taskId)
  const persistence = createTaskExecutionPersistence(db)
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `gen-${ulid()}`,
    persistence,
  })
  const intentId = `intent_${ulid()}`
  await persistence.intents.submit({ request: continuation(taskId), intentId })
  const claimed = await module.claimPersisted({ intentId })
  const controller = new AbortController()
  const attached = module.runtimeRegistry.tryAttach({
    token: claimed.token,
    intentId,
    permit: claimed.permit,
    controller,
  })
  module.claimGate.leave(claimed.permit)
  expect(attached).toBe('attached')

  const runId = ulid()
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'worker',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    ...(over.errorMessage === undefined ? {} : { errorMessage: over.errorMessage }),
  })
  const pathJson = canonicalJson(rootPath(taskId))
  const effect = await persistence.effects.prepareAndAcquire({
    token: claimed.token,
    intentId,
    operationKey: `${taskId}:process:agent`,
    executionLineageId: taskId,
    operationFamilyKey: operationFamilyKey({
      executionLineageId: taskId,
      slotPath: rootPath(taskId),
      effectKind: 'process',
      stableActionOrdinal: 'managed-agent',
    }),
    operationGeneration: 0,
    kind: 'process',
    requestHash: requestHash({ argv: ['/opt/opencode'], cwd: '/tmp/worktree' }),
    slotPathJson: pathJson,
    slotPathDigest: requestHash(pathJson),
    candidateId: `agent:${runId}`,
    recoveryClass: 'managed-process-preactivation',
    classifierVersion: 'rfc328-managed-process-v1',
    transportPolicyVersion: 'rfc328-preactivation-v1',
    retryAuthority: 'none',
    resourceKeys: [`process:${taskId}:${runId}`],
  })
  if (over.spawned === true) {
    await persistence.effects.recordProcessSpawn({
      token: claimed.token,
      effectId: effect.effectId,
      attemptId: effect.attemptId,
      nodeRunId: runId,
      pid: 42,
      spawnBinaryPath: '/opt/opencode',
      launchNonce: `${taskId}-nonce`,
    })
  }
  await db
    .update(nodeRuns)
    .set({ status: over.runStatus ?? 'done' })
    .where(eq(nodeRuns.id, runId))
  return { taskId, intentId, runId, effect, persistence, module, controller, token: claimed.token }
}

async function readEffect(db: ProviderNeutralDatabase, effectId: string) {
  const effect = (
    await db.select().from(taskExecutionEffects).where(eq(taskExecutionEffects.id, effectId))
  )[0]!
  const attempts = await db
    .select()
    .from(taskExecutionEffectAttempts)
    .where(eq(taskExecutionEffectAttempts.effectId, effectId))
  const fences = await db
    .select()
    .from(taskExecutionEffectFences)
    .where(eq(taskExecutionEffectFences.effectAttemptId, attempts[0]!.id))
  return { effect, attempt: attempts[0]!, fences }
}

async function readOwner(db: ProviderNeutralDatabase, taskId: string) {
  return (
    await db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
  )[0]!
}

describeEachProvider('RFC-359 T7b —— 驱动释放清算 process effect（P0-10）', (harness) => {
  test('有 spawn receipt 且 run 已终态 → effect succeeded、fence 释放、owner released、intent completed', async () => {
    const db = harness.db
    const seeded = await seedOwnedProcessEffect(db, { spawned: true, runStatus: 'done' })
    const finalized: string[] = []
    await releaseTaskDriverAndFinalize(
      {
        registry: seeded.module.runtimeRegistry,
        persistence: seeded.persistence,
        stopHeartbeat: () => {},
        finalizeWorkspace: async (taskId) => {
          finalized.push(taskId)
        },
      },
      { taskId: seeded.taskId, controller: seeded.controller },
    )
    expect(finalized).toEqual([seeded.taskId])
    const { effect, attempt, fences } = await readEffect(db, seeded.effect.effectId)
    expect(attempt.state).toBe('succeeded')
    expect(attempt.applicationEvidence).toBe('applied')
    expect(effect.state).toBe('succeeded')
    expect(fences.length).toBeGreaterThan(0)
    expect(fences.every((fence) => fence.releasedAt !== null)).toBe(true)
    const owner = await readOwner(db, seeded.taskId)
    expect(owner.state).toBe('released')
    expect(owner.recoveryCode).toBeNull()
    const intent = (
      await db
        .select({ state: taskExecutionIntents.state })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, seeded.intentId))
    )[0]!
    expect(intent.state).toBe('completed')
    const watermark = (
      await db
        .select()
        .from(taskExecutionLineageOperationRecords)
        .where(eq(taskExecutionLineageOperationRecords.executionLineageId, seeded.taskId))
    ).filter((row) => row.recordKind === 'generation-watermark')
    expect(watermark).toHaveLength(1)
    expect(watermark[0]!.lastOutcome).toBe('succeeded')
    expect(seeded.module.runtimeRegistry.hasTask(seeded.taskId)).toBe(false)
  })

  test('没有 receipt（门控启动器未激活）→ failed-not-applied，owner 照常 released', async () => {
    const db = harness.db
    const seeded = await seedOwnedProcessEffect(db, { spawned: false, runStatus: 'failed' })
    await releaseTaskDriverAndFinalize(
      {
        registry: seeded.module.runtimeRegistry,
        persistence: seeded.persistence,
        stopHeartbeat: () => {},
        finalizeWorkspace: async () => {},
      },
      { taskId: seeded.taskId, controller: seeded.controller },
    )
    const { effect, attempt } = await readEffect(db, seeded.effect.effectId)
    expect(attempt.state).toBe('failed-not-applied')
    expect(attempt.failureCode).toBe('daemon-restart-before-process-activation')
    expect(effect.state).toBe('failed')
    expect((await readOwner(db, seeded.taskId)).state).toBe('released')
  })

  test('run 仍在 running（证据不足）→ outcome-unknown 闭合：replay-decision requires-actor、intent failed、owner released', async () => {
    const db = harness.db
    const seeded = await seedOwnedProcessEffect(db, { spawned: true, runStatus: 'running' })
    await releaseTaskDriverAndFinalize(
      {
        registry: seeded.module.runtimeRegistry,
        persistence: seeded.persistence,
        stopHeartbeat: () => {},
        finalizeWorkspace: async () => {},
      },
      { taskId: seeded.taskId, controller: seeded.controller },
    )
    const { effect, attempt, fences } = await readEffect(db, seeded.effect.effectId)
    expect(attempt.state).toBe('outcome-unknown')
    expect(attempt.failureCode).toBe('outcome-unknown-after-quiescence')
    expect(effect.state).toBe('outcome-unknown')
    expect(fences.every((fence) => fence.releasedAt !== null)).toBe(true)
    const owner = await readOwner(db, seeded.taskId)
    expect(owner.state).toBe('released')
    expect(owner.recoveryCode).toBe('task-execution-outcome-unknown')
    const intent = (
      await db
        .select()
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, seeded.intentId))
    )[0]!
    expect(intent.state).toBe('failed')
    expect(intent.failureCode).toBe('task-execution-outcome-unknown')
    const decision = (
      await db
        .select()
        .from(taskExecutionLineageOperationRecords)
        .where(eq(taskExecutionLineageOperationRecords.executionLineageId, seeded.taskId))
    ).find((row) => row.recordKind === 'replay-decision')
    expect(decision?.decisionState).toBe('requires-actor')
    expect(decision?.sourceEffectId).toBe(seeded.effect.effectId)
  })

  test('node_run 留着 child-unkillable → owner recovery-required，effect 原样留给 successor 屏障', async () => {
    const db = harness.db
    const seeded = await seedOwnedProcessEffect(db, {
      spawned: true,
      runStatus: 'failed',
      errorMessage: 'child-unkillable: pid 42 survived SIGKILL',
    })
    await releaseTaskDriverAndFinalize(
      {
        registry: seeded.module.runtimeRegistry,
        persistence: seeded.persistence,
        stopHeartbeat: () => {},
        finalizeWorkspace: async () => {},
      },
      { taskId: seeded.taskId, controller: seeded.controller },
    )
    const owner = await readOwner(db, seeded.taskId)
    expect(owner.state).toBe('recovery-required')
    expect(owner.recoveryCode).toBe('child-unkillable')
    const { effect, attempt } = await readEffect(db, seeded.effect.effectId)
    expect(effect.state).toBe('open')
    expect(attempt.state).toBe('acting')
  })

  test('过期 / 重复的 driver finally 不碰库：controller 不匹配就直接返回', async () => {
    const db = harness.db
    const seeded = await seedOwnedProcessEffect(db, { spawned: true, runStatus: 'done' })
    let finalized = 0
    await releaseTaskDriverAndFinalize(
      {
        registry: seeded.module.runtimeRegistry,
        persistence: seeded.persistence,
        stopHeartbeat: () => {},
        finalizeWorkspace: async () => {
          finalized += 1
        },
      },
      { taskId: seeded.taskId, controller: new AbortController() },
    )
    expect(finalized).toBe(0)
    expect((await readOwner(db, seeded.taskId)).state).toBe('claimed')
    expect((await readEffect(db, seeded.effect.effectId)).effect.state).toBe('open')
    expect(seeded.module.runtimeRegistry.hasTask(seeded.taskId)).toBe(true)
  })

  test('successor-daemon 权威：owner 已 revoked + 新一代锁证明 → 同一份清算；同代证明被拒', async () => {
    const db = harness.db
    const seeded = await seedOwnedProcessEffect(db, { spawned: true, runStatus: 'done' })
    const oldOwner = await readOwner(db, seeded.taskId)
    await db
      .update(taskExecutionOwners)
      .set({ state: 'revoked', revision: oldOwner.revision + 1 })
      .where(eq(taskExecutionOwners.taskId, seeded.taskId))
    const sameGeneration = createExclusiveDaemonLockProof({
      daemonGeneration: oldOwner.daemonGeneration,
      acquiredAt: 10,
      lockReceiptDigest: 'lock-same',
    })
    expect(() =>
      resolveQuiescenceAuthority({
        authority: 'successor-daemon',
        owner: ownershipTuple(seeded.token),
        expectedRevision: oldOwner.revision + 1,
        lockProof: sameGeneration,
      }),
    ).toThrow('managed-process successor recovery requires a new daemon generation')
    const resolution = await resolveQuiescedManagedProcesses(db, {
      authority: 'successor-daemon',
      owner: ownershipTuple(seeded.token),
      expectedRevision: oldOwner.revision + 1,
      lockProof: createExclusiveDaemonLockProof({
        daemonGeneration: `gen-${ulid()}`,
        acquiredAt: 10,
        lockReceiptDigest: 'lock-next',
      }),
      quiescenceEvidenceDigest: 'orphan-reaper-done',
      now: 11,
    })
    expect(resolution.resolvedEffectIds).toEqual([seeded.effect.effectId])
    expect(resolution.unresolvedEffectIds).toEqual([])
    expect((await readEffect(db, seeded.effect.effectId)).effect.state).toBe('succeeded')
    seeded.module.resetForTesting()
  })

  test('exact-stop 权威：停机证明必须对上 token 与 owner revision', async () => {
    const db = harness.db
    const seeded = await seedOwnedProcessEffect(db, { spawned: true, runStatus: 'done' })
    const owner = await readOwner(db, seeded.taskId)
    const mismatched = createVerifiedStopProof({
      taskId: seeded.taskId,
      ownerRevision: owner.revision + 7,
      epoch: seeded.token.epoch,
      evidenceDigest: 'stop',
      verifiedAt: 5,
    })
    await expect(
      resolveQuiescedManagedProcesses(db, {
        authority: 'exact-stop',
        token: seeded.token,
        expectedRevision: owner.revision,
        proof: mismatched,
        quiescenceEvidenceDigest: 'stop',
      }),
    ).rejects.toThrow('managed-process stop proof does not match the exact owner')
    await expect(
      resolveQuiescedManagedProcesses(db, {
        authority: 'exact-stop',
        token: seeded.token,
        expectedRevision: owner.revision,
        proof: createVerifiedStopProof({
          taskId: seeded.taskId,
          ownerRevision: owner.revision,
          epoch: seeded.token.epoch,
          evidenceDigest: 'stop',
          verifiedAt: 5,
        }),
        quiescenceEvidenceDigest: '',
      }),
    ).rejects.toThrow('managed-process recovery requires quiescence evidence')
    expect((await readEffect(db, seeded.effect.effectId)).effect.state).toBe('open')
    seeded.module.resetForTesting()
  })
})

test('源码锁：两个 provider 的 driver lifecycle 都委托同一份释放序列，PG recovery 不再自带清算', () => {
  const infrastructure = resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'infrastructure',
  )
  for (const file of ['taskDriverLifecycle.ts', 'postgresqlTaskDriverLifecycle.ts']) {
    const source = readFileSync(resolve(infrastructure, file), 'utf8')
    expect(source).toContain("from './taskDriverRelease'")
    expect(source).not.toContain('releaseAfterStop(')
    expect(source).not.toContain('markRecoveryRequired(')
  }
  const recovery = readFileSync(
    resolve(infrastructure, 'postgresqlTaskExecutionRecovery.ts'),
    'utf8',
  )
  expect(recovery).toContain("from './effectQuiescence'")
  expect(recovery).not.toContain('async function resolveManagedProcesses(')
  expect(recovery).not.toContain('async function closeOutcomeUnknown(')
  for (const file of [
    'sqliteTaskExecutionEffectPersistence.ts',
    'postgresqlTaskExecutionEffectPersistence.ts',
  ]) {
    const source = readFileSync(resolve(infrastructure, file), 'utf8')
    expect(source).toContain("from './effectQuiescence'")
  }
})
