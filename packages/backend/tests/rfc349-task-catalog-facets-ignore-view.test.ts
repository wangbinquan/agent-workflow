// 任务目录源的 facets 语义守卫。
//
// 起因（用户 2026-09-04）：「点击全部 / 进行中 / 需处理 / 已结束，每个页签选中的时候，
// 其他页签数字都会变，还每次变的都不一样」。/tasks 的四个页签计数直接取这次列表请求
// 返回的 `facets`（frontend `routes/tasks.tsx` 的 `facets[view]`），而 `view` 在
// queryKey 里——所以只要 facets 依赖 view，换页签就会把四个数字整体重写。
//
// 当时的成因是 PostgreSQL 目录源**另写了一份实现**，把 view 翻译成状态集合、先 filter
// 再计数。RFC-357 把那份实现整个删掉了：两个 provider 现在共用同一条下推查询
// （`taskListPage/`），facets 由 SQL 的 `facet_values` CTE 数在 `non_view_matches` 上。
// 这个文件因此改成**从目录源这一层**（用户真正打到的那一层）钉住同一组契约：
//
//   · facets 与 view 无关，而 items 确实按 view 分流；
//   · 四个桶**重叠**——awaiting_review 同进 active 与 attention，failed 同进 finished
//     与 attention；attention 还收「有未结 lifecycle 告警」的行，与状态无关；
//   · 显式 `statuses=` 收窄的是 facets 的**分母**，且与 view 叠加而不是互相取代；
//   · 非法 view / statuses 是 422，不静默降级成「无过滤」；
//   · 翻页只切 items，facets 仍是整份分母。
//
// 只有一份实现之后，PostgreSQL 侧的同一组契约由共享场景在真库上覆盖
// （`rfc357-postgresql-page.integration.test.ts`），不必也不该在这里再假造一个 provider。

