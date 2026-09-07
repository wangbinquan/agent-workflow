// RFC-359 W8 —— 后继 daemon 恢复（`TaskExecutionRecoveryPersistence`）端口的双引擎取证基线。
//
// 形态与 D28a 的归属端口一模一样：SQLite 侧是 20 行薄适配器套 393 行同步实现
// （`sqliteTaskExecutionRecovery.ts`，走 `taskExecutionModule.effects` 的 dbTxSync 家族），
// PostgreSQL 侧是 674 行原生重写（`postgresqlTaskExecutionRecovery.ts`，自带一份私有的
// code-host 探针清算）。两侧比值 1.7、体量接近——按 W5 的经验规律，这正是「两侧各自长出同样
// 体量的代码」的形状，合一前必须先用实测差异代替纸面对账。
//
// 本文件按 D19b/D23a 的方法论取证：**按端口数覆盖、不是按实现数**——同一批场景经同一个
// `TaskExecutionRecoveryPersistence` 端口在两个引擎上各跑一遍。合一（W8）之前它照出三条真差异，
// 全部记在 `tests/architecture/rfc359-w5-dual-engine-predicate-gaps.test.ts`：
//
//   · 04-pg-code-host-recovery-lock-proof —— PG 的 code-host 清算不校验接管者代际 / 静默证据；
//   · 05-pg-code-host-evidence-digest-payload —— 两侧 takeover 证明摘要的载荷不同；
//   · 08-pg-release-recovered-replay-decision-rollback —— PG 恢复后不回退未消费的重放授权。
//
// 合一之后这三条全部关闭：这里锁住的每一条都必须在两个引擎上同时成立。
//
// 装配形状本身曾是分叉的一部分，所以取 provider 中立的组合根 `createTaskExecutionPersistence(db)`
// ——测试体拿不到 provider 名，只能按能力矩阵分叉（这里一条都不需要）。

import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunOutputs,
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionOwners,
  tasks,
  workflows,
} from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import {
  buildCodeHostRecoveryDescriptor,
  decodeCodeHostRecoveryDescriptor,
} from '@/modules/task-execution/domain/codeHostRecovery'
import { sha256Hex } from '@/modules/task-execution/domain/digest'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import {
  canonicalJson,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import {
  createExclusiveDaemonLockProof,
  type ExclusiveDaemonLockProof,
  type OwnershipToken,
} from '@/modules/task-execution/domain/ownership'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

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

interface CrashedTask {
  readonly taskId: string
  readonly intentId: string
  readonly nodeRunId: string
  readonly token: OwnershipToken
}

/** 上一代 daemon 认领了任务、挂上 node_run，然后整个进程被 SIGKILL。 */
async function crashPreviousDaemon(
  db: ProviderNeutralDatabase,
  persistence: TaskExecutionPersistence,
  taskId: string,
): Promise<CrashedTask> {
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: `rfc359-w8-${taskId}`,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 100,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(rootPath(taskId)),
  })
  const nodeRunId = `${taskId}-run`
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'code-host-node',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: 100,
  })
  const intentId = `${taskId}-intent`
  await persistence.intents.submit({ request: continuation(taskId), intentId })
  const previous = createProviderTaskExecutionModule({
    daemonGeneration: `gen-old-${taskId}`,
    persistence,
  })
  const claimed = await previous.claimPersisted({ intentId, now: 110 })
  previous.claimGate.leave(claimed.permit)
  return { taskId, intentId, nodeRunId, token: claimed.token }
}

/** 孤儿收割屏障已跑完的形状：任务 / node_run 都翻成 interrupted。 */
async function reapOrphans(db: ProviderNeutralDatabase, crashed: CrashedTask): Promise<void> {
  await db.update(tasks).set({ status: 'interrupted' }).where(eq(tasks.id, crashed.taskId))
  await db
    .update(nodeRuns)
    .set({ status: 'interrupted', finishedAt: 202 })
    .where(eq(nodeRuns.id, crashed.nodeRunId))
}

interface SeededCodeHostEffect {
  readonly effectId: string
  readonly attemptId: string
  readonly descriptorJson: string
}

