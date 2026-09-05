// RFC-359 W4-B1 批 2f —— 三对合一，两个引擎各跑一遍：node run 执行投影（产品里最热的写路径：统一写事务 +
// owner 围栏 + 能力矩阵的聚合根行锁）、任务列表页的客户端绑定、任务目录源装配（两对薄壳）。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  taskExecutionOwners,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import type { TaskExecutionContextRef } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createOwnershipToken,
  createWorkerIdentity,
  type OwnershipToken,
} from '@/modules/task-execution/domain/ownership'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import {
  composeTaskExecutionCatalogSources,
  createDatabaseTaskExecutionCatalogSourceFactory,
} from '@/modules/task-execution/infrastructure/taskCatalogSources'
import {
  createDatabaseTaskListPage,
  taskListViewerOf,
} from '@/modules/task-execution/infrastructure/taskListPage'
import {
  composePostgresqlOwnerIdentityQueries,
  composeSqliteOwnerIdentityQueries,
} from '@/modules/identity-access/composition/providerOperations'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
const OWNER = 'u_b2f_owner'

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const id = `t_${ulid()}`
  const workflowId = `wf_${ulid()}`
  await db
    .insert(users)
    .values({
      id: OWNER,
      username: `u-${OWNER}`,
      displayName: OWNER,
      role: 'admin',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    .onConflictDoNothing()
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
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    ownerUserId: OWNER,
  })
  return id
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  over: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    ...over,
  })
  return id
}

