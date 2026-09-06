// RFC-359 W4-D24 —— 运行时会话租约合一：此前 `sqliteRuntimeSessionLeaseOperations.ts` 与
// `postgresqlRuntimeSessionLeaseOperations.ts` 各一份（归一化相似度 0.65），差别在事务原语、
// owner 围栏与驱动错误形状三处。现在只剩一份实现。
//
// 合一**没有改隔离级别**：中立会话本来就有 `serializable`（PG 抬到 SERIALIZABLE 并按 40001 重放，
// SQLite 的 BEGIN IMMEDIATE 本来就是全库独占），所以 `withTaskExecutionSerializable` 两边各取所需。
//
// 这套断言两个引擎各跑一遍租约的核心判据，重点是 plan.md 里点名要补的那一条：
// **并发 claimNew 恰好一个成功、另一个是 owner-conflict**——它防重复认领靠的是主键
// `(protocol, session_id)` + 能力矩阵的唯一冲突映射，不是靠隔离级别。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, workflows } from '@/db/schema'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { describeEachProvider } from './helpers/eachProvider'

const DIGEST = 'a'.repeat(64)

async function seedRunningRun(db: ProviderNeutralDatabase): Promise<{
  taskId: string
  nodeId: string
  runId: string
}> {
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: `wf-${workflowId}`, definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'lease task',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
  const runId = ulid()
  const nodeId = 'n1'
  await db.insert(nodeRuns).values({ id: runId, taskId, nodeId, status: 'running' })
  return { taskId, nodeId, runId }
}

describeEachProvider('RFC-359 W4-D24 —— 运行时会话租约', (harness) => {
  test('认领后租约与 node run 双向落定；同一个 session 再认领是 owner-conflict', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const operations = createRuntimeSessionLeaseOperations(db)
    const { taskId, nodeId, runId } = await seedRunningRun(db)
    const sessionId = `sess-${ulid().slice(-8).toLowerCase()}`

    const token = await operations.claimNew({
      protocol: 'opencode',
      sessionId,
      taskId,
      nodeId,
      currentNodeRunId: runId,
      leaseNonceDigest: DIGEST,
      leasedAt: 10,
    })
    expect(token.sessionId).toBe(sessionId)
    expect(token.nodeRunId).toBe(runId)

    const lease = await operations.load('opencode', sessionId)
    expect(lease?.taskId).toBe(taskId)
    expect(lease?.leaseNodeRunId).toBe(runId)
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)).limit(1))[0]
    expect(run?.opencodeSessionId).toBe(sessionId)

    // 同一个 (protocol, sessionId) 再认领：run 已经带上 session，先撞 run-not-claimable。
    const second = await seedRunningRun(db)
    let code = '<no-throw>'
    try {
      await operations.claimNew({
        protocol: 'opencode',
        sessionId,
        taskId: second.taskId,
        nodeId: second.nodeId,
        currentNodeRunId: second.runId,
        leaseNonceDigest: DIGEST,
        leasedAt: 11,
      })
    } catch (error) {
      code = (error as { reason?: string }).reason ?? (error as Error).message
    }
    expect(code).toBe('owner-conflict')
  })

  test('并发 claimNew 恰好一个成功，另一个以 owner-conflict 收场（主键 + 冲突映射，不靠隔离级别）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const operations = createRuntimeSessionLeaseOperations(db)
    const sessionId = `race-${ulid().slice(-8).toLowerCase()}`
    const a = await seedRunningRun(db)
    const b = await seedRunningRun(db)

    const attempt = (seed: { taskId: string; nodeId: string; runId: string }, at: number) =>
      operations.claimNew({
        protocol: 'opencode',
        sessionId,
        taskId: seed.taskId,
        nodeId: seed.nodeId,
        currentNodeRunId: seed.runId,
        leaseNonceDigest: DIGEST,
        leasedAt: at,
      })

    const settled = await Promise.allSettled([attempt(a, 20), attempt(b, 21)])
    const fulfilled = settled.filter((result) => result.status === 'fulfilled')
    const rejected = settled.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      reason?: string
      message?: string
    }
    expect(reason.reason ?? reason.message).toBe('owner-conflict')

    // 落库的那一行必须与胜出者一致，不能出现半截状态。
    const lease = await operations.load('opencode', sessionId)
    expect(lease).not.toBeUndefined()
    const winner = [a, b].find((seed) => seed.taskId === lease?.taskId)
    expect(winner).not.toBeUndefined()
    const run = (
      await db
        .select()
        .from(nodeRuns)
        .where(eq(nodeRuns.id, winner?.runId ?? ''))
        .limit(1)
    )[0]
    expect(run?.opencodeSessionId).toBe(sessionId)
    const loser = [a, b].find((seed) => seed.taskId !== lease?.taskId)
    const loserRun = (
      await db
        .select()
        .from(nodeRuns)
        .where(eq(nodeRuns.id, loser?.runId ?? ''))
        .limit(1)
    )[0]
    expect(loserRun?.opencodeSessionId ?? null).toBeNull()
  })

  test('释放会清空租约的持有列，但保留行；丢弃会整行删除', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const operations = createRuntimeSessionLeaseOperations(db)
    const { taskId, nodeId, runId } = await seedRunningRun(db)
    const sessionId = `rel-${ulid().slice(-8).toLowerCase()}`
    const token = await operations.claimNew({
      protocol: 'opencode',
      sessionId,
      taskId,
      nodeId,
      currentNodeRunId: runId,
      leaseNonceDigest: DIGEST,
      leasedAt: 30,
    })

    expect(await operations.release(token)).toBe(true)
    const released = await operations.load('opencode', sessionId)
    expect(released?.leaseNodeRunId ?? null).toBeNull()
    expect(released?.leasedAt ?? null).toBeNull()

    // 已释放的 token 再释放不成立；丢弃同样要求持有列匹配。
    expect(await operations.release(token)).toBe(false)
    expect(await operations.discard(token)).toBe(false)
  })
})

test('源码锁：租约只剩一份实现，围栏与冲突映射都走中立原语', async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const root = resolve(import.meta.dir, '..', 'src')
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

  const leases = read('modules/task-execution/infrastructure/runtimeSessionLeaseOperations.ts')
  expect(leases).toContain('withTaskExecutionSerializable(db, async (tx)')
  expect(leases).toContain('fenceTaskWrite(tx, { taskId, now })')
  expect(leases).toContain('engine.classifyError(error)')
  // 只禁**客户端类型**与「按方言错误码分支」的代码；错误码出现在注释里是有意的
  // （注释要说清能力矩阵把哪些码归到 unique-violation）。
  expect(leases).not.toMatch(/PostgresqlDatabaseClient|\bDbClient\b/)
  expect(leases).not.toMatch(/code === '23505'|=== 'SQLITE_CONSTRAINT'/)

  expect(() =>
    read('modules/task-execution/infrastructure/sqliteRuntimeSessionLeaseOperations.ts'),
  ).toThrow()
  expect(() =>
    read('modules/task-execution/infrastructure/postgresqlRuntimeSessionLeaseOperations.ts'),
  ).toThrow()

  // 合一没有改隔离级别：中立 serializable 在两个引擎上各取所需。
  const owned = read('modules/task-execution/infrastructure/ownedTaskExecution.ts')
  expect(owned).toContain('export function withTaskExecutionSerializable')
  expect(owned).toContain('databaseSessionFor(db).serializable(body)')
})
