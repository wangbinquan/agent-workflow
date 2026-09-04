// RFC-359 W4-B1（task-execution 第一批）—— 三对逐字相同的适配器合成一份实现，两个引擎各跑一遍。
//
// 合一前 `sqlite* / postgresql*` 两份只差客户端类型（design §4「取语义正身」：以 SQLite 侧为准，
// 对拍后 PG 侧零差异）：任务总览计数（taskOverviewQuery）、分支追踪快照读取（branchTraceSnapshotReader）、
// 回滚目标投影（taskRollbackQueries）。这里锁的是合一后的行为在两个引擎上一致，且 provider 名不再出现在
// 这三份实现里。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunOutputs,
  nodeRuns,
  taskCollaborators,
  taskRepos,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { DrizzleBranchTraceSnapshotReader } from '@/modules/task-execution/infrastructure/branchTraceSnapshotReader'
import { createTaskOverviewQuery } from '@/modules/task-execution/infrastructure/taskOverviewQuery'
import { DrizzleTaskRollbackQueries } from '@/modules/task-execution/infrastructure/taskRollbackQueries'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedUser(
  db: ProviderNeutralDatabase,
  id: string,
  role: 'admin' | 'user',
): Promise<void> {
  await db
    .insert(users)
    .values({
      id,
      username: `u-${id}`,
      displayName: id,
      role,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    .onConflictDoNothing()
}

async function seedWorkflow(db: ProviderNeutralDatabase): Promise<string> {
  const id = `wf_${ulid()}`
  await db.insert(workflows).values({
    id,
    name: id,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  return id
}

async function seedTask(
  db: ProviderNeutralDatabase,
  workflowId: string,
  over: {
    readonly status:
      | 'running'
      | 'done'
      | 'failed'
      | 'awaiting_review'
      | 'awaiting_human'
      | 'pending'
    readonly ownerUserId?: string
    readonly finishedAt?: number
    readonly parentTaskId?: string
    readonly catalogVisibility?: 'public' | 'internal'
    readonly repoCount?: number
  },
): Promise<string> {
  const id = `t_${ulid()}`
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: over.status,
    inputs: '{}',
    startedAt: 1,
    ...(over.ownerUserId === undefined ? {} : { ownerUserId: over.ownerUserId }),
    ...(over.finishedAt === undefined ? {} : { finishedAt: over.finishedAt }),
    ...(over.parentTaskId === undefined ? {} : { parentTaskId: over.parentTaskId }),
    ...(over.catalogVisibility === undefined ? {} : { catalogVisibility: over.catalogVisibility }),
    ...(over.repoCount === undefined ? {} : { repoCount: over.repoCount }),
  })
  return id
}

function actorFor(userId: string, role: 'admin' | 'user') {
  return buildActor({
    user: { id: userId, username: `u-${userId}`, displayName: userId, role, status: 'active' },
    source: 'session',
  })
}

describeEachProvider('RFC-359 W4-B1 —— 任务总览计数一份实现', (harness) => {
  test('管理员看全量；普通用户只看自己 owner 或协作的任务；内部目录与子任务不计', async () => {
    const db = harness.db
    const owner = `u_${ulid()}`
    const other = `u_${ulid()}`
    await seedUser(db, owner, 'user')
    await seedUser(db, other, 'user')
    const wf = await seedWorkflow(db)
    const since = 1_000
    const mine = await seedTask(db, wf, { status: 'running', ownerUserId: owner })
    await seedTask(db, wf, { status: 'awaiting_review', ownerUserId: owner })
    await seedTask(db, wf, { status: 'done', ownerUserId: owner, finishedAt: since + 1 })
    await seedTask(db, wf, { status: 'done', ownerUserId: owner, finishedAt: since - 1 }) // 窗口外
    await seedTask(db, wf, { status: 'failed', ownerUserId: other, finishedAt: since + 5 })
    const collaborated = await seedTask(db, wf, { status: 'running', ownerUserId: other })
    await db.insert(taskCollaborators).values({
      taskId: collaborated,
      userId: owner,
      role: 'collaborator',
      addedBy: other,
      addedAt: 1,
    })
    await seedTask(db, wf, { status: 'running', ownerUserId: owner, parentTaskId: mine }) // 子任务不计
    await seedTask(db, wf, { status: 'running', ownerUserId: owner, catalogVisibility: 'internal' })

    const query = createTaskOverviewQuery(db)
    const asOwner = await query.load({ actor: actorFor(owner, 'user'), since })
    expect(asOwner).toEqual({ running: 2, awaiting: 1, done7d: 1, failed7d: 0 })
    // 管理员：running 2（mine + collaborated），awaiting 1，done 1，failed 1。
    const admin = `u_${ulid()}`
    await seedUser(db, admin, 'admin')
    const asAdmin = await query.load({ actor: actorFor(admin, 'admin'), since })
    expect(asAdmin.running).toBeGreaterThanOrEqual(2)
    expect(asAdmin.failed7d).toBeGreaterThanOrEqual(1)
    // 没有 tasks:read 权限的 actor 全零。
    const stranger = actorFor(`u_${ulid()}`, 'user')
    const noRead = { ...stranger, permissions: new Set<string>() } as unknown as typeof stranger
    expect(await query.load({ actor: noRead, since })).toEqual({
      running: 0,
      awaiting: 0,
      done7d: 0,
      failed7d: 0,
    })
  })
})

describeEachProvider('RFC-359 W4-B1 —— 分支追踪快照读取一份实现', (harness) => {
  test('读回快照、全部 run 与（经 run 关联的）输出；任务不存在返回 null', async () => {
    const db = harness.db
    const wf = await seedWorkflow(db)
    const taskId = await seedTask(db, wf, { status: 'running' })
    const runA = ulid()
    const runB = ulid()
    await db.insert(nodeRuns).values([
      { id: runA, taskId, nodeId: 'a', status: 'done', retryIndex: 0, iteration: 0 },
      {
        id: runB,
        taskId,
        nodeId: 'b',
        status: 'failed',
        retryIndex: 0,
        iteration: 1,
        parentNodeRunId: runA,
        shardKey: 'k',
        errorMessage: 'boom',
      },
    ])
    await db.insert(nodeRunOutputs).values([
      { nodeRunId: runA, portName: 'out', content: 'hello', active: true },
      { nodeRunId: runB, portName: 'out', content: 'stale', active: false },
    ])
    const reader = new DrizzleBranchTraceSnapshotReader(db)
    const snapshot = await reader.read(taskId)
    expect(snapshot?.workflowSnapshot).toBe(SNAPSHOT)
    expect([...(snapshot?.runs ?? [])].sort((a, b) => a.nodeId.localeCompare(b.nodeId))).toEqual([
      {
        id: runA,
        nodeId: 'a',
        status: 'done',
        iteration: 0,
        parentNodeRunId: null,
        shardKey: null,
        errorMessage: null,
      },
      {
        id: runB,
        nodeId: 'b',
        status: 'failed',
        iteration: 1,
        parentNodeRunId: runA,
        shardKey: 'k',
        errorMessage: 'boom',
      },
    ])
    expect(
      [...(snapshot?.outputs ?? [])].sort((a, b) => a.content.localeCompare(b.content)),
    ).toEqual([
      { nodeRunId: runA, portName: 'out', content: 'hello', active: true },
      { nodeRunId: runB, portName: 'out', content: 'stale', active: false },
    ])
    expect(await reader.read('missing')).toBeNull()
  })
})

describeEachProvider('RFC-359 W4-B1 —— 回滚目标投影一份实现', (harness) => {
  test('多仓按 repo_index 排序；无 task_repos 行时退回任务工作树；任务不存在返回 null', async () => {
    const db = harness.db
    const wf = await seedWorkflow(db)
    const multi = await seedTask(db, wf, { status: 'running', repoCount: 2 })
    await db.insert(taskRepos).values([
      {
        taskId: multi,
        repoIndex: 1,
        repoPath: '/tmp/repo-b',
        worktreePath: '/tmp/wt/b',
        worktreeDirName: 'b',
        baseBranch: 'main',
        branch: 'agent-workflow/b',
      },
      {
        taskId: multi,
        repoIndex: 0,
        repoPath: '/tmp/repo-a',
        worktreePath: '/tmp/wt/a',
        worktreeDirName: 'a',
        baseBranch: 'main',
        branch: 'agent-workflow/a',
      },
    ])
    const queries = new DrizzleTaskRollbackQueries(db)
    const target = await queries.load(multi)
    expect(target?.repositories).toEqual([
      { worktreePath: '/tmp/wt/a', worktreeDirName: 'a' },
      { worktreePath: '/tmp/wt/b', worktreeDirName: 'b' },
    ])
    expect(target?.repoCount).toBe(2)
    const single = await seedTask(db, wf, { status: 'running' })
    expect((await queries.load(single))?.repositories).toEqual([
      { worktreePath: `/tmp/worktree/${single}`, worktreeDirName: '' },
    ])
    expect(await queries.load('missing')).toBeNull()
  })
})

test('源码锁：三份实现里不再出现 provider 名，且 sqlite / postgresql 孪生已删除', () => {
  const root = resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', 'infrastructure')
  for (const file of [
    'taskOverviewQuery.ts',
    'branchTraceSnapshotReader.ts',
    'taskRollbackQueries.ts',
  ]) {
    const source = readFileSync(resolve(root, file), 'utf8')
    expect(source).toContain("from '@/db/query'")
    expect(source).not.toMatch(/DbClient|PostgresqlDatabaseClient/u)
  }
  for (const gone of [
    'sqliteTaskOverviewQuery.ts',
    'postgresqlTaskOverviewQuery.ts',
    'sqliteBranchTraceSnapshotReader.ts',
    'postgresqlBranchTraceSnapshotReader.ts',
    'sqliteTaskRollbackQueries.ts',
    'postgresqlTaskRollbackQueries.ts',
  ]) {
    expect(() => readFileSync(resolve(root, gone))).toThrow()
  }
})