async function seedClaimedOwner(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<{ token: OwnershipToken; context: TaskExecutionContextRef }> {
  const identity = createWorkerIdentity({ ownerId: `owner_${ulid()}`, daemonGeneration: 'gen-a' })
  await db.insert(taskExecutionOwners).values({
    taskId,
    ownerId: identity.ownerId,
    daemonGeneration: identity.daemonGeneration,
    epoch: 1,
    state: 'claimed',
    leaseUntil: Date.now() + 60_000,
    revision: 1,
    lastHeartbeatAt: Date.now(),
    updatedAt: Date.now(),
  })
  const token = createOwnershipToken({
    taskId,
    identity,
    epoch: 1,
    leaseUntil: Date.now() + 60_000,
    ownerRevision: 1,
  })
  const context = createTaskExecutionContext({
    intentId: `intent_${ulid()}`,
    token,
    persistence: createTaskExecutionPersistence(db),
  })
  return { token, context }
}

function ownerIdentityQueriesFor(db: ProviderNeutralDatabase) {
  const provider = databaseSessionFor(db).engine.provider
  if (provider === 'sqlite') {
    return composeSqliteOwnerIdentityQueries(
      db as Parameters<typeof composeSqliteOwnerIdentityQueries>[0],
    )
  }
  if (provider === 'postgresql') {
    return composePostgresqlOwnerIdentityQueries(
      db as Parameters<typeof composePostgresqlOwnerIdentityQueries>[0],
    )
  }
  return unhandledDatabaseProvider(provider)
}

describeEachProvider('RFC-359 W4-B1 批 2f —— node run 执行投影', (harness) => {
  test('读：快照 / 按 frame 列 / 输出 / 事件计数 / stderr 拼接', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    const nested = await seedRun(db, taskId, { containerRunId: runId, parentNodeRunId: runId })
    const persistence = new DrizzleNodeExecutionPersistence(db)
    expect((await persistence.read(runId))?.id).toBe(runId)
    expect(await persistence.read('missing')).toBeNull()
    expect((await persistence.list({ taskId, containerRunId: null })).map((run) => run.id)).toEqual(
      [runId],
    )
    expect((await persistence.list({ taskId, childOnly: true })).map((run) => run.id)).toEqual([
      nested,
    ])
    await db.insert(nodeRunEvents).values([
      { nodeRunId: runId, ts: 1, kind: 'text', payload: '[rfc-audit] framework line' },
      { nodeRunId: runId, ts: 2, kind: 'text', payload: 'agent line' },
      { nodeRunId: runId, ts: 3, kind: 'stderr', payload: 'err-1' },
      { nodeRunId: runId, ts: 4, kind: 'stderr', payload: 'err-2' },
    ])
    expect(await persistence.countAgentTextEvents(runId, '[rfc-audit]')).toBe(1)
    expect(await persistence.readStderr(runId)).toBe('err-1\nerr-2')
    expect(await persistence.listOutputs(runId)).toEqual([])
  })

  test('写：patch / upsert / replace / append / retag 全走围栏，claimed owner 下无上下文被拒', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    const persistence = new DrizzleNodeExecutionPersistence(db)
    // 无 owner 行：无主写入放行；不存在的 run：patch false、其余静默。
    expect(await persistence.patch({ nodeRunId: runId, values: { errorMessage: 'e0' } })).toBe(true)
    expect(await persistence.patch({ nodeRunId: 'missing', values: { errorMessage: 'e0' } })).toBe(
      false,
    )
    await persistence.upsertOutputs({
      nodeRunId: runId,
      outputs: [
        { portName: 'b', content: 'B' },
        { portName: 'a', content: 'A' },
      ],
    })
    await persistence.upsertOutputs({
      nodeRunId: runId,
      outputs: [{ portName: 'a', content: 'A2' }],
    })
    expect(
      (await persistence.listOutputs(runId)).map((row) => [row.portName, row.content]),
    ).toEqual([
      ['a', 'A2'],
      ['b', 'B'],
    ])
    await persistence.replaceOutputs({
      nodeRunId: runId,
      outputs: [{ portName: 'c', content: 'C' }],
    })
    expect((await persistence.listOutputs(runId)).map((row) => row.portName)).toEqual(['c'])
    await persistence.appendEvents({
      nodeRunId: runId,
      events: [
        { ts: 1, kind: 'text', payload: 'p1', sessionId: 'old-1', parentSessionId: null },
        { ts: 2, kind: 'text', payload: 'p2', sessionId: 'child', parentSessionId: 'old-1' },
      ],
    })
    await persistence.appendEvent({ nodeRunId: runId, ts: 3, kind: 'stderr', payload: 'e' })
    await persistence.retagSessionEpochs({
      nodeRunId: runId,
      logicalSessionId: 'logical',
      supersededSessionIds: ['old-1'],
    })
    const events = await db
      .select({ sessionId: nodeRunEvents.sessionId, parent: nodeRunEvents.parentSessionId })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, runId))
      .orderBy(asc(nodeRunEvents.id))
    expect(events).toEqual([
      { sessionId: 'logical', parent: null },
      { sessionId: 'child', parent: 'logical' },
      { sessionId: null, parent: null },
    ])

    const { context } = await seedClaimedOwner(db, taskId)
    await expect(
      persistence.patch({ nodeRunId: runId, values: { errorMessage: 'e1' } }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    await expect(
      persistence.appendEvent({ nodeRunId: runId, ts: 9, kind: 'text', payload: 'x' }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    expect(
      await persistence.patch({
        nodeRunId: runId,
        values: { errorMessage: 'e1' },
        executionContext: context,
      }),
    ).toBe(true)
    await runWithTaskExecutionContext(context, () =>
      persistence.appendEvent({ nodeRunId: runId, ts: 9, kind: 'text', payload: 'x' }),
    )
    expect((await persistence.read(runId))?.errorMessage).toBe('e1')
    expect(await persistence.countAgentTextEvents(runId, '[rfc-audit]')).toBe(3)
    const outputs = await db
      .select({ portName: nodeRunOutputs.portName })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, runId))
    expect(outputs).toEqual([{ portName: 'c' }])
  })
})

describeEachProvider('RFC-359 W4-B1 批 2f —— 任务列表页绑定与目录源装配', (harness) => {
  test('页查询绑到任一客户端；目录源工厂 / 装配从同一份实现造出', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const owners = ownerIdentityQueriesFor(db)
    const page = createDatabaseTaskListPage(db, owners)
    const actor = buildActor({
      user: {
        id: OWNER,
        username: `u-${OWNER}`,
        displayName: OWNER,
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const listed = await page.list(taskListViewerOf(actor), { q: taskId }, {})
    expect(listed.items.map((item) => item.id)).toEqual([taskId])
    expect(createDatabaseTaskExecutionCatalogSourceFactory(db, owners)).toBeDefined()
    expect(composeTaskExecutionCatalogSources(db, owners).length).toBeGreaterThan(0)
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const infra = resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', 'infrastructure')
  for (const provider of ['sqlite', 'postgresql']) {
    expect(existsSync(resolve(infra, `${provider}NodeExecutionPersistence.ts`))).toBe(false)
    expect(existsSync(resolve(infra, `${provider}TaskCatalogSources.ts`))).toBe(false)
    expect(existsSync(resolve(infra, 'taskListPage', `${provider}.ts`))).toBe(false)
  }
})
