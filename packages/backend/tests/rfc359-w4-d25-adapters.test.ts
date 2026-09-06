// RFC-359 W4-D25 —— human-gate 停靠原子合一：此前 `sqliteHumanGateOpenParticipant.ts` /
// `postgresqlHumanGateOpenParticipant.ts`（695 / 820 行）与 `sqlite|postgresqlHumanGateTaskLifecyclePersistence.ts`
// （194 / 181 行）各一份，另有一条只给 SQLite 用的 legacy 同步停靠路（`sqliteTaskParkTransaction.ts` +
// `sqliteManualQuestionParkTransaction.ts` + `taskExecutionHumanGateAdapter.ts`）。现在只剩一份实现。
//
// 合一前 PostgreSQL 这条路几乎没有行为覆盖：RFC-333 的停靠套件全部直接 new SQLite 那几个类
// （`rfc333-task-participants.test.ts`），PG 侧只有装配被引用过。那些套件已改接中立端口，本文件再给
// **两个引擎**补一遍停靠的核心判据——澄清门停靠、无主停靠拒绝在册 owner、以及重复停靠时门操作的收场。
//
// 正典取合一前的 SQLite 语义：门操作先消费、任务再跃迁、提交后才发事件；停靠成功后 clarify round 与
// question 行一次落定，操作行走到 completed。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  clarifyRounds,
  collaborationGateOperations,
  committedEvents,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '@/db/schema'
import { ClarifyGateOpenPreparation } from '@/modules/collaboration/application/prepareClarifyGateOpen'
import { DatabaseHumanGateOperationPersistence } from '@/modules/collaboration/infrastructure/humanGateOperationPersistence'
import { DatabaseClarifyQuestionSnapshotReader } from '@/modules/collaboration/infrastructure/clarifyQuestionSnapshotReader'
import { DatabaseHumanGateTaskLifecyclePersistence } from '@/modules/task-execution/infrastructure/humanGateTaskLifecyclePersistence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_969_900_000

async function seedRunningTask(db: ProviderNeutralDatabase): Promise<string> {
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: `wf-${workflowId}`, definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'd25 park task',
    workflowId,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW - 1_000,
    lifecycleEventRevision: 1,
  })
  await db.insert(nodeRuns).values({
    id: `${taskId}-asking`,
    taskId,
    nodeId: 'writer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  return taskId
}

/** 走生产那条准备路（`ClarifyGateOpenPreparation`），拿到一个可停靠的 prepared 门。 */
async function prepareClarifyGate(db: ProviderNeutralDatabase, taskId: string) {
  const result = await new ClarifyGateOpenPreparation(
    new DatabaseHumanGateOperationPersistence(databaseSessionFor(db)),
    new DatabaseClarifyQuestionSnapshotReader(db),
  ).prepare({
    taskId,
    kind: 'self',
    askingNodeId: 'writer',
    askingNodeRunId: `${taskId}-asking`,
    askingShardKey: null,
    intermediaryNodeId: 'clarify',
    targetConsumerNodeId: null,
    parentNodeRunId: null,
    loopIter: 0,
    iteration: 0,
    questionsJson: '[{"id":"question-1","title":"Question?"}]',
    questions: [{ id: 'question-1', title: 'Question?' }],
    truncationWarningsJson: null,
    sourceSnapshotDigest: 'a'.repeat(64),
    idempotencyKey: `open:${taskId}`,
    expectedTaskRevision: 1,
    now: NOW + 1,
  })
  if (result.kind !== 'prepared') throw new Error('expected prepared clarify operation')
  return result
}

describeEachProvider('RFC-359 W4-D25 —— human-gate 停靠原子', (harness) => {
  test('无主停靠：门消费 + 任务跃迁 + 两族已提交事件在同一笔事务里落定', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedRunningTask(db)
    const opening = await prepareClarifyGate(db, taskId)

    const parked = await new DatabaseHumanGateTaskLifecyclePersistence(db).parkPrepared({
      prepared: opening.prepared,
      now: NOW + 2,
    })

    expect(parked).toMatchObject({
      taskRevision: 2,
      gateRevision: 1,
      nodeProjectionDigest: opening.manifest.nodeProjectionDigest,
      committedEventRef: opening.manifest.committedEventRef,
    })
    // 任务生命周期一条 + collaboration 开门一条。
    expect(parked.eventRefs).toHaveLength(2)

    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
    expect(task?.status).toBe('awaiting_human')
    expect(task?.lifecycleEventRevision).toBe(2)

    const operation = (
      await db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, opening.prepared.operationId))
        .limit(1)
    )[0]
    expect(operation?.state).toBe('completed')
    expect(operation?.resultGateRevision).toBe(1)

    expect(
      await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)),
    ).toHaveLength(1)
    expect(
      await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId)),
    ).toHaveLength(1)
    // 停靠新铸的 clarify node run 停在 awaiting_human。
    const parkedRun = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, opening.manifest.node.id)).limit(1)
    )[0]
    expect(parkedRun?.status).toBe('awaiting_human')

    const lifecycleEvent = (
      await db
        .select()
        .from(committedEvents)
        .where(eq(committedEvents.id, `task-lifecycle:${taskId}:2`))
        .limit(1)
    )[0]
    expect(lifecycleEvent).toMatchObject({
      producer: 'task-execution',
      family: 'task-lifecycle',
      aggregateId: taskId,
    })
  })

  test('陈旧的 taskRevision 一律拒绝停靠：任务与门操作都不动', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedRunningTask(db)
    const opening = await prepareClarifyGate(db, taskId)
    // 别人先把任务推进了一格，prepared 门上记的 expectedTaskRevision 随之陈旧。
    await db.update(tasks).set({ lifecycleEventRevision: 7 }).where(eq(tasks.id, taskId)).run()

    let failed = false
    try {
      await new DatabaseHumanGateTaskLifecyclePersistence(db).parkPrepared({
        prepared: opening.prepared,
        now: NOW + 3,
      })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)

    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
    expect(task?.status).toBe('running')
    const operation = (
      await db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, opening.prepared.operationId))
        .limit(1)
    )[0]
    // 整笔事务回滚：门操作留在 prepared，clarify 投影一行都没落。
    expect(operation?.state).toBe('prepared')
    expect(
      await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)),
    ).toHaveLength(0)
  })

  test('没有待结的手工问题时，结算是 no-op；任务状态与修订号都不动', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedRunningTask(db)

    const settled = await new DatabaseHumanGateTaskLifecyclePersistence(
      db,
    ).settleManualQuestionParks({ taskId, now: NOW + 4 })

    expect(settled).toEqual({ parked: false, taskRevision: 1, operationIds: [], eventRefs: [] })
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
    expect(task?.status).toBe('running')
    expect(task?.lifecycleEventRevision).toBe(1)
  })

  test('没有待结义务时，带守卫的 CAS 正常落定（两个引擎同一条判据）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedRunningTask(db)

    const outcome = await new DatabaseHumanGateTaskLifecyclePersistence(
      db,
    ).trySetWhenNoManualQuestionParks({
      taskId,
      to: 'done',
      allowedFrom: ['running'],
      reason: 'rfc359-d25-no-obligation',
      now: NOW + 5,
    })

    expect(outcome).toEqual({ kind: 'settled', won: true })
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]?.status).toBe(
      'done',
    )
  })
})

