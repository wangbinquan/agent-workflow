// RFC-359 W8 —— `transitionNodeRunStatus` / `setNodeRunStatus` 的「有执行上下文」分支从
// `withOwnedTaskTx`（`dbTxSync` + inline owner CAS，bun:sqlite 独有的**同步**事务）改走中立事务原语
// （`withTaskExecutionWrite` + `fenceTaskWrite` + 中立异步 CAS）。同步事务面账本
// `platform/persistence/sqlite/taskLifecycle.ts` 4 → 2。
//
// 为什么这份用例存在（别在重构时删掉它）：
//
// 1. **它是这两处迁移的唯一双引擎判据。** 迁移前这条分支在 PostgreSQL 上根本跑不动
//    （`dbTxSync` 要的是 bun:sqlite 的同步 `db.transaction`）。同批还把 `transitionNodeRunStatus`
//    开头那条 `.get()` 预读（SQLite 独有的同步游标）换成中立形态，本函数至此两个引擎都跑得动。
//
// 2. **失败回滚那两条是本文件的核心。** 同步事务改异步，最容易错的地方就是漏 `await`：
//    围栏（`fenceTaskWrite`）先把 owner 的 `revision` +1，随后 CAS 抛错，整笔必须回滚、
//    `revision` 必须回到调用前的值。漏掉内层 `await` 时事务体会**先返回**、拒绝随后才到，
//    于是那次 `revision` bump 被提交——**SQLite 侧照样绿，只有 PG 侧才炸**（本波已实证
//    `lint:promises` 与 SQLite 单跑都放行这类漏 await）。所以这两条必须两个引擎各跑一遍，
//    且断言的是 `revision` 而不只是 node_run 的行——node_run 那侧的写压根没发生过，
//    只有 `revision` 能证明「围栏确实写了，然后被回滚了」。
//
// 3. 围栏不命中（owner 已被撤销）必须抛 `task-execution-stale-owner`，且一格不写。
//    合一前后同一个错误码；消息文本从「mutation was fenced by a newer owner」变成
//    「mutation was fenced」，全仓无断言依赖该文本。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionOwners, tasks, workflows } from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import {
  canonicalJson,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import {
  setNodeRunStatus,
  transitionNodeRunStatus,
} from '@/platform/persistence/sqlite/taskLifecycle'
import { describeEachProvider } from './helpers/eachProvider'

/** 断言拒绝的是**错误码**而不是消息文本：消息在合一中改过措辞，码没变。 */
async function expectRejectionCode(run: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await run
  } catch (err) {
    thrown = err
  }
  expect((thrown as { code?: string } | undefined)?.code).toBe(code)
}

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
      operationGeneration: 1,
    },
    payload: { v: 1 },
  }
}

async function seedClaimedTask(db: ProviderNeutralDatabase, runStatus: 'pending' | 'done') {
  const taskId = `w8nrl_${ulid()}`
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-w8-node-run-lifecycle',
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
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'worker',
    status: runStatus,
    retryIndex: 0,
    iteration: 0,
  })
  const persistence = createTaskExecutionPersistence(db)
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `gen-${ulid()}`,
    persistence,
  })
  const intentId = `intent_${ulid()}`
  await persistence.intents.submit({ request: continuation(taskId), intentId })
  const claimed = await module.claimPersisted({ intentId })
  module.claimGate.leave(claimed.permit)
  const context = createTaskExecutionContext({ intentId, token: claimed.token, persistence })
  return { taskId, runId, persistence, context }
}

async function statusOf(db: ProviderNeutralDatabase, runId: string): Promise<string | undefined> {
  const rows = await db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, runId))
    .limit(1)
  return rows[0]?.status
}

async function ownerRevisionOf(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<number | undefined> {
  const rows = await db
    .select({ revision: taskExecutionOwners.revision })
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, taskId))
    .limit(1)
  return rows[0]?.revision
}

/** 把 owner 打成 `revoked`：token CAS 要求 `state='claimed'`，于是围栏必然不命中。 */
async function revokeOwner(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  await db
    .update(taskExecutionOwners)
    .set({ state: 'revoked' })
    .where(eq(taskExecutionOwners.taskId, taskId))
}