import { TASK_LIST_VIEWS, type TaskOperationsFacets, type TaskStatus } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { buildActor, type Actor } from '@/auth/actor'
import { createInMemoryDb } from '@/db/client'
import { lifecycleAlerts, tasks, users, workflows } from '@/db/schema'
import { composeSqliteOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import type { TaskCatalogSource } from '@/modules/task-catalog/composition/required-ports'
import { createTaskExecutionCatalogSourceFactory } from '@/modules/task-execution/infrastructure/taskExecutionCatalogSources'
import { createSqliteTaskListPage } from '@/modules/task-execution/infrastructure/taskListPage'
import { ValidationError } from '@/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Db = ReturnType<typeof createInMemoryDb>

function actor(): Actor {
  return buildActor({
    user: {
      id: 'catalog-admin',
      username: 'catalog-admin',
      displayName: 'Catalog Admin',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  })
}

/** 九行全部落 `workflow` 源（无 workgroup、无 sourceAgentName），一次 list 看到整份集合。 */
const FIXTURE: ReadonlyArray<{ status: TaskStatus; alerts?: number }> = [
  { status: 'running' },
  { status: 'pending' },
  { status: 'awaiting_review' },
  { status: 'awaiting_human' },
  { status: 'failed' },
  { status: 'done' },
  { status: 'done', alerts: 2 },
  { status: 'canceled' },
  { status: 'interrupted' },
]

async function catalogSource(): Promise<TaskCatalogSource> {
  const db = createInMemoryDb(MIGRATIONS)
  await seed(db)
  return createTaskExecutionCatalogSourceFactory(
    createSqliteTaskListPage(db, composeSqliteOwnerIdentityQueries(db)),
  ).create('workflow')
}

async function seed(db: Db): Promise<void> {
  await db.insert(users).values({
    id: 'catalog-admin',
    username: 'catalog-admin',
    displayName: 'Catalog Admin',
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
  let startedAt = 1_788_278_400_000
  for (const [index, row] of FIXTURE.entries()) {
    startedAt += 1000
    const id = `task-${String(index + 1).padStart(3, '0')}`
    await db.insert(tasks).values({
      id,
      name: `task ${index + 1}`,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/repo/one',
      worktreePath: `/tmp/wt-${id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: row.status,
      inputs: '{}',
      startedAt,
      finishedAt: row.status === 'running' || row.status === 'pending' ? null : startedAt + 10,
      runningMs: 0,
      ownerUserId: 'catalog-admin',
      launchOrigin: 'manual',
      branchStartedAt: startedAt,
      rootTaskId: id,
      catalogVisibility: 'public',
      repoCount: 1,
    })
    for (let alert = 0; alert < (row.alerts ?? 0); alert += 1) {
      await db.insert(lifecycleAlerts).values({
        id: `${id}-alert-${alert}`,
        taskId: id,
        rule: 'stuck',
        severity: 'warning',
        detail: 'seeded',
        detectedAt: startedAt,
        resolvedAt: null,
      })
    }
  }
}

// 手算的期望值（四个桶重叠，attention 含有告警的那行 done）：
//   all       = 9
//   active    = running, pending, awaiting_review, awaiting_human            → 4
//   attention = failed, awaiting_review, awaiting_human, done(告警)          → 4
//   finished  = failed, done, done(告警), canceled, interrupted              → 5
const EXPECTED: TaskOperationsFacets = { all: 9, active: 4, attention: 4, finished: 5 }

describe('任务目录源：facets 与 view 无关', () => {
  test('四个 view 返回同一份 facets，而 items 各自按 view 过滤', async () => {
    const source = await catalogSource()
    const pageSizes: Record<string, number> = {}
    for (const view of TASK_LIST_VIEWS) {
      const page = await source.list({ actor: actor(), view })
      expect(page.facets).toEqual(EXPECTED)
      pageSizes[view] = page.items.length
    }
    // facets 恒定不是因为 view 被整个忽略了——列表本身确实分流了。
    expect(pageSizes).toEqual({ all: 9, active: 4, attention: 4, finished: 5 })
  })

  test('view 缺省等同 all', async () => {
    const source = await catalogSource()
    expect((await source.list({ actor: actor() })).facets).toEqual(EXPECTED)
  })

  test('attention 收未结告警的行，与状态无关', async () => {
    const source = await catalogSource()
    const page = await source.list({ actor: actor(), view: 'attention' })
    const alerted = page.items.find((item) => item.openAlertCount > 0)
    expect(alerted).toBeDefined()
    expect(alerted?.status).toBe('done')
  })

  test('显式 statuses 收窄 facets 分母，且与 view 叠加而不是互相取代', async () => {
    const source = await catalogSource()
    const statuses = 'awaiting_review,failed,done'
    // 分母 = 这三种状态的 4 行（done 两行）；active 只有 awaiting_review、
    // attention 有 awaiting_review + failed + done(告警)、finished 有 failed + 两行 done。
    const narrowed: TaskOperationsFacets = { all: 4, active: 1, attention: 3, finished: 3 }
    for (const view of TASK_LIST_VIEWS) {
      const page = await source.list({ actor: actor(), statuses, view })
      expect(page.facets).toEqual(narrowed)
    }
    // 叠加：statuses 命中 4 行，其中只有 awaiting_review 属于 active 视图。
    const active = await source.list({ actor: actor(), statuses, view: 'active' })
    expect(active.items.map((item) => item.status)).toEqual(['awaiting_review'])
  })

  test('非法 view / statuses 是 422，不再静默降级成「无过滤」', async () => {
    const source = await catalogSource()
    await expect(source.list({ actor: actor(), view: 'nope' })).rejects.toThrow(ValidationError)
    await expect(source.list({ actor: actor(), statuses: 'not-a-status' })).rejects.toThrow(
      ValidationError,
    )
  })

  test('分页游标只切 items，facets 仍是整份分母', async () => {
    const source = await catalogSource()
    const first = await source.list({ actor: actor(), limit: '4' })
    expect(first.facets).toEqual(EXPECTED)
    expect(first.items).toHaveLength(4)
    expect(first.nextCursor).not.toBeNull()
    const second = await source.list({ actor: actor(), limit: '4', cursor: first.nextCursor! })
    expect(second.facets).toEqual(EXPECTED)
    expect(second.items).toHaveLength(4)
  })
})
