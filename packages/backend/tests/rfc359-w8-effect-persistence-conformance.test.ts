// RFC-359 W8 —— `TaskExecutionEffectPersistence` 端口的双引擎对拍。
//
// 合一前这一对是两台**同构**引擎：SQLite 侧是 `sqliteTaskExecutionEffectPersistence.ts`（369 行
// 薄壳）+ `sqliteTaskExecutionEffect.ts` 里 `SqliteTaskExecutionEffectStore` 的四个同步方法
// （planCodeHostAttempt / nextOperationGeneration / prepareAndAcquire / settle，约 583 行，走
// `withOwnedTaskTx` + `dbTxSync`）；PostgreSQL 侧是 `postgresqlTaskExecutionEffectPersistence.ts`
// （1007 行，走 SERIALIZABLE + 私有 `assertOwner`）。同一张 effect / attempt / fence / watermark
// 账本、同一套 domain 判定（aggregateEffectOutcome / assertAttemptTransition / canCreateNextAttempt /
// canonicalResourceKeySet）、同一批错误码——**是重复，不是能力缺口**。
//
// 这份对拍先在两个旧实现上跑，把实测差异逐条钉住，再合一。钉住的差异（合一时按强侧抬齐）：
//   · CAS 结果校验：PG 每一步都验受影响行（`effect preparation CAS lost` / `effect settlement CAS
//     lost` / `effect terminal CAS lost` / `effect watermark CAS lost` / `process spawn projection
//     CAS lost` / 回滚投影逐行 `lost source`），SQLite 侧一律 `.run()` 不看结果 —— 合一取 PG。
//   · code-host 结算的 node_run 迁移：SQLite 走 `setNodeRunStatusTx`（终态闸 + MR/PR
//     source-termination 围栏 + `node-run-not-found`），PG 手写 `update … where status='running'`
//     —— 合一取 SQLite，这正是 `rfc359-w5-dual-engine-predicate-gaps` 的
//     `03-pg-code-host-projection-node-run-cas`。
//   · receipt 边界：SQLite `boundedReceipt` 会 `JSON.parse` 校验并抛裸 `Error`，PG `bounded` 只查
//     字节数、抛 `TaskExecutionError('task-continuation-conflict')` —— 合一取「两条校验都做、
//     错误类型取 PG」。
//   · owner 围栏：SQLite 是 owner 行上的条件 UPDATE（revision +1），PG 是只读 SELECT 检查
//     —— 合一取统一原语 `assertTaskOwnerTx`（= SQLite 形状），于是 PG 上 effect 写入也推进
//     owner revision。
//
// 合一后这份文件不再对拍「两个类」，它对拍的是**同一份实现在两个引擎上的同一行为**。

import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
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
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import type { TaskExecutionEffectPersistence } from '@/modules/task-execution/application/ports/taskExecutionEffectStore'
import { sha256Hex } from '@/modules/task-execution/domain/digest'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import {
  canonicalJson,
  encodeLineageSlotPath,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import {
  createOwnershipToken,
  createWorkerIdentity,
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
    actorUserId: 'actor-w8',
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

interface Fixture {
  readonly taskId: string
  readonly runId: string
  readonly prepRunId: string
  readonly intentId: string
  readonly token: OwnershipToken
  readonly effects: TaskExecutionEffectPersistence
  readonly familyKey: string
  readonly slotPathJson: string
  reset(): void
}

async function seed(db: ProviderNeutralDatabase): Promise<Fixture> {
  const taskId = `w8_${ulid()}`
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-w8',
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
    startedAt: Date.now() - 1_000,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(rootPath(taskId)),
  })
  const runId = ulid()
  const prepRunId = ulid()
  // `continuationSlotKey` / `lineageSlotPathJson` 由生产工厂显式写入；直插行必须自带它们
  // ——SQLite 的迁移 0210 给直写者装了补齐触发器，PostgreSQL 没有（schema 面的差异，不在本对之内）。
  const slotPathJson = encodeLineageSlotPath(rootPath(taskId))
  await db.insert(nodeRuns).values([
    {
      id: runId,
      taskId,
      nodeId: 'worker',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      continuationSlotKey: `${taskId}:root`,
      lineageSlotPathJson: slotPathJson,
    },
    {
      id: prepRunId,
      taskId,
      nodeId: 'repo-prep',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      continuationSlotKey: `${taskId}:root`,
      lineageSlotPathJson: slotPathJson,
    },
  ])
  const persistence = createTaskExecutionPersistence(db)
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `gen-${ulid()}`,
    persistence,
  })
  const intentId = `intent_${ulid()}`
  await persistence.intents.submit({ request: continuation(taskId), intentId })
  const claimed = await module.claimPersisted({ intentId })
  module.claimGate.leave(claimed.permit)
  // 上下文只是为了与生产同形；本文件所有调用都显式传 token。
  createTaskExecutionContext({ intentId, token: claimed.token, persistence })
  return {
    taskId,
    runId,
    prepRunId,
    intentId,
    token: claimed.token,
    effects: persistence.effects,
    familyKey: operationFamilyKey({
      executionLineageId: taskId,
      slotPath: rootPath(taskId),
      effectKind: 'repository',
      stableActionOrdinal: 'w8-conformance',
    }),
    slotPathJson,
    reset: () => module.resetForTesting(),
  }
}

