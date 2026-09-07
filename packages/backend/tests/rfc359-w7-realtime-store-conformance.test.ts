// RFC-359 W7 —— realtime 持久化端口的双引擎对拍。
//
// 为什么存在：合一前 `sqliteRealtimeStore.ts` / `postgresqlRealtimeStore.ts` 是 body 逐字节
// 相同的两份 91 行，而 `dual-provider-parity-audit-2026-09-04.md` 把这一对记成 **unverified**
// ——26 对 provider 实现里 25 对没有任何对拍。「两份一样」在合一前只是**文本**结论：没有一条
// 断言证明这套 select 在 PostgreSQL 上真能跑出同样的结果。
//
// 于是合一（`DrizzleRealtimeStore`，一份实现两个 provider 共用）连带补上这份行为取证：
// 端口的四个方法各至少一组场景，**两个引擎各跑一遍**。合一之后它锁的是「一份实现在两个引擎
// 上行为一致」；万一将来有人再把它拆回两份，这份对拍就是判据。
//
// 覆盖点按方法：
//   · findTaskAudience —— 成员 / 非成员 / 任务不存在（null 与「存在但非成员」必须可区分）。
//   · findResource —— workflow 与 workgroup 走**不同的表**（同名 id 不得串台）+ 不存在返回 null。
//   · findMemoryScope —— 带 scopeId 的资源域 + scopeId 为 NULL 的 global 域 + 不存在。
//   · listTaskEvents —— 跨 node_run 汇总、按 id 升序、`since` 是**严格**大于、别的任务的事件
//     不得混入（这条是 innerJoin 到 node_runs 的过滤，两个引擎的 join 语义在此对拍）。

import { expect, test } from 'bun:test'
import { asc } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  memories,
  nodeRunEvents,
  nodeRuns,
  taskCollaborators,
  tasks,
  users,
  workflows,
  workgroups,
} from '@/db/schema'
import { DrizzleRealtimeStore } from '@/modules/runtime-management/infrastructure/realtimeStore'
import { describeEachProvider } from './helpers/eachProvider'

async function seedUser(db: ProviderNeutralDatabase, id: string): Promise<string> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

async function seedTask(
  db: ProviderNeutralDatabase,
  options: { readonly ownerUserId: string | null },
): Promise<string> {
  const taskId = `task-${ulid()}`
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `workflow-${ulid()}`,
    workflowSnapshot: '{}',
    repoPath: '/repo',
    worktreePath: '/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    ownerUserId: options.ownerUserId,
  })
  return taskId
}

async function seedRun(db: ProviderNeutralDatabase, taskId: string): Promise<string> {
  const runId = `run-${ulid()}`
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'node-1',
    status: 'running',
    retryIndex: 0,
    startedAt: 1,
  })
  return runId
}

