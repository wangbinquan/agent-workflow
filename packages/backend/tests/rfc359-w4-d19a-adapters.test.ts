// RFC-359 W4-D19a —— 工作组任务房的两个「事务内参与者」合一：Collaboration 那一半（反问投影 / 关闭未决自问）
// 与 TaskExecution 那一半（继续 / 失败任务）各只剩一份实现，两个 provider 共用；同批把 TaskExecution 的
// 无主写入围栏去重（`assertPostgresqlTaskOwnerlessTx` 与中立的 `assertTaskOwnerlessTx` 逐字重复）。
//
// 同一段断言在两个引擎上各跑一遍：反问投影按 asker 聚合并带上 stop 指令、未决自问被 CAS 关闭且回出 park、
// 无主围栏只对活着的（claimed）owner 拒绝；附源码锁。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  clarifyRounds,
  nodeRuns,
  taskExecutionOwners,
  taskNodeClarifyDirectives,
  tasks,
  workflows,
} from '@/db/schema'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { assertTaskOwnerlessTx } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const taskId = ulid()
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: `rfc359-d19a-${workflowId.slice(-8).toLowerCase()}`,
    definition: '{}',
    builtin: true,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc359 d19a room participants',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: T0,
    workgroupId: 'wg-rfc359-d19a',
    workgroupConfigJson: JSON.stringify({ members: [{ memberType: 'agent' }] }),
  })
  return taskId
}

async function seedSelfClarify(
  db: ProviderNeutralDatabase,
  input: {
    readonly taskId: string
    readonly id: string
    readonly askingNodeRunId: string
    readonly askingShardKey: string | null
    readonly status: 'awaiting_human' | 'answered'
  },
): Promise<void> {
  await db.insert(clarifyRounds).values({
    id: input.id,
    taskId: input.taskId,
    kind: 'self',
    askingNodeId: '__wg_member__',
    askingNodeRunId: input.askingNodeRunId,
    askingShardKey: input.askingShardKey,
    intermediaryNodeId: '__wg_member__',
    intermediaryNodeRunId: input.askingNodeRunId,
    questionsJson: '[]',
    status: input.status,
    createdAt: T0,
  })
}

/** clarify_rounds 的 asking / intermediary 两列都外键到 node_runs，先把承载行落下。 */
async function seedNodeRun(
  db: ProviderNeutralDatabase,
  input: { readonly taskId: string; readonly id: string; readonly shardKey: string | null },
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: input.id,
    taskId: input.taskId,
    nodeId: '__wg_member__',
    shardKey: input.shardKey,
    status: 'awaiting_human',
    startedAt: T0,
  })
}

async function seedOwner(
  db: ProviderNeutralDatabase,
  taskId: string,
  state: 'claimed' | 'released' | 'revoked' | 'recovery-required',
): Promise<void> {
  await db.insert(taskExecutionOwners).values({
    taskId,
    ownerId: `owner-${taskId}`,
    daemonGeneration: 'gen-1',
    epoch: 1,
    state,
    leaseUntil: T0 + 60_000,
    revision: 1,
    lastHeartbeatAt: T0,
    updatedAt: T0,
  })
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? '<no-code>'
  }
}