/** 一枚**已注册但不是当前 owner** 的 token：过得了 `assertOwnershipToken`，过不了库里的围栏。 */
function foreignToken(fixture: Fixture): OwnershipToken {
  return createOwnershipToken({
    taskId: fixture.taskId,
    identity: createWorkerIdentity({
      ownerId: `other_${ulid()}`,
      daemonGeneration: `gen-other-${ulid()}`,
    }),
    epoch: fixture.token.epoch + 5,
    leaseUntil: Date.now() + 60_000,
    ownerRevision: 1,
  })
}

function preparation(
  fixture: Fixture,
  overrides: Partial<Parameters<TaskExecutionEffectPersistence['prepareAndAcquire']>[0]> = {},
): Parameters<TaskExecutionEffectPersistence['prepareAndAcquire']>[0] {
  return {
    token: fixture.token,
    intentId: fixture.intentId,
    operationKey: `${fixture.taskId}:root:repository:w8-conformance`,
    executionLineageId: fixture.taskId,
    operationFamilyKey: fixture.familyKey,
    operationGeneration: 0,
    kind: 'repository',
    requestHash: requestHash({ v: 1, probe: 'w8' }),
    slotPathJson: fixture.slotPathJson,
    slotPathDigest: sha256Hex(fixture.slotPathJson),
    candidateId: 'w8-candidate',
    recoveryClass: 'local-probe-or-actor',
    classifierVersion: 'rfc328-local-effect-v1',
    transportPolicyVersion: 'rfc328-local-effect-direct-v1',
    retryAuthority: 'none',
    resourceKeys: [`w8:${fixture.taskId}`],
    ...overrides,
  }
}

