// RFC-359 W4-B1 批 2b —— 三对只差客户端类型 / 同步异步形态的适配器合成一份实现，两个引擎各跑一遍：
// 任务执行读模型（状态投影 / 执行结果 / 调用图工作区）、任务生命周期 WS 投影、子任务预算查询。
// 另有一条源码锁：provider 命名的孪生文件不得复活。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, workflows } from '@/db/schema'
import { DrizzleChildTaskBudgetQueries } from '@/modules/task-execution/infrastructure/childTaskBudgetQueries'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import { createDatabaseTaskLifecycleWsProjection } from '@/modules/task-execution/infrastructure/taskLifecycleWsProjection'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedTask(
  db: ProviderNeutralDatabase,
  over: Partial<typeof tasks.$inferInsert> = {},
): Promise<{ id: string; workflowId: string }> {
  const id = `t_${ulid()}`
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: `wf-name-${workflowId.slice(-6)}`,
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
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    ...over,
  })
  return { id, workflowId }
}

describeEachProvider('RFC-359 W4-B1 批 2b —— 任务执行读模型', (harness) => {
  test('状态投影：命中返回状态与错误摘要，未命中 null', async () => {
    const db = harness.db
    const { id } = await seedTask(db, { status: 'failed', errorSummary: 'boom' })
    const reads = createTaskExecutionReadModels(db)
    expect(await reads.statusProjection.find(id)).toEqual({
      taskId: id,
      status: 'failed',
      errorSummary: 'boom',
    })
    expect(await reads.statusProjection.find(`t_${ulid()}`)).toBeNull()
  })

  test('执行结果：任务行 + 该任务的 node_runs，非工作组任务 workgroup 为 null', async () => {
    const db = harness.db
    const { id } = await seedTask(db, { status: 'done', finishedAt: 2 })
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId: id,
      nodeId: 'n',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const reads = createTaskExecutionReadModels(db)
    const outcome = await reads.executionOutcome.find(id)
    expect(outcome?.task).toMatchObject({ id, status: 'done', workgroupId: null })
    expect(outcome?.workgroup ?? null).toBeNull()
    expect(outcome?.runs.map((run) => run.id)).toEqual([runId])
    expect(await reads.executionOutcome.find(`t_${ulid()}`)).toBeNull()
  })

  test('调用图工作区：无 task_repos 行时回退为单仓（任务 worktree 本身）；未命中 null', async () => {
    const db = harness.db
    const { id } = await seedTask(db)
    const reads = createTaskExecutionReadModels(db)
    expect(await reads.callGraphWorkspace.find(id)).toEqual({
      taskId: id,
      worktreePath: `/tmp/worktree/${id}`,
      repos: [{ worktreeDirName: '', worktreePath: `/tmp/worktree/${id}` }],
    })
    expect(await reads.callGraphWorkspace.find(`t_${ulid()}`)).toBeNull()
  })
})

describeEachProvider('RFC-359 W4-B1 批 2b —— 任务生命周期 WS 投影', (harness) => {
  test('findCreatedTask：左连工作流名；未命中 null', async () => {
    const db = harness.db
    const { id, workflowId } = await seedTask(db, { spaceKind: 'local', repoCount: 1 })
    const projection = createDatabaseTaskLifecycleWsProjection(db)
    expect(await projection.findCreatedTask(id)).toEqual({
      id,
      name: id,
      workflowId,
      workflowName: `wf-name-${workflowId.slice(-6)}`,
      repoPath: '/tmp/repo',
      repoUrl: null,
      cachedRepoId: null,
      status: 'running',
      startedAt: 1,
      finishedAt: null,
      errorSummary: null,
      repoCount: 1,
      spaceKind: 'local',
      sourceAgentName: null,
    })
    expect(await projection.findCreatedTask(`t_${ulid()}`)).toBeNull()
  })
})

describeEachProvider('RFC-359 W4-B1 批 2b —— 子任务预算查询', (harness) => {
  test('只计 pending / running 的子任务；父子关系按 parentTaskId 判定', async () => {
    const db = harness.db
    const { id: parent } = await seedTask(db)
    const { id: runningChild } = await seedTask(db, { parentTaskId: parent, status: 'running' })
    const { id: pendingChild } = await seedTask(db, { parentTaskId: parent, status: 'pending' })
    const { id: doneChild } = await seedTask(db, { parentTaskId: parent, status: 'done' })
    const queries = new DrizzleChildTaskBudgetQueries(db)
    const counted = await queries.listCountedChildTaskIds()
    expect(counted).toContain(runningChild)
    expect(counted).toContain(pendingChild)
    expect(counted).not.toContain(doneChild)
    expect(counted).not.toContain(parent)
    expect(await queries.isChildTask(runningChild)).toBe(true)
    expect(await queries.isChildTask(parent)).toBe(false)
    expect(await queries.isChildTask(`t_${ulid()}`)).toBe(false)
    expect(await queries.parentTaskId(doneChild)).toBe(parent)
    expect(await queries.parentTaskId(parent)).toBeNull()
    expect(await queries.parentTaskId(`t_${ulid()}`)).toBeNull()
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', 'infrastructure')
  for (const stem of [
    'TaskExecutionReadModels',
    'TaskLifecycleWsProjection',
    'ChildTaskBudgetQueries',
  ]) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(infra, `${provider}${stem}.ts`))).toBe(false)
    }
  }
})
