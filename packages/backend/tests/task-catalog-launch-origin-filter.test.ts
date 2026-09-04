// 任务列表的「启动来源」筛选：RFC-301 的 `launch_origin` 列是唯一判据。
//
// 为什么这条测试存在（用户 2026-09-04 报 PostgreSQL 上任务列表的问题时对账出来的）：
// PostgreSQL 目录源 `postgresqlTaskCatalogSources.ts` 此前把 origin 筛选**在内存里**
// 按 `item.scheduledTaskId` 是否为空猜，而不是读 `tasks.launch_origin`。三个后果全部
// 是用户可见的（SQLite 侧一直走 `launch_origin`，`services/taskOperations.ts` 的
// `launch_origin IN ('event','webhook')`，所以只有 PostgreSQL 部署中招）：
//
//   1. 界面提供的 `event` / `api` 两个选项**根本不在那段代码的分支里**，直接落到
//      `throw new ValidationError('task-page-filter-invalid')` —— 选「事件」或「API」
//      筛选就是一个 400，列表整页打不开；
//   2. 选「手动」会把 event / webhook / api 启动的任务一起返回 —— 它们的
//      `scheduled_task_id` 同样是 NULL（launch admission 明确禁止直接启动带该字段，
//      `domain/taskLaunchOrigin.ts` 的 `task-launch-direct-metadata-invalid`）；
//   3. 选「定时」会漏掉定时任务的**子任务** —— 子执行插入时带的是
//      `launchOrigin: parent.launchOrigin`、`scheduled_task_id` 留空
//      （`postgresqlChildExecutionLaunchOperations.ts:614` 的 values 里没有该列），
//      于是一个 `launch_origin='scheduled'` 的行被猜成 manual。
//
// 修法：来源→存储值的映射进 domain（`taskListOriginMatches`，单一事实源），两个
// provider 的列表查询都按它下推到 SQL；目录源只做校验与透传。