async function errorOf(body: () => Promise<unknown>): Promise<Error> {
  try {
    await body()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to throw')
}

function codeOf(error: Error): string {
  return (error as { readonly code?: string }).code ?? `<no-code:${error.constructor.name}>`
}

describeEachProvider('RFC-359 W8 —— effect 账本端口双引擎对拍', (harness) => {
  test('readLineage：命中返回世系快照，缺 node_run 返回 null', async () => {
    const fixture = await seed(harness.db)
    const hit = await fixture.effects.readLineage({
      taskId: fixture.taskId,
      intentId: fixture.intentId,
      nodeRunId: fixture.runId,
    })
    expect(hit).not.toBeNull()
    expect(hit?.executionLineageId).toBe(fixture.taskId)
    expect(hit?.continuationSlotKey).toBe(`${fixture.taskId}:root`)
    expect(hit?.workflowVersion).toBe(1)
    expect(hit?.nodeId).toBe('worker')
    expect(hit?.iteration).toBe(0)
    expect(hit?.retryIndex).toBe(0)
    expect(hit?.shardKey).toBeNull()

    const withoutRun = await fixture.effects.readLineage({
      taskId: fixture.taskId,
      intentId: fixture.intentId,
    })
    expect(withoutRun?.nodeId).toBeNull()

    expect(
      await fixture.effects.readLineage({
        taskId: fixture.taskId,
        intentId: fixture.intentId,
        nodeRunId: `missing_${ulid()}`,
      }),
    ).toBeNull()
    expect(
      await fixture.effects.readLineage({ taskId: fixture.taskId, intentId: `missing_${ulid()}` }),
    ).toBeNull()
    fixture.reset()
  })

  test('nextOperationGeneration / planCodeHostAttempt：空账本 0，结算后按 watermark 前进', async () => {
    const fixture = await seed(harness.db)
    const key = { executionLineageId: fixture.taskId, operationFamilyKey: fixture.familyKey }
    expect(await fixture.effects.nextOperationGeneration(key)).toBe(0)
    expect(await fixture.effects.planCodeHostAttempt(key)).toEqual({
      operationGeneration: 0,
      retryAuthority: 'none',
    })

    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    expect(prepared.attemptNo).toBe(1)
    expect(prepared.resourceKeys).toEqual([`w8:${fixture.taskId}`])
    // 未结算时下一代仍要跳过在飞的这一代。
    expect(await fixture.effects.nextOperationGeneration(key)).toBe(1)

    await fixture.effects.settle({
      token: fixture.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'succeeded',
      applicationEvidence: 'applied',
      retryAuthority: 'none',
      receiptJson: JSON.stringify({ v: 1, ok: true }),
    })
    expect(await fixture.effects.nextOperationGeneration(key)).toBe(1)
    expect(await fixture.effects.planCodeHostAttempt(key)).toEqual({
      operationGeneration: 1,
      retryAuthority: 'none',
    })
    fixture.reset()
  })

  test('planCodeHostAttempt：retry-authorized 的在飞代重用同一代与同一授权', async () => {
    const fixture = await seed(harness.db)
    const key = { executionLineageId: fixture.taskId, operationFamilyKey: fixture.familyKey }
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    await fixture.effects.settle({
      token: fixture.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'retry-authorized',
      applicationEvidence: 'ambiguous',
      retryAuthority: 'transport-policy',
      receiptJson: JSON.stringify({ v: 1, retry: true }),
      failureCode: 'w8-retry',
    })
    expect(await fixture.effects.planCodeHostAttempt(key)).toEqual({
      operationGeneration: 0,
      retryAuthority: 'transport-policy',
    })
    // 授权放行下一次 attempt，围栏可以重新获取（上一 attempt 的 hold 已随授权释放）。
    const second = await fixture.effects.prepareAndAcquire(
      preparation(fixture, { retryAuthority: 'transport-policy' }),
    )
    expect(second.effectId).toBe(prepared.effectId)
    expect(second.attemptNo).toBe(2)
    fixture.reset()
  })

  test('prepareAndAcquire：陈旧 token / 错代 / 身份复用 / 资源占用各自的错误码', async () => {
    const fixture = await seed(harness.db)
    const stale = await errorOf(() =>
      fixture.effects.prepareAndAcquire(preparation(fixture, { token: foreignToken(fixture) })),
    )
    expect(codeOf(stale)).toBe('task-execution-stale-owner')

    const wrongGeneration = await errorOf(() =>
      fixture.effects.prepareAndAcquire(preparation(fixture, { operationGeneration: 7 })),
    )
    expect(codeOf(wrongGeneration)).toBe('task-continuation-stale')

    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    expect(prepared.attemptNo).toBe(1)

    // 同一代、同一 family，但不可变输入变了。
    const reused = await errorOf(() =>
      fixture.effects.prepareAndAcquire(
        preparation(fixture, { requestHash: requestHash({ v: 1, probe: 'other' }) }),
      ),
    )
    expect(codeOf(reused)).toBe('task-continuation-conflict')

    // 未授权就再开一次 attempt。
    const unauthorized = await errorOf(() =>
      fixture.effects.prepareAndAcquire(preparation(fixture)),
    )
    expect(codeOf(unauthorized)).toBe('task-continuation-conflict')

    // 另一条世系抢同一把资源围栏。
    const other = await seed(harness.db)
    const conflict = await errorOf(() =>
      other.effects.prepareAndAcquire(
        preparation(other, { resourceKeys: [`w8:${fixture.taskId}`] }),
      ),
    )
    expect(codeOf(conflict)).toBe('task-execution-resource-conflict')
    fixture.reset()
    other.reset()
  })

  test('settle：succeeded 释放围栏、落 watermark，outcome-unknown 入参被拒', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))

    const rejected = await errorOf(() =>
      fixture.effects.settle({
        token: fixture.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        state: 'outcome-unknown',
        applicationEvidence: 'ambiguous',
        retryAuthority: 'none',
      }),
    )
    expect(codeOf(rejected)).toBe('task-execution-recovery-required')

    await fixture.effects.settle({
      token: fixture.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'succeeded',
      applicationEvidence: 'applied',
      retryAuthority: 'none',
      receiptJson: JSON.stringify({ v: 1, ok: true }),
    })

    const effect = (
      await db
        .select()
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, prepared.effectId))
    )[0]!
    expect(effect.state).toBe('succeeded')
    expect(JSON.parse(effect.receiptJson!)).toEqual({
      v: 1,
      appliedAttemptNo: 1,
      priorAmbiguityCount: 0,
      lastAttemptReceipt: { v: 1, ok: true },
    })
    const fences = await db
      .select()
      .from(taskExecutionEffectFences)
      .where(eq(taskExecutionEffectFences.effectAttemptId, prepared.attemptId))
    expect(fences).toHaveLength(1)
    expect(fences[0]!.releasedAt).not.toBeNull()
    const watermark = (
      await db
        .select()
        .from(taskExecutionLineageOperationRecords)
        .where(
          and(
            eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
            eq(taskExecutionLineageOperationRecords.executionLineageId, fixture.taskId),
          ),
        )
    )[0]!
    expect(watermark.highestSettledGeneration).toBe(0)
    expect(watermark.lastOutcome).toBe('succeeded')
    expect(watermark.recordRevision).toBe(1)

    // 已终态的 attempt 不能再结算一次。
    const again = await errorOf(() =>
      fixture.effects.settle({
        token: fixture.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        state: 'succeeded',
        applicationEvidence: 'applied',
        retryAuthority: 'none',
      }),
    )
    expect(again).toBeInstanceOf(Error)
    fixture.reset()
  })

  test('settle：recovery-required 保留围栏并留在未结算集合里', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    await fixture.effects.settle({
      token: fixture.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'recovery-required',
      applicationEvidence: 'ambiguous',
      retryAuthority: 'none',
      failureCode: 'w8-threw',
      receiptJson: JSON.stringify({ v: 1, error: 'boom' }),
    })
    const attempt = (
      await db
        .select()
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.id, prepared.attemptId))
    )[0]!
    expect(attempt.state).toBe('recovery-required')
    expect(attempt.settledAt).toBeNull()
    expect(attempt.failureCode).toBe('w8-threw')
    const fences = await db
      .select()
      .from(taskExecutionEffectFences)
      .where(eq(taskExecutionEffectFences.effectAttemptId, prepared.attemptId))
    expect(fences[0]!.releasedAt).toBeNull()
    expect(await fixture.effects.unresolvedEffectIds(fixture.taskId)).toEqual([prepared.effectId])
    expect(await fixture.effects.unreapedProcessCode(fixture.taskId)).toBeNull()
    fixture.reset()
  })

  test('settle：陈旧 token 被 owner 围栏拒绝', async () => {
    const fixture = await seed(harness.db)
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    const fenced = await errorOf(() =>
      fixture.effects.settle({
        token: foreignToken(fixture),
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        state: 'succeeded',
        applicationEvidence: 'applied',
        retryAuthority: 'none',
      }),
    )
    expect(codeOf(fenced)).toBe('task-execution-stale-owner')
    fixture.reset()
  })

  test('settle：receipt 超过 64 KiB 被拒且整笔回滚', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    const oversized = JSON.stringify({ v: 1, blob: 'x'.repeat(70 * 1024) })
    const rejected = await errorOf(() =>
      fixture.effects.settle({
        token: fixture.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        state: 'succeeded',
        applicationEvidence: 'applied',
        retryAuthority: 'none',
        receiptJson: oversized,
      }),
    )
    expect(rejected).toBeInstanceOf(Error)
    const attempt = (
      await db
        .select()
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.id, prepared.attemptId))
    )[0]!
    expect(attempt.state).toBe('acting')
    fixture.reset()
  })

  test('settleCodeHostNode：投影输出并按事务内 CAS 迁移 node_run', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    const finishedAt = Date.now()
    await fixture.effects.settleCodeHostNode({
      settlement: {
        token: fixture.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        state: 'succeeded',
        applicationEvidence: 'applied',
        retryAuthority: 'none',
        receiptJson: JSON.stringify({ v: 1, pr: 12 }),
      },
      projection: {
        nodeRunId: fixture.runId,
        status: 'done',
        reason: 'w8-code-host',
        finishedAt,
        outputs: [{ portName: 'pr_url', content: 'https://example.invalid/pr/12' }],
      },
    })
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, fixture.runId)))[0]!
    expect(run.status).toBe('done')
    expect(run.finishedAt).toBe(finishedAt)
    const outputs = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, fixture.runId))
    expect(outputs.map((row) => [row.portName, row.content])).toEqual([
      ['pr_url', 'https://example.invalid/pr/12'],
    ])
    fixture.reset()
  })

  test('settleCodeHostNode：已终态的 node_run 拒绝被覆写，整笔回滚（gap 03）', async () => {
    const db = harness.db
    const fixture = await seed(db)
    await db
      .update(nodeRuns)
      .set({ status: 'failed', errorMessage: 'earlier terminal' })
      .where(eq(nodeRuns.id, fixture.runId))
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    const refused = await errorOf(() =>
      fixture.effects.settleCodeHostNode({
        settlement: {
          token: fixture.token,
          effectId: prepared.effectId,
          attemptId: prepared.attemptId,
          state: 'succeeded',
          applicationEvidence: 'applied',
          retryAuthority: 'none',
          receiptJson: JSON.stringify({ v: 1, pr: 13 }),
        },
        projection: {
          nodeRunId: fixture.runId,
          status: 'done',
          reason: 'w8-code-host-overwrite',
          finishedAt: Date.now(),
          outputs: [{ portName: 'pr_url', content: 'https://example.invalid/pr/13' }],
        },
      }),
    )
    // 合一后走两引擎共用的事务内 CAS（nodeRunLifecycleTransition），终态闸给出具名冲突码；
    // 合一前 PG 侧手写 update 只会落到 `task-continuation-stale`。
    expect(codeOf(refused)).toBe('illegal-node-run-transition')
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, fixture.runId)))[0]!
    // 终态没有被顶掉。
    expect(run.status).toBe('failed')
    expect(run.errorMessage).toBe('earlier terminal')
    // 整笔回滚：既没有落输出，effect 也没有结算。
    expect(
      await db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, fixture.runId)),
    ).toHaveLength(0)
    const effect = (
      await db
        .select()
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, prepared.effectId))
    )[0]!
    expect(effect.state).toBe('open')
    fixture.reset()
  })

  test('settleCodeHostNode：不存在的 node_run 让整笔失败（gap 03）', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    const refused = await errorOf(() =>
      fixture.effects.settleCodeHostNode({
        settlement: {
          token: fixture.token,
          effectId: prepared.effectId,
          attemptId: prepared.attemptId,
          state: 'succeeded',
          applicationEvidence: 'applied',
          retryAuthority: 'none',
        },
        projection: {
          nodeRunId: `missing_${ulid()}`,
          status: 'done',
          reason: 'w8-missing-run',
          finishedAt: Date.now(),
        },
      }),
    )
    expect(codeOf(refused)).toBe('node-run-not-found')
    const effect = (
      await db
        .select()
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, prepared.effectId))
    )[0]!
    expect(effect.state).toBe('open')
    fixture.reset()
  })

  test('settleWorkspacePreparation：任务列 / 仓库行 / 空间目录 / prep node_run 同笔落库', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    const finishedAt = Date.now()
    await fixture.effects.settleWorkspacePreparation({
      settlement: {
        token: fixture.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        state: 'succeeded',
        applicationEvidence: 'applied',
        retryAuthority: 'none',
        receiptJson: JSON.stringify({ v: 1, prepared: true }),
      },
      projection: {
        taskId: fixture.taskId,
        prepNodeRunId: fixture.prepRunId,
        finishedAt,
        task: {
          worktreePath: '/tmp/wt/w8',
          branch: `agent-workflow/${fixture.taskId}`,
          baseCommit: 'deadbeef',
          repoPath: '/tmp/repo/w8',
          repoUrl: null,
          cachedRepoId: null,
          baseBranch: 'main',
          repoCount: 1,
        },
        repositories: [
          {
            taskId: fixture.taskId,
            repoIndex: 0,
            repoPath: '/tmp/repo/w8',
            repoUrl: null,
            cachedRepoId: null,
            baseBranch: 'main',
            branch: `agent-workflow/${fixture.taskId}`,
            workingBranch: null,
            baseCommit: 'deadbeef',
            worktreePath: '/tmp/wt/w8',
            worktreeDirName: 'w8',
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
        nodePaths: ['w8-node'],
      },
    })
    const task = (await db.select().from(tasks).where(eq(tasks.id, fixture.taskId)))[0]!
    expect(task.worktreePath).toBe('/tmp/wt/w8')
    expect(task.baseCommit).toBe('deadbeef')
    const repos = await db.select().from(taskRepos).where(eq(taskRepos.taskId, fixture.taskId))
    expect(repos).toHaveLength(1)
    expect(repos[0]!.worktreeDirName).toBe('w8')
    const spaces = await db
      .select()
      .from(taskSpaceNodes)
      .where(eq(taskSpaceNodes.taskId, fixture.taskId))
    expect(spaces.map((row) => row.nodePath)).toEqual(['w8-node'])
    const prep = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, fixture.prepRunId)))[0]!
    expect(prep.status).toBe('done')
    expect(prep.finishedAt).toBe(finishedAt)
    fixture.reset()
  })

  test('settleWorkspacePreparation：prep node_run 已终态时整笔回滚', async () => {
    const db = harness.db
    const fixture = await seed(db)
    await db.update(nodeRuns).set({ status: 'failed' }).where(eq(nodeRuns.id, fixture.prepRunId))
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    const refused = await errorOf(() =>
      fixture.effects.settleWorkspacePreparation({
        settlement: {
          token: fixture.token,
          effectId: prepared.effectId,
          attemptId: prepared.attemptId,
          state: 'succeeded',
          applicationEvidence: 'applied',
          retryAuthority: 'none',
        },
        projection: {
          taskId: fixture.taskId,
          prepNodeRunId: fixture.prepRunId,
          finishedAt: Date.now(),
          task: {
            worktreePath: '/tmp/wt/rolled-back',
            branch: `agent-workflow/${fixture.taskId}`,
            baseCommit: null,
            repoPath: '/tmp/repo',
            repoUrl: null,
            cachedRepoId: null,
            baseBranch: 'main',
            repoCount: 1,
          },
          repositories: [],
          nodePaths: ['rolled-back'],
        },
      }),
    )
    expect(codeOf(refused)).toBe('illegal-node-run-transition')
    const task = (await db.select().from(tasks).where(eq(tasks.id, fixture.taskId)))[0]!
    expect(task.worktreePath).toBe('/tmp/worktree')
    expect(
      await db.select().from(taskSpaceNodes).where(eq(taskSpaceNodes.taskId, fixture.taskId)),
    ).toHaveLength(0)
    fixture.reset()
  })

  test('recordProcessSpawn：写 spawn 回执并投影到 node_run', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    await fixture.effects.recordProcessSpawn({
      token: fixture.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      nodeRunId: fixture.runId,
      pid: 4242,
      spawnBinaryPath: '/usr/local/bin/opencode',
      launchNonce: 'nonce-w8',
      runtimeParamsJson: JSON.stringify({ model: 'w8' }),
    })
    const attempt = (
      await db
        .select()
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.id, prepared.attemptId))
    )[0]!
    expect(JSON.parse(attempt.receiptJson!)).toEqual({
      v: 1,
      phase: 'spawn-receipt',
      pid: 4242,
      spawnBinaryPath: '/usr/local/bin/opencode',
      launchNonce: 'nonce-w8',
    })
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, fixture.runId)))[0]!
    expect(run.pid).toBe(4242)
    expect(run.spawnBinaryPath).toBe('/usr/local/bin/opencode')
    expect(run.spawnLaunchNonce).toBe('nonce-w8')
    expect(run.runtimeParamsJson).toBe(JSON.stringify({ model: 'w8' }))
    fixture.reset()
  })

  test('recordProcessSpawn：attempt 非 acting / node_run 不存在都被拒且不留痕', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))

    const missingRun = await errorOf(() =>
      fixture.effects.recordProcessSpawn({
        token: fixture.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        nodeRunId: `missing_${ulid()}`,
        pid: 11,
        spawnBinaryPath: '/bin/true',
        launchNonce: 'nonce-missing',
      }),
    )
    expect(codeOf(missingRun)).toBe('task-execution-stale-owner')
    const untouched = (
      await db
        .select()
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.id, prepared.attemptId))
    )[0]!
    expect(untouched.receiptJson).toBeNull()

    await fixture.effects.settle({
      token: fixture.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'succeeded',
      applicationEvidence: 'applied',
      retryAuthority: 'none',
    })
    const settledAttempt = await errorOf(() =>
      fixture.effects.recordProcessSpawn({
        token: fixture.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        nodeRunId: fixture.runId,
        pid: 12,
        spawnBinaryPath: '/bin/true',
        launchNonce: 'nonce-late',
      }),
    )
    expect(codeOf(settledAttempt)).toBe('task-execution-stale-owner')
    fixture.reset()
  })

  test('settleGateRollback：completed 结算并按成功集合改写来源 node_run', async () => {
    const db = harness.db
    const fixture = await seed(db)
    await db
      .update(nodeRuns)
      .set({ status: 'failed', errorMessage: 'superseded-by-review-rejected: earlier' })
      .where(eq(nodeRuns.id, fixture.runId))
    const prepared = await fixture.effects.prepareAndAcquire(
      preparation(fixture, { kind: 'workspace-rollback' }),
    )
    await fixture.effects.settleGateRollback({
      token: fixture.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      operationId: 'w8-gate-op',
      planDigest: 'digest-w8',
      sourceNodeRunIds: [fixture.runId],
      outcome: {
        kind: 'completed',
        rolledBack: true,
        applicationEvidence: 'applied',
        receipt: { restored: 1 },
        successfulSourceNodeRunIds: [fixture.runId],
      },
    })
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, fixture.runId)))[0]!
    expect(run.rolledBack).toBe(true)
    expect(run.errorMessage).toBe('superseded-by-review-rejected-rollback: earlier')
    const effect = (
      await db
        .select()
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, prepared.effectId))
    )[0]!
    expect(effect.state).toBe('succeeded')
    fixture.reset()
  })

  test('settleGateRollback：threw 走 recovery-required，来源行不动', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(
      preparation(fixture, { kind: 'workspace-rollback' }),
    )
    await fixture.effects.settleGateRollback({
      token: fixture.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      operationId: 'w8-gate-threw',
      planDigest: 'digest-threw',
      sourceNodeRunIds: [fixture.runId],
      outcome: { kind: 'threw', error: 'boom' },
    })
    const attempt = (
      await db
        .select()
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.id, prepared.attemptId))
    )[0]!
    expect(attempt.state).toBe('recovery-required')
    expect(attempt.failureCode).toBe('human-gate-workspace-rollback-threw')
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, fixture.runId)))[0]!
    expect(run.rolledBack ?? false).toBe(false)
    fixture.reset()
  })

  test('settleGateRollback：来源行缺失时整笔回滚', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const prepared = await fixture.effects.prepareAndAcquire(
      preparation(fixture, { kind: 'workspace-rollback' }),
    )
    const refused = await errorOf(() =>
      fixture.effects.settleGateRollback({
        token: fixture.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        operationId: 'w8-gate-missing',
        planDigest: 'digest-missing',
        sourceNodeRunIds: [fixture.runId, `missing_${ulid()}`],
        outcome: {
          kind: 'completed',
          rolledBack: true,
          applicationEvidence: 'applied',
          receipt: {},
          successfulSourceNodeRunIds: [fixture.runId],
        },
      }),
    )
    expect(codeOf(refused)).toBe('task-continuation-stale')
    const effect = (
      await db
        .select()
        .from(taskExecutionEffects)
        .where(eq(taskExecutionEffects.id, prepared.effectId))
    )[0]!
    expect(effect.state).toBe('open')
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, fixture.runId)))[0]!
    expect(run.rolledBack ?? false).toBe(false)
    fixture.reset()
  })

  test('owner 围栏：effect 写入按统一原语推进 owner revision', async () => {
    const db = harness.db
    const fixture = await seed(db)
    const before = (
      await db
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, fixture.taskId))
    )[0]!
    const prepared = await fixture.effects.prepareAndAcquire(preparation(fixture))
    const afterPrepare = (
      await db
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, fixture.taskId))
    )[0]!
    expect(afterPrepare.revision).toBe(before.revision + 1)
    await fixture.effects.settle({
      token: fixture.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'succeeded',
      applicationEvidence: 'applied',
      retryAuthority: 'none',
    })
    const afterSettle = (
      await db
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, fixture.taskId))
    )[0]!
    expect(afterSettle.revision).toBe(before.revision + 2)
    fixture.reset()
  })
})