describeEachProvider('RFC-359 W7 —— realtime 持久化端口在两个引擎上同形', (harness) => {
  test('findTaskAudience：成员 / 非成员 / 任务不存在三态可区分', async () => {
    const db = harness.db
    const store = new DrizzleRealtimeStore(db)
    const owner = await seedUser(db, `owner-${ulid()}`)
    const member = await seedUser(db, `member-${ulid()}`)
    const stranger = await seedUser(db, `stranger-${ulid()}`)
    const taskId = await seedTask(db, { ownerUserId: owner })
    await db.insert(taskCollaborators).values({
      taskId,
      userId: member,
      role: 'collaborator',
      addedBy: owner,
      addedAt: 1,
    })

    expect(await store.findTaskAudience(taskId, member)).toEqual({
      ownerUserId: owner,
      member: true,
    })
    // 「存在但不是成员」必须仍带回 owner——调用方要靠它判 owner 直通。
    expect(await store.findTaskAudience(taskId, stranger)).toEqual({
      ownerUserId: owner,
      member: false,
    })
    // 任务不存在是 null，不是 `{ member: false }`：两者在 ACL 上不同义。
    expect(await store.findTaskAudience(`task-${ulid()}`, member)).toBeNull()
  })

  test('findTaskAudience：无 owner 的任务带回 null owner 而不是整行 null', async () => {
    const db = harness.db
    const store = new DrizzleRealtimeStore(db)
    const taskId = await seedTask(db, { ownerUserId: null })

    expect(await store.findTaskAudience(taskId, `user-${ulid()}`)).toEqual({
      ownerUserId: null,
      member: false,
    })
  })

  test('findResource：workflow 与 workgroup 各查各的表，同名 id 不串台', async () => {
    const db = harness.db
    const store = new DrizzleRealtimeStore(db)
    const owner = await seedUser(db, `owner-${ulid()}`)
    // 故意让两类资源用**同一个** id：只有真的按 type 分表查，两边结果才会不同。
    const sharedId = `res-${ulid()}`
    await db.insert(workflows).values({
      id: sharedId,
      name: 'realtime workflow',
      definition: '{}',
      ownerUserId: owner,
      visibility: 'private',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(workgroups).values({
      id: sharedId,
      name: 'realtime workgroup',
      ownerUserId: null,
      visibility: 'public',
      createdAt: 1,
      updatedAt: 1,
    })

    expect(await store.findResource('workflow', sharedId)).toEqual({
      id: sharedId,
      ownerUserId: owner,
      visibility: 'private',
    })
    expect(await store.findResource('workgroup', sharedId)).toEqual({
      id: sharedId,
      ownerUserId: null,
      visibility: 'public',
    })
    const missing = `res-${ulid()}`
    expect(await store.findResource('workflow', missing)).toBeNull()
    expect(await store.findResource('workgroup', missing)).toBeNull()
  })

  test('findMemoryScope：资源域带 scopeId，global 域的 scopeId 是 NULL', async () => {
    const db = harness.db
    const store = new DrizzleRealtimeStore(db)
    const repoMemory = `mem-${ulid()}`
    const globalMemory = `mem-${ulid()}`
    await db.insert(memories).values([
      {
        id: repoMemory,
        scopeType: 'repo',
        scopeId: 'repo-1',
        title: 'repo scoped',
        bodyMd: 'body',
        status: 'approved',
        sourceKind: 'manual',
        createdAt: 1,
      },
      {
        id: globalMemory,
        scopeType: 'global',
        scopeId: null,
        title: 'global scoped',
        bodyMd: 'body',
        status: 'approved',
        sourceKind: 'manual',
        createdAt: 1,
      },
    ])

    expect(await store.findMemoryScope(repoMemory)).toEqual({
      scopeType: 'repo',
      scopeId: 'repo-1',
    })
    expect(await store.findMemoryScope(globalMemory)).toEqual({
      scopeType: 'global',
      scopeId: null,
    })
    expect(await store.findMemoryScope(`mem-${ulid()}`)).toBeNull()
  })

  test('listTaskEvents：跨 run 汇总、id 升序、since 严格大于、别的任务不混入', async () => {
    const db = harness.db
    const store = new DrizzleRealtimeStore(db)
    const taskId = await seedTask(db, { ownerUserId: null })
    const otherTaskId = await seedTask(db, { ownerUserId: null })
    const runA = await seedRun(db, taskId)
    const runB = await seedRun(db, taskId)
    const runOther = await seedRun(db, otherTaskId)
    // id 由 autoincrement / identity 指派（两个 provider 的插入渲染都走 DEFAULT），
    // 所以按插入顺序落 id，再读回来对号入座——测试不硬编码任何 id 数值。
    await db.insert(nodeRunEvents).values([
      { nodeRunId: runA, ts: 10, kind: 'text', payload: 'a-1' },
      { nodeRunId: runB, ts: 20, kind: 'stderr', payload: 'b-1' },
      { nodeRunId: runOther, ts: 30, kind: 'text', payload: 'other-1' },
      { nodeRunId: runA, ts: 40, kind: 'error', payload: 'a-2' },
    ])
    const idByPayload = new Map(
      (
        await db
          .select({ id: nodeRunEvents.id, payload: nodeRunEvents.payload })
          .from(nodeRunEvents)
          .orderBy(asc(nodeRunEvents.id))
      ).map((row) => [row.payload, row.id]),
    )

    expect(await store.listTaskEvents(taskId, 0)).toEqual([
      { id: idByPayload.get('a-1')!, nodeRunId: runA, ts: 10, kind: 'text', payload: 'a-1' },
      { id: idByPayload.get('b-1')!, nodeRunId: runB, ts: 20, kind: 'stderr', payload: 'b-1' },
      { id: idByPayload.get('a-2')!, nodeRunId: runA, ts: 40, kind: 'error', payload: 'a-2' },
    ])
    // since 是严格大于：拿自己上次收到的最后一条 id 续订，不能把那条再发一遍。
    expect(
      (await store.listTaskEvents(taskId, idByPayload.get('a-1')!)).map((row) => row.payload),
    ).toEqual(['b-1', 'a-2'])
    expect(await store.listTaskEvents(taskId, idByPayload.get('a-2')!)).toEqual([])
    expect((await store.listTaskEvents(otherTaskId, 0)).map((row) => row.payload)).toEqual([
      'other-1',
    ])
    expect(await store.listTaskEvents(`task-${ulid()}`, 0)).toEqual([])
  })
})
