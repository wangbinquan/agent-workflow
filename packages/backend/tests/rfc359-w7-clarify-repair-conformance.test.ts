// RFC-359 W7 —— `ClarifyRepairParticipant`（RFC-057 S3 修复的协作侧事实面）双引擎对拍。
//
// 这条测试存在的理由：合一前 `sqliteClarifyRepairParticipant.ts` /
// `postgresqlClarifyRepairParticipant.ts` 是零功能分叉的两份复制，而**只有 PG 那份有生产调用方**
// （`task-execution/composition/providerRuntime.ts`）——SQLite 那份的行为从来没有被任何生产路径
// 验证过。合一成一份中立实现之后，同一段断言在两个引擎上各跑一遍。
//
// 覆盖：hasOpenForNodeRun（开启态判定 + kind/task/run 的三重限定）、
// latestClosedForNodeRun（封存态取最新一条、createdAt 相同时按 id 降序、awaiting_human 不入选、
// 没有封存轮次时为 null）、reopen（CAS 只吃 expectedStatus、清空作答字段、二次落空、不越界）。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { clarifyRounds, nodeRuns, tasks, workflows } from '@/db/schema'
import { createClarifyRepairParticipant } from '@/modules/collaboration/infrastructure/clarifyRepairParticipant'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const id = `t_w7c_${ulid()}`
  const workflowId = `wf_w7c_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: 1,
  })
  return id
}

async function seedRun(db: ProviderNeutralDatabase, taskId: string): Promise<string> {
  const id = `nr_w7c_${ulid()}`
  await db
    .insert(nodeRuns)
    .values({ id, taskId, nodeId: '__wg_clarify__', status: 'awaiting_human' })
  return id
}

interface RoundSeed {
  readonly id?: string
  readonly kind?: 'self' | 'cross'
  readonly status?: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned'
  readonly createdAt?: number
  readonly answersJson?: string | null
  readonly answeredAt?: number | null
}

async function seedRound(
  db: ProviderNeutralDatabase,
  taskId: string,
  nodeRunId: string,
  seed: RoundSeed = {},
): Promise<string> {
  const id = seed.id ?? `cr_w7c_${ulid()}`
  await db.insert(clarifyRounds).values({
    id,
    taskId,
    kind: seed.kind ?? 'self',
    askingNodeId: '__wg_leader__',
    askingNodeRunId: nodeRunId,
    askingShardKey: null,
    intermediaryNodeId: '__wg_clarify__',
    intermediaryNodeRunId: nodeRunId,
    loopIter: 0,
    iteration: 0,
    questionsJson: '[]',
    answersJson: seed.answersJson === undefined ? '[]' : seed.answersJson,
    status: seed.status ?? 'answered',
    createdAt: seed.createdAt ?? 1,
    answeredAt: seed.answeredAt === undefined ? 2 : seed.answeredAt,
  })
  return id
}

describeEachProvider('RFC-359 W7 —— 澄清修复参与者：开启态判定', (harness) => {
  test('只认 (task, self, intermediary run, awaiting_human) 全中的那一行', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    const repair = createClarifyRepairParticipant(db)

    expect(await repair.hasOpenForNodeRun({ taskId, nodeRunId: runId })).toBe(false)

    await seedRound(db, taskId, runId, { status: 'awaiting_human', answersJson: null })
    expect(await repair.hasOpenForNodeRun({ taskId, nodeRunId: runId })).toBe(true)
    expect(await repair.hasOpenForNodeRun({ taskId: 'task_other', nodeRunId: runId })).toBe(false)
    expect(await repair.hasOpenForNodeRun({ taskId, nodeRunId: 'nr_other' })).toBe(false)
  })

  test('cross 轮次不算 self 的开启态', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    await seedRound(db, taskId, runId, {
      kind: 'cross',
      status: 'awaiting_human',
      answersJson: null,
    })
    const repair = createClarifyRepairParticipant(db)
    expect(await repair.hasOpenForNodeRun({ taskId, nodeRunId: runId })).toBe(false)
  })
})

describeEachProvider('RFC-359 W7 —— 澄清修复参与者：最近一条封存轮次', (harness) => {
  test('封存态入选并取 createdAt 最新；没有封存轮次时为 null', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    const repair = createClarifyRepairParticipant(db)

    expect(await repair.latestClosedForNodeRun({ taskId, nodeRunId: runId })).toBeNull()

    // 开启态不入选：只有它在时仍然是 null。
    await seedRound(db, taskId, runId, { status: 'awaiting_human', answersJson: null })
    expect(await repair.latestClosedForNodeRun({ taskId, nodeRunId: runId })).toBeNull()

    const answered = await seedRound(db, taskId, runId, { status: 'answered', createdAt: 10 })
    expect(await repair.latestClosedForNodeRun({ taskId, nodeRunId: runId })).toEqual({
      roundId: answered,
      status: 'answered',
    })

    const canceled = await seedRound(db, taskId, runId, { status: 'canceled', createdAt: 20 })
    expect(await repair.latestClosedForNodeRun({ taskId, nodeRunId: runId })).toEqual({
      roundId: canceled,
      status: 'canceled',
    })

    // 查询的 inArray 里还列了 'abandoned'，但 `kind='self'` 下那一支在业务上不可达：
    // 迁移 0107 的 CHECK 是 `(kind='self' AND status!='abandoned') OR (kind='cross' AND
    // status!='canceled')`。这里**不**断言插入被拒——实测两个引擎在这一点上不一致（SQLite 拒，
    // PostgreSQL 的 schema 投影没带这条 CHECK 因而接受），那是迁移投影的对等缺口，不是本端口的
    // 契约面；本用例只锁两个引擎都成立的部分：self 的封存态取最新一条。
  })

  test('createdAt 打平时按 id 降序定序（两个引擎给同一个答案）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    await seedRound(db, taskId, runId, { id: 'cr_w7c_aaa', status: 'answered', createdAt: 7 })
    await seedRound(db, taskId, runId, { id: 'cr_w7c_zzz', status: 'canceled', createdAt: 7 })
    const repair = createClarifyRepairParticipant(db)
    expect(await repair.latestClosedForNodeRun({ taskId, nodeRunId: runId })).toEqual({
      roundId: 'cr_w7c_zzz',
      status: 'canceled',
    })
  })

  test('cross 轮次与别的 task / run 不入选', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    const otherRunId = await seedRun(db, taskId)
    // cross 侧用 'abandoned'：它是 inArray 里列了、但 self 侧被 0107 的 CHECK 排除的那个值，
    // 这里正好验证它也过不了 kind 限定。
    await seedRound(db, taskId, runId, { kind: 'cross', status: 'abandoned', createdAt: 99 })
    await seedRound(db, taskId, otherRunId, { status: 'answered', createdAt: 99 })
    const repair = createClarifyRepairParticipant(db)
    expect(await repair.latestClosedForNodeRun({ taskId, nodeRunId: runId })).toBeNull()
    expect(
      await repair.latestClosedForNodeRun({ taskId: 'task_other', nodeRunId: otherRunId }),
    ).toBeNull()
  })
})