describeEachProvider('RFC-359 W8 —— node_run 生命周期写事务中立化（taskLifecycle 4 → 2）', (h) => {
  // ── transitionNodeRunStatus（原 :180 的 withOwnedTaskTx）─────────────────────
  test('transitionNodeRunStatus：围栏命中则 CAS 落库，且 owner revision 在同一笔里被推进', async () => {
    const s = await seedClaimedTask(h.db, 'pending')
    const before = await ownerRevisionOf(h.db, s.taskId)

    const moved = await transitionNodeRunStatus({
      db: h.db,
      nodeRunId: s.runId,
      event: { kind: 'mark-running' },
      extra: { startedAt: Date.now() },
      executionContext: s.context,
    })

    expect(moved).toEqual({ from: 'pending', to: 'running' })
    expect(await statusOf(h.db, s.runId)).toBe('running')
    // 围栏与 CAS 同在一笔事务里：revision 前进了，才说明 owner CAS 真的执行过。
    expect(await ownerRevisionOf(h.db, s.taskId)).toBe((before ?? 0) + 1)
  })

  test('transitionNodeRunStatus：CAS 抛错时整笔回滚——围栏推进的 revision 必须一并撤销', async () => {
    // 终态行 + mark-running ⇒ 共享转移表直接抛（`nextNodeRunStatus`：cur is terminal）。
    // 抛点在围栏**之后**，所以这条同时锁住「回滚覆盖围栏那次写」。
    const s = await seedClaimedTask(h.db, 'done')
    const before = await ownerRevisionOf(h.db, s.taskId)

    await expect(
      transitionNodeRunStatus({
        db: h.db,
        nodeRunId: s.runId,
        event: { kind: 'mark-running' },
        executionContext: s.context,
      }),
    ).rejects.toThrow()

    expect(await statusOf(h.db, s.runId)).toBe('done')
    // 漏掉内层 await 时，事务体会先返回、拒绝随后才到 ⇒ 这次 bump 被提交，本条在 PG 上变红。
    expect(await ownerRevisionOf(h.db, s.taskId)).toBe(before)
  })

  test('transitionNodeRunStatus：owner 被撤销后围栏拒绝，node_run 一格不动', async () => {
    const s = await seedClaimedTask(h.db, 'pending')
    await revokeOwner(h.db, s.taskId)

    await expectRejectionCode(
      transitionNodeRunStatus({
        db: h.db,
        nodeRunId: s.runId,
        event: { kind: 'mark-running' },
        executionContext: s.context,
      }),
      'task-execution-stale-owner',
    )

    expect(await statusOf(h.db, s.runId)).toBe('pending')
  })

  // ── setNodeRunStatus（原 :325 的 withOwnedTaskTx）───────────────────────────
  test('setNodeRunStatus：围栏命中则显式 to/allowedFrom 的 CAS 落库，revision 同笔推进', async () => {
    const s = await seedClaimedTask(h.db, 'pending')
    const before = await ownerRevisionOf(h.db, s.taskId)

    const moved = await setNodeRunStatus({
      db: h.db,
      nodeRunId: s.runId,
      to: 'running',
      allowedFrom: ['pending'],
      extra: { startedAt: Date.now() },
      reason: 'w8-neutral-transaction',
      executionContext: s.context,
    })

    expect(moved).toEqual({ from: 'pending', to: 'running' })
    expect(await statusOf(h.db, s.runId)).toBe('running')
    expect(await ownerRevisionOf(h.db, s.taskId)).toBe((before ?? 0) + 1)
  })

  test('setNodeRunStatus：allowedFrom 不含当前状态时整笔回滚——revision 必须一并撤销', async () => {
    const s = await seedClaimedTask(h.db, 'pending')
    const before = await ownerRevisionOf(h.db, s.taskId)

    await expectRejectionCode(
      setNodeRunStatus({
        db: h.db,
        nodeRunId: s.runId,
        to: 'done',
        allowedFrom: ['running'], // 当前是 pending ⇒ illegal-node-run-transition
        reason: 'w8-rollback-probe',
        executionContext: s.context,
      }),
      'illegal-node-run-transition',
    )

    expect(await statusOf(h.db, s.runId)).toBe('pending')
    expect(await ownerRevisionOf(h.db, s.taskId)).toBe(before)
  })

  test('setNodeRunStatus：owner 被撤销后围栏拒绝，node_run 一格不动', async () => {
    const s = await seedClaimedTask(h.db, 'pending')
    await revokeOwner(h.db, s.taskId)

    await expectRejectionCode(
      setNodeRunStatus({
        db: h.db,
        nodeRunId: s.runId,
        to: 'running',
        allowedFrom: ['pending'],
        executionContext: s.context,
      }),
      'task-execution-stale-owner',
    )

    expect(await statusOf(h.db, s.runId)).toBe('pending')
  })
})