/** 一个开着的 code-host-mutation effect：attempt 停在 acting，正是崩溃瞬间的形状。 */
async function seedCodeHostEffect(
  db: ProviderNeutralDatabase,
  persistence: TaskExecutionPersistence,
  crashed: CrashedTask,
  spec: {
    readonly action: 'pipeline.cancel' | 'review.draft-discard'
    readonly candidateId: string
    readonly recoveryClass: string
    readonly method: string
    readonly pathname: string
  },
): Promise<SeededCodeHostEffect> {
  const pathJson = canonicalJson(rootPath(crashed.taskId))
  const descriptorJson = JSON.stringify(
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
      crashed.nodeRunId,
    ),
  )
  const prepared = await persistence.effects.prepareAndAcquire({
    token: crashed.token,
    intentId: crashed.intentId,
    operationKey: `${crashed.taskId}:${spec.action}`,
    executionLineageId: crashed.taskId,
    operationFamilyKey: operationFamilyKey({
      executionLineageId: crashed.taskId,
      slotPath: rootPath(crashed.taskId),
      effectKind: 'code-host-mutation',
      stableActionOrdinal: spec.action,
    }),
    operationGeneration: 0,
    kind: 'code-host-mutation',
    requestHash: requestHash({ provider: 'gitlab', action: spec.action }),
    slotPathJson: pathJson,
    slotPathDigest: requestHash(pathJson),
    candidateId: `${spec.candidateId}:t1`,
    recoveryClass: spec.recoveryClass,
    recoveryDescriptorJson: descriptorJson,
    classifierVersion: 'rfc328-codehost-matrix-v1',
    transportPolicyVersion: 'rfc328-codehost-transport-v1',
    retryAuthority: 'none',
    resourceKeys: [`code-host:gitlab:${crashed.taskId}`],
    now: 150,
  })
  // owner 行的 revision 被 effect 预占的围栏推进过，调用方要重新读。
  return {
    effectId: prepared.effectId,
    attemptId: prepared.attemptId,
    descriptorJson,
  }
}

function lockProofFor(generation: string): ExclusiveDaemonLockProof {
  return createExclusiveDaemonLockProof({
    daemonGeneration: generation,
    acquiredAt: 200,
    lockReceiptDigest: 'e'.repeat(64),
  })
}