describeEachProvider('RFC-359 W7 —— 澄清修复参与者：重开', (harness) => {
  test('CAS 只吃 expectedStatus；命中后清空作答字段，二次落空', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    const roundId = await seedRound(db, taskId, runId, { status: 'answered' })
    const repair = createClarifyRepairParticipant(db)

    expect(
      await repair.reopen({ taskId, roundId, expectedStatus: 'canceled', occurredAt: 3 }),
    ).toBe(false)
    expect(
      await repair.reopen({ taskId, roundId, expectedStatus: 'answered', occurredAt: 3 }),
    ).toBe(true)
    expect(
      (
        await db
          .select({
            status: clarifyRounds.status,
            answersJson: clarifyRounds.answersJson,
            answeredAt: clarifyRounds.answeredAt,
          })
          .from(clarifyRounds)
          .where(eq(clarifyRounds.id, roundId))
      )[0],
    ).toEqual({ status: 'awaiting_human', answersJson: null, answeredAt: null })

    // 已经重开过了，同一条 CAS 第二次落空。
    expect(
      await repair.reopen({ taskId, roundId, expectedStatus: 'answered', occurredAt: 4 }),
    ).toBe(false)
    expect(await repair.hasOpenForNodeRun({ taskId, nodeRunId: runId })).toBe(true)
  })

  test('别的 task 的 id、以及 cross 轮次都改不动', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const otherTaskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    const selfRound = await seedRound(db, taskId, runId, { status: 'answered' })
    const crossRound = await seedRound(db, taskId, runId, { kind: 'cross', status: 'answered' })
    const repair = createClarifyRepairParticipant(db)

    expect(
      await repair.reopen({
        taskId: otherTaskId,
        roundId: selfRound,
        expectedStatus: 'answered',
        occurredAt: 3,
      }),
    ).toBe(false)
    expect(
      await repair.reopen({
        taskId,
        roundId: crossRound,
        expectedStatus: 'answered',
        occurredAt: 3,
      }),
    ).toBe(false)
    expect(
      (
        await db
          .select({ status: clarifyRounds.status })
          .from(clarifyRounds)
          .where(eq(clarifyRounds.id, crossRound))
      )[0],
    ).toEqual({ status: 'answered' })
    expect(
      (
        await db
          .select({ status: clarifyRounds.status })
          .from(clarifyRounds)
          .where(eq(clarifyRounds.id, selfRound))
      )[0],
    ).toEqual({ status: 'answered' })
  })
})