test('源码锁：停靠只剩一份实现，legacy 同步停靠路与 provider 命名文件都已退役', async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const root = resolve(import.meta.dir, '..', 'src')
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

  const lifecycle = read(
    'modules/task-execution/infrastructure/humanGateTaskLifecyclePersistence.ts',
  )
  expect(lifecycle).toContain('withTaskExecutionSerializable(this.db, async (tx)')
  expect(lifecycle).toContain('transitionHumanGateTask(tx, {')
  // 围栏挪进了同一笔事务：不再有「库外预读 owner，再另开事务写」的窗口。
  expect(lifecycle).toContain('assertTaskOwnerlessTx(tx, taskId)')
  expect(lifecycle).toContain('assertTaskOwnerTx(tx, token, now)')
  // 只禁**客户端 / 同步事务类型**；`dbTxSync` 出现在注释里是有意的（要说清合一前两侧差在哪）。
  expect(lifecycle).not.toMatch(/PostgresqlDatabaseClient|\bDbTxSync\b/)

  const participant = read('modules/collaboration/infrastructure/humanGateOpenParticipant.ts')
  // 记账走中立 journal，不再各写一套 commit / complete。
  expect(participant).toContain('this.journal.commitTx({')
  expect(participant).toContain('this.journal.completeTx({')
  // 事务类型只认中立句柄；`DbTxSync` 出现在注释里是有意的（要说清合一前 SQLite 那份是同步的）。
  expect(participant).toContain('tx: DatabaseTransaction')
  expect(participant).not.toMatch(/: DbTxSync|PostgresqlCommittedEventTransaction/)

  for (const retired of [
    'modules/collaboration/infrastructure/sqliteHumanGateOpenParticipant.ts',
    'modules/collaboration/infrastructure/postgresqlHumanGateOpenParticipant.ts',
    'modules/collaboration/composition/taskExecutionHumanGateAdapter.ts',
    'modules/task-execution/infrastructure/sqliteHumanGateTaskLifecyclePersistence.ts',
    'modules/task-execution/infrastructure/postgresqlHumanGateTaskLifecyclePersistence.ts',
    'modules/task-execution/infrastructure/sqliteTaskParkTransaction.ts',
    'modules/task-execution/infrastructure/sqliteManualQuestionParkTransaction.ts',
    'modules/task-execution/application/ports/humanGateOpenParticipant.ts',
  ]) {
    expect(() => read(retired)).toThrow()
  }

  // 两个 bootstrap 装的是同一份停靠原子。
  expect(read('modules/task-execution/composition/taskExecutionPersistence.ts')).toContain(
    'new DatabaseHumanGateTaskLifecyclePersistence(db)',
  )
  // legacy 服务的停靠入口也落到同一份，不再有第二条同步路。
  expect(read('modules/task-execution/composition/humanGate.ts')).toContain(
    'parkTaskAtHumanGate(new DatabaseHumanGateTaskLifecyclePersistence(input.db)',
  )
})