describeEachProvider('RFC-359 W8 —— 后继 daemon 恢复端口在两个引擎上同形', (harness) => {
  test('① prepare：只撤销上一代 daemon 的 claimed owner，本代的原样留着', async () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    const stale = await crashPreviousDaemon(harness.db, persistence, `w8a_${ulid()}`)
    const successor = `gen-new-${ulid()}`

    const preparation = await persistence.recovery.prepare({
      lockProof: lockProofFor(successor),
      now: 201,
    })
    expect(preparation.revokedTaskIds).toEqual([stale.taskId])
    expect((await persistence.ownership.read(stale.taskId))?.state).toBe('revoked')

    // 再跑一次：已经不是 claimed 了，没有候选。
    expect(
      (await persistence.recovery.prepare({ lockProof: lockProofFor(successor), now: 202 }))
        .revokedTaskIds,
    ).toEqual([])
  })

  test('② prepare：同代 daemon 自己的 owner 不是候选（不会自撤）', async () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    const live = await crashPreviousDaemon(harness.db, persistence, `w8b_${ulid()}`)
    const owner = await persistence.ownership.read(live.taskId)
    if (owner === null) throw new Error('owner row missing')

    const preparation = await persistence.recovery.prepare({
      lockProof: lockProofFor(owner.daemonGeneration),
      now: 201,
    })
    expect(preparation.revokedTaskIds).toEqual([])
    expect((await persistence.ownership.read(live.taskId))?.state).toBe('claimed')
  })

  test('③ finalize 必须先有孤儿收割屏障的证据，否则拒绝', async () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    await expect(
      persistence.recovery.finalize({
        lockProof: lockProofFor(`gen-new-${ulid()}`),
        processEvidence: { orphanReaperCompleted: false } as unknown as {
          readonly orphanReaperCompleted: true
        },
        now: 203,
      }),
    ).rejects.toThrow(/orphan-process barrier/)
  })

  test('④ finalize：没有未决 effect 的任务被释放，活跃 intent 转 failed', async () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    const crashed = await crashPreviousDaemon(harness.db, persistence, `w8c_${ulid()}`)
    const lockProof = lockProofFor(`gen-new-${ulid()}`)
    await persistence.recovery.prepare({ lockProof, now: 201 })
    await reapOrphans(harness.db, crashed)

    const finalized = await persistence.recovery.finalize({
      lockProof,
      processEvidence: { orphanReaperCompleted: true },
      now: 203,
    })
    expect(finalized.releasedTaskIds).toEqual([crashed.taskId])
    expect(finalized.outcomeUnknownTaskIds).toEqual([])

    const owner = await persistence.ownership.read(crashed.taskId)
    expect(owner?.state).toBe('released')
    const intent = (
      await harness.db
        .select({
          state: taskExecutionIntents.state,
          failureCode: taskExecutionIntents.failureCode,
        })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, crashed.intentId))
    )[0]
    expect(intent).toMatchObject({ state: 'failed', failureCode: 'daemon-restart-recovered' })
  })

  test('⑤ finalize：未消费的 actor-replay-authorized 决策回退成 requires-actor（缺口 08）', async () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    const crashed = await crashPreviousDaemon(harness.db, persistence, `w8d_${ulid()}`)
    const decisionId = `decision_${ulid()}`
    const pathJson = canonicalJson(rootPath(crashed.taskId))
    await harness.db.insert(taskExecutionLineageOperationRecords).values({
      id: decisionId,
      recordKind: 'replay-decision',
      executionLineageId: crashed.taskId,
      operationFamilyKey: `${crashed.taskId}:family`,
      operationGeneration: 0,
      requestHash: requestHash(pathJson),
      slotPathJson: pathJson,
      slotPathDigest: requestHash(pathJson),
      decisionState: 'actor-replay-authorized',
      replayAuthorizationId: `auth_${decisionId}`,
      authorizationScopeJson: '{"v":1}',
      actorUserId: 'actor-1',
      authorizationSource: 'rest',
      boundIntentId: crashed.intentId,
      recordRevision: 1,
      createdAt: 120,
      updatedAt: 120,
    })
    const lockProof = lockProofFor(`gen-new-${ulid()}`)
    await persistence.recovery.prepare({ lockProof, now: 201 })
    await reapOrphans(harness.db, crashed)

    expect(
      (
        await persistence.recovery.finalize({
          lockProof,
          processEvidence: { orphanReaperCompleted: true },
          now: 203,
        })
      ).releasedTaskIds,
    ).toEqual([crashed.taskId])

    const decision = (
      await harness.db
        .select()
        .from(taskExecutionLineageOperationRecords)
        .where(eq(taskExecutionLineageOperationRecords.id, decisionId))
    )[0]
    expect(decision?.decisionState).toBe('requires-actor')
    expect(decision?.replayAuthorizationId).toBeNull()
    expect(decision?.boundIntentId).toBeNull()
    expect(decision?.actorUserId).toBeNull()
  })

  test('⑥ finalize：还开着的 code-host effect 没有探针结论时以 outcome-unknown 闭合，不释放', async () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    const crashed = await crashPreviousDaemon(harness.db, persistence, `w8e_${ulid()}`)
    const seeded = await seedCodeHostEffect(harness.db, persistence, crashed, {
      action: 'pipeline.cancel',
      candidateId: 'pipeline.cancel:c0',
      recoveryClass: 'R-STATE',
      method: 'POST',
      pathname: '/projects/group%2Frepo/pipelines/31/cancel',
    })
    const lockProof = lockProofFor(`gen-new-${ulid()}`)
    await persistence.recovery.prepare({ lockProof, now: 201 })
    await reapOrphans(harness.db, crashed)

    const finalized = await persistence.recovery.finalize({
      lockProof,
      processEvidence: { orphanReaperCompleted: true },
      // 探针返回 unknown ⇒ 没有确定结论，effect 只能进 outcome-unknown。
      codeHostProbe: async () => ({
        kind: 'unknown',
        proofCode: 'probe-unreachable',
        responseStatus: null,
        responseBody: '',
      }),
      now: 203,
    })
    expect(finalized.releasedTaskIds).toEqual([])
    expect(finalized.outcomeUnknownTaskIds).toEqual([crashed.taskId])
    expect(finalized.recoveredCodeHostEffectIds).toEqual([])

    expect(
      (
        await harness.db
          .select({ state: taskExecutionEffects.state })
          .from(taskExecutionEffects)
          .where(eq(taskExecutionEffects.id, seeded.effectId))
      )[0]?.state,
    ).toBe('outcome-unknown')
    expect((await persistence.ownership.read(crashed.taskId))?.state).toBe('released')
  })

  test('⑦ finalize + 探针：applied 的落 succeeded 并投影 node_run；definitely-not-applied 的转 retry-authorized', async () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    const applied = await crashPreviousDaemon(harness.db, persistence, `w8f_${ulid()}`)
    const appliedEffect = await seedCodeHostEffect(harness.db, persistence, applied, {
      action: 'pipeline.cancel',
      candidateId: 'pipeline.cancel:c0',
      recoveryClass: 'R-STATE',
      method: 'POST',
      pathname: '/projects/group%2Frepo/pipelines/31/cancel',
    })
    const retried = await crashPreviousDaemon(harness.db, persistence, `w8g_${ulid()}`)
    const retriedEffect = await seedCodeHostEffect(harness.db, persistence, retried, {
      action: 'review.draft-discard',
      candidateId: 'review.draft-discard:c0',
      recoveryClass: 'R-PARTIAL',
      method: 'DELETE',
      pathname: '/projects/group%2Frepo/merge_requests/9/draft_notes/73',
    })
    const lockProof = lockProofFor(`gen-new-${ulid()}`)
    expect(
      [...(await persistence.recovery.prepare({ lockProof, now: 201 })).revokedTaskIds].sort(),
    ).toEqual([applied.taskId, retried.taskId].sort())
    await reapOrphans(harness.db, applied)
    await reapOrphans(harness.db, retried)

    const finalized = await persistence.recovery.finalize({
      lockProof,
      processEvidence: { orphanReaperCompleted: true },
      codeHostProbe: async (descriptor) =>
        descriptor.action === 'pipeline.cancel'
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
            },
      now: 203,
    })
    expect([...finalized.releasedTaskIds].sort()).toEqual([applied.taskId, retried.taskId].sort())
    expect(finalized.outcomeUnknownTaskIds).toEqual([])
    expect(finalized.recoveredCodeHostEffectIds).toEqual([appliedEffect.effectId])
    expect(finalized.retryAuthorizedCodeHostEffectIds).toEqual([retriedEffect.effectId])

    expect(
      (
        await harness.db
          .select({ state: taskExecutionEffects.state })
          .from(taskExecutionEffects)
          .where(eq(taskExecutionEffects.id, appliedEffect.effectId))
      )[0]?.state,
    ).toBe('succeeded')
    expect(
      (
        await harness.db
          .select({ status: nodeRuns.status })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, applied.nodeRunId))
      )[0]?.status,
    ).toBe('done')
    expect(
      (
        await harness.db
          .select({ port: nodeRunOutputs.portName, content: nodeRunOutputs.content })
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, applied.nodeRunId))
      )
        .map((row) => ({ ...row }))
        .sort((left, right) => left.port.localeCompare(right.port)),
    ).toEqual([
      { port: 'response', content: '{"status":"canceled"}' },
      { port: 'status', content: '200' },
    ])
    expect(
      (
        await harness.db
          .select({ state: taskExecutionEffectAttempts.state })
          .from(taskExecutionEffectAttempts)
          .where(eq(taskExecutionEffectAttempts.id, retriedEffect.attemptId))
      )[0]?.state,
    ).toBe('retry-authorized')
    // definitely-not-applied 的 effect 仍开着，等着同代重试；任务照样释放。
    expect(
      (
        await harness.db
          .select({ state: taskExecutionEffects.state })
          .from(taskExecutionEffects)
          .where(eq(taskExecutionEffects.id, retriedEffect.effectId))
      )[0]?.state,
    ).toBe('open')
  })

  test('⑧ takeover 证明摘要的载荷含探针判据（缺口 05）—— 两个引擎必须算出同一个摘要', async () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    const taskId = `w8h_${ulid()}`
    const crashed = await crashPreviousDaemon(harness.db, persistence, taskId)
    const seeded = await seedCodeHostEffect(harness.db, persistence, crashed, {
      action: 'pipeline.cancel',
      candidateId: 'pipeline.cancel:c0',
      recoveryClass: 'R-STATE',
      method: 'POST',
      pathname: '/projects/group%2Frepo/pipelines/31/cancel',
    })
    const successorGeneration = `gen-new-${ulid()}`
    const lockProof = lockProofFor(successorGeneration)
    await persistence.recovery.prepare({ lockProof, now: 201 })
    await reapOrphans(harness.db, crashed)
    const revoked = await persistence.ownership.read(taskId)
    if (revoked === null) throw new Error('owner row missing')
    const oldOwner = {
      taskId,
      ownerId: revoked.ownerId,
      daemonGeneration: revoked.daemonGeneration,
      epoch: revoked.epoch,
    }
    const processEvidence = { orphanReaperCompleted: true } as const

    await persistence.recovery.finalize({
      lockProof,
      processEvidence,
      codeHostProbe: async () => ({
        kind: 'applied',
        proofCode: 'pipeline-canceled',
        responseStatus: 200,
        responseBody: '{"status":"canceled"}',
      }),
      now: 203,
    })

    const processEvidenceDigest = sha256Hex(
      canonicalJson({
        v: 1,
        taskId,
        oldOwner,
        successorGeneration,
        lockReceiptDigest: lockProof.lockReceiptDigest,
        processEvidence,
        preResolutionEffectIds: [seeded.effectId],
      }),
    )
    const codeHostEvidenceDigest = sha256Hex(
      canonicalJson({
        v: 1,
        taskId,
        processEvidenceDigest,
        probeResults: [
          {
            effectId: seeded.effectId,
            attemptId: seeded.attemptId,
            descriptor: decodeCodeHostRecoveryDescriptor(seeded.descriptorJson),
            outcome: 'applied',
            proofCode: 'pipeline-canceled',
            responseStatus: 200,
          },
        ],
      }),
    )
    const evidenceDigest = sha256Hex(
      canonicalJson({
        v: 2,
        taskId,
        oldOwner,
        successorGeneration,
        lockReceiptDigest: lockProof.lockReceiptDigest,
        processEvidenceDigest,
        recoveredProcessEffectIds: [],
        recoveredCodeHostEffectIds: [seeded.effectId],
        retryAuthorizedCodeHostEffectIds: [],
        codeHostEvidenceDigest,
        unresolvedEffectIds: [],
      }),
    )

    const row = (
      await harness.db
        .select({ digest: taskExecutionOwners.recoveryProofDigest })
        .from(taskExecutionOwners)
        .where(
          and(eq(taskExecutionOwners.taskId, taskId), eq(taskExecutionOwners.state, 'released')),
        )
    )[0]
    expect(row?.digest).toBe(evidenceDigest)
  })

  test('⑨ 未经铸造的独占锁证明当场被拒 —— prepare / finalize 都不许因为「恰好没有候选」而静默放行（缺口 04）', async () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    // 形状对得上、但没经过 createExclusiveDaemonLockProof 铸造：能力本身不可信。
    const forged = {
      daemonGeneration: `gen-forged-${ulid()}`,
      acquiredAt: 200,
      lockReceiptDigest: 'f'.repeat(64),
    } as unknown as ExclusiveDaemonLockProof

    await expect(persistence.recovery.prepare({ lockProof: forged, now: 201 })).rejects.toThrow(
      /daemon-lock-proof/,
    )
    await expect(
      persistence.recovery.finalize({
        lockProof: forged,
        processEvidence: { orphanReaperCompleted: true },
        now: 203,
      }),
    ).rejects.toThrow(/daemon-lock-proof/)
  })
})