describeEachProvider('RFC-359 W4-D19a —— 任务房事务内参与者', (harness) => {
  test('反问投影：按 asker 列出未决自问，并带上该任务的 stop 指令', async () => {
    const taskId = await seedTask(harness.db)
    await seedNodeRun(harness.db, { taskId, id: 'asking-run-a', shardKey: 'asg:a' })
    await seedNodeRun(harness.db, { taskId, id: 'asking-run-b', shardKey: null })
    await seedNodeRun(harness.db, { taskId, id: 'asking-run-c', shardKey: null })
    await seedSelfClarify(harness.db, {
      taskId,
      id: `round-open-a-${taskId}`,
      askingNodeRunId: 'asking-run-a',
      askingShardKey: 'asg:a',
      status: 'awaiting_human',
    })
    await seedSelfClarify(harness.db, {
      taskId,
      id: `round-open-b-${taskId}`,
      askingNodeRunId: 'asking-run-b',
      askingShardKey: null,
      status: 'awaiting_human',
    })
    // 已回答的那轮不进投影。
    await seedSelfClarify(harness.db, {
      taskId,
      id: `round-answered-${taskId}`,
      askingNodeRunId: 'asking-run-c',
      askingShardKey: null,
      status: 'answered',
    })
    // 投影只收「按 asker」的 stop（shardKey 非空）；任务级的那条（空 shardKey）由别处判定，不进这张投影。
    await harness.db.insert(taskNodeClarifyDirectives).values({
      taskId,
      nodeId: '__wg_member__',
      shardKey: 'asg:a',
      directive: 'stop',
      updatedAt: T0 + 1,
    })
    await harness.db.insert(taskNodeClarifyDirectives).values({
      taskId,
      nodeId: '__wg_member__',
      shardKey: '',
      directive: 'stop',
      updatedAt: T0 + 1,
    })

    const participant = composeWorkgroupTaskRoomClarifyParticipantFactory()
    const projection = await harness.session.transaction((tx) =>
      participant.inTransaction(tx).loadProjection(taskId),
    )
    expect([...projection.askingNodeRunIds].sort()).toEqual(['asking-run-a', 'asking-run-b'])
    expect(projection.stopDirectives).toEqual([
      { nodeId: '__wg_member__', shardKey: 'asg:a', directive: 'stop' },
    ])
  })

  test('关闭未决自问：CAS 只动 awaiting_human 的行，回出 park 供调用方收尾；重放不再关第二次', async () => {
    const taskId = await seedTask(harness.db)
    await seedNodeRun(harness.db, { taskId, id: 'asking-run-a', shardKey: 'asg:a' })
    await seedNodeRun(harness.db, { taskId, id: 'asking-run-b', shardKey: null })
    await seedSelfClarify(harness.db, {
      taskId,
      id: `round-open-${taskId}`,
      askingNodeRunId: 'asking-run-a',
      askingShardKey: 'asg:a',
      status: 'awaiting_human',
    })
    await seedSelfClarify(harness.db, {
      taskId,
      id: `round-answered-${taskId}`,
      askingNodeRunId: 'asking-run-b',
      askingShardKey: null,
      status: 'answered',
    })

    const participant = composeWorkgroupTaskRoomClarifyParticipantFactory()
    const dismissed = await harness.session.transaction((tx) =>
      participant.inTransaction(tx).dismissOpenSelfClarifies({ taskId, occurredAt: T0 + 5 }),
    )
    expect(dismissed.dismissedSessions).toBe(1)
    expect(dismissed.parks.map((park) => park.nodeRunId)).toEqual(['asking-run-a'])
    const rows = await harness.db
      .select({ id: clarifyRounds.id, status: clarifyRounds.status })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.taskId, taskId))
    expect(rows.filter((row) => row.status === 'canceled').map((row) => row.id)).toEqual([
      `round-open-${taskId}`,
    ])
    expect(rows.filter((row) => row.status === 'answered')).toHaveLength(1)

    const replay = await harness.session.transaction((tx) =>
      participant.inTransaction(tx).dismissOpenSelfClarifies({ taskId, occurredAt: T0 + 6 }),
    )
    expect(replay.dismissedSessions).toBe(0)
    expect(replay.parks).toEqual([])
  })

  test('无主写入围栏：只有活着的 owner 拒绝，其余三种状态与无 owner 行都放行', async () => {
    const claimed = await seedTask(harness.db)
    await seedOwner(harness.db, claimed, 'claimed')
    expect(
      await codeOf(() => harness.session.transaction((tx) => assertTaskOwnerlessTx(tx, claimed))),
    ).toBe('task-execution-stale-owner')

    for (const state of ['released', 'revoked', 'recovery-required'] as const) {
      const taskId = await seedTask(harness.db)
      await seedOwner(harness.db, taskId, state)
      expect(
        await codeOf(() => harness.session.transaction((tx) => assertTaskOwnerlessTx(tx, taskId))),
        state,
      ).toBe('<no-throw>')
    }
    const ownerless = await seedTask(harness.db)
    expect(
      await codeOf(() => harness.session.transaction((tx) => assertTaskOwnerlessTx(tx, ownerless))),
    ).toBe('<no-throw>')
  })
})

test('源码锁：两个参与者没有 provider 命名的孪生，无主围栏只有一份定义', () => {
  const src = join(import.meta.dir, '..', 'src')
  for (const retired of [
    'modules/collaboration/infrastructure/sqliteWorkgroupTaskRoomClarifyParticipant.ts',
    'modules/collaboration/infrastructure/postgresqlWorkgroupTaskRoomClarifyParticipant.ts',
    'modules/task-execution/infrastructure/postgresqlWorkgroupTaskRoomTaskParticipant.ts',
  ]) {
    expect(existsSync(join(src, retired)), retired).toBe(false)
  }
  for (const neutral of [
    'modules/collaboration/infrastructure/workgroupTaskRoomClarifyParticipant.ts',
    'modules/collaboration/composition/workgroupTaskRoomClarify.ts',
    'modules/task-execution/infrastructure/workgroupTaskRoomTaskParticipant.ts',
    'modules/task-execution/composition/workgroupTaskRoomTask.ts',
  ]) {
    const source = readFileSync(join(src, neutral), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n')
    expect(source, neutral).not.toMatch(
      /PostgresqlDatabaseClient|\bDbClient\b|\bdbTxSync\b|DbTxSync/,
    )
    expect(source, neutral).not.toMatch(
      /createSqlite|createPostgresql|composeSqlite|composePostgresql/,
    )
  }
  // 无主围栏此前在 PG 事务模块里有一份逐字重复；现在只剩中立模块这一份定义。
  const lifecycle = readFileSync(
    join(src, 'modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction.ts'),
    'utf8',
  )
  expect(lifecycle).not.toContain('assertPostgresqlTaskOwnerlessTx')
  const owned = readFileSync(
    join(src, 'modules/task-execution/infrastructure/ownedTaskExecution.ts'),
    'utf8',
  )
  expect(owned).toContain('export async function assertTaskOwnerlessTx(')
})