import {
  TASK_LIST_ORIGINS,
  TASK_LIST_VISIBLE_ORIGINS,
  taskListOriginMatches,
  type TaskListItem,
  type TaskListOrigin,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import type { Actor } from '@/auth/actor'
import { createInMemoryDb } from '@/db/client'
import { tasks, users, workflows } from '@/db/schema'
import { createPostgresqlTaskExecutionCatalogSourceFactory } from '@/modules/task-execution/infrastructure/postgresqlTaskCatalogSources'
import type { TaskRouteListFilters } from '@/modules/task-execution/public/taskRoutes'
import { listTaskItems } from '@/services/task'
import { ValidationError } from '@/util/errors'

describe('launch-origin filter maps to the stored column, once', () => {
  test('every list choice resolves to an explicit set of stored origins', () => {
    expect(taskListOriginMatches('all')).toBeNull()
    // RFC-310 折了 Webhook 进事件中心：历史行保留不可变的 `webhook` 事实，
    // 但归属界面上唯一的「事件」筛选。
    expect(taskListOriginMatches('event')).toEqual(['event', 'webhook'])
    for (const origin of ['manual', 'scheduled', 'webhook', 'api'] as const) {
      expect(taskListOriginMatches(origin)).toEqual([origin])
    }
  })

  test('the mapping is total over the closed choice set', () => {
    for (const origin of TASK_LIST_ORIGINS) {
      const matches = taskListOriginMatches(origin)
      if (origin === 'all') expect(matches).toBeNull()
      else expect(matches?.length ?? 0).toBeGreaterThan(0)
    }
  })
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Db = ReturnType<typeof createInMemoryDb>

/**
 * 五个根各占一种 `launch_origin`，外加一个**定时任务的子执行**——它继承父的
 * `launch_origin='scheduled'`，而 `scheduled_task_id` 留空。那一行就是旧猜法
 * 猜不对的那一行。
 */
async function seed(db: Db): Promise<void> {
  await db.insert(users).values({
    id: 'admin',
    username: 'admin',
    displayName: 'admin',
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({
    id: 'wf1',
    name: 'wf',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
  const rows: readonly {
    id: string
    origin: 'manual' | 'scheduled' | 'event' | 'webhook' | 'api'
    scheduledTaskId?: string
    parent?: string
  }[] = [
    { id: 'root-manual', origin: 'manual' },
    { id: 'root-scheduled', origin: 'scheduled', scheduledTaskId: 'sched-1' },
    { id: 'root-event', origin: 'event' },
    { id: 'root-webhook', origin: 'webhook' },
    { id: 'root-api', origin: 'api' },
    { id: 'child-of-scheduled', origin: 'scheduled', parent: 'root-scheduled' },
  ]
  let startedAt = 1_788_278_400_000
  for (const row of rows) {
    startedAt += 1
    await db.insert(tasks).values({
      id: row.id,
      name: row.id,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: `/tmp/${row.id}`,
      worktreePath: `/tmp/wt-${row.id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${row.id}`,
      status: 'done',
      inputs: '{}',
      startedAt,
      finishedAt: startedAt + 10,
      runningMs: 0,
      ownerUserId: 'admin',
      launchOrigin: row.origin,
      scheduledTaskId: row.scheduledTaskId ?? null,
      parentTaskId: row.parent ?? null,
      invocationDepth: row.parent === undefined ? 0 : 1,
      branchStartedAt: startedAt,
      rootTaskId: row.parent ?? row.id,
    })
  }
}

async function idsFor(db: Db, origin: TaskListOrigin | undefined): Promise<string[]> {
  const items = await listTaskItems(db, origin === undefined ? {} : { origin })
  return items.map((item) => item.id).sort()
}

describe('list queries select rows by launch_origin, not by scheduled_task_id', () => {
  test('each choice returns exactly its own rows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)

    expect(await idsFor(db, undefined)).toEqual(
      [
        'child-of-scheduled',
        'root-api',
        'root-event',
        'root-manual',
        'root-scheduled',
        'root-webhook',
      ].sort(),
    )
    expect(await idsFor(db, 'all')).toEqual(await idsFor(db, undefined))

    // (2) 手动只回手动那一行。旧猜法在这里会把 event / webhook / api 一起交出来。
    expect(await idsFor(db, 'manual')).toEqual(['root-manual'])

    // (3) 定时含继承来源的子执行。旧猜法看 scheduled_task_id，会漏掉它。
    expect(await idsFor(db, 'scheduled')).toEqual(['child-of-scheduled', 'root-scheduled'].sort())

    // (1) 界面上的「事件」收编了存量 webhook 行，且这两个选项本来就要能用。
    expect(await idsFor(db, 'event')).toEqual(['root-event', 'root-webhook'].sort())
    expect(await idsFor(db, 'api')).toEqual(['root-api'])

    // 存量 `webhook` 仍可被单独点名（`TaskListOrigin` 里它还在，只是界面不提供）。
    expect(await idsFor(db, 'webhook')).toEqual(['root-webhook'])
  })

  test('the buckets partition the whole set — nothing is double counted or lost', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)
    const partition = [
      ...(await idsFor(db, 'manual')),
      ...(await idsFor(db, 'scheduled')),
      ...(await idsFor(db, 'event')),
      ...(await idsFor(db, 'api')),
    ].sort()
    expect(partition).toEqual(await idsFor(db, 'all'))
  })
})

function actor(): Actor {
  return {
    user: {
      id: 'catalog-admin',
      username: 'catalog-admin',
      displayName: 'Catalog Admin',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
    permissions: new Set(['tasks:read', 'tasks:read:all'] as const),
    authorityRevision: 1,
  } as Actor
}

function catalogSource(seen: TaskRouteListFilters[]) {
  return createPostgresqlTaskExecutionCatalogSourceFactory({
    async listItems(filters) {
      seen.push(filters)
      return [] as readonly TaskListItem[]
    },
  }).create('workflow')
}

describe('PostgreSQL catalog source hands origin to the query instead of filtering rows', () => {
  // 单独一条：`event` / `api` 曾经是「不在分支里」⇒ 直接 400。这条要能在
  // 只有它们坏掉时独立变红，所以不与下面的透传断言混在一个 test 里。
  test('none of the offered choices is rejected', async () => {
    const rejected: string[] = []
    for (const origin of TASK_LIST_VISIBLE_ORIGINS) {
      try {
        await catalogSource([]).list({ actor: actor(), origin })
      } catch {
        rejected.push(origin)
      }
    }
    expect(rejected).toEqual([])
  })

  test('every choice the UI offers reaches listItems as a query filter', async () => {
    for (const origin of TASK_LIST_VISIBLE_ORIGINS) {
      const seen: TaskRouteListFilters[] = []
      await catalogSource(seen).list({ actor: actor(), origin })
      expect(seen).toHaveLength(1)
      // `all` 是「无谓词」，不该往下传一个筛选条件。
      expect(seen[0]?.origin).toBe(origin === 'all' ? undefined : origin)
    }
  })

  test('an absent origin is the same as all', async () => {
    const seen: TaskRouteListFilters[] = []
    await catalogSource(seen).list({ actor: actor() })
    expect(seen[0]?.origin).toBeUndefined()
  })

  test('an unknown origin is still rejected rather than silently ignored', async () => {
    const seen: TaskRouteListFilters[] = []
    const attempt = catalogSource(seen).list({ actor: actor(), origin: 'from-mars' })
    await expect(attempt).rejects.toThrow(ValidationError)
    expect(seen).toHaveLength(0)
  })
})
