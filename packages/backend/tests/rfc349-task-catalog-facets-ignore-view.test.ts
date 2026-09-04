// PostgreSQL 任务目录源的 facets 语义守卫。
//
// 起因（用户 2026-09-04）：「点击全部 / 进行中 / 需处理 / 已结束，每个页签选中的时候，
// 其他页签数字都会变，还每次变的都不一样」。/tasks 的四个页签计数直接取这次列表请求
// 返回的 `facets`（frontend `routes/tasks.tsx` 的 `facets[view]`），而 `view` 在
// queryKey 里——所以只要 facets 依赖 view，换页签就会把四个数字整体重写。
//
// SQLite 侧的契约早已锁在 `rfc244-task-operations.test.ts` 的「facets ignore view」：
// facets 一律数在 `non_view_matches`（只叠非-view 过滤）上，view 只用来挑这一页。
// PostgreSQL 源此前把 view 翻译成状态集合、先 filter 再计数
// （`selectedStatuses` → `all` → `for (const item of all) counts[...]`），于是
// 「进行中」页签会把 attention / finished 报成 0。这个文件把该契约钉在 PG 源上。
//
// 一并锁住两条同源语义（都是 SQLite 侧 `viewCondition` / `facet_values` 的既有行为）：
//   · 四个桶**重叠**——awaiting_review 同时进 active 与 attention，failed 同时进
//     finished 与 attention（旧的 `statusFacet` 是互斥三分类，每行只进一个桶）；
//   · attention 还收「有未结 lifecycle 告警」的行，与状态无关。

import {
  TASK_LIST_VIEWS,
  type TaskListItem,
  type TaskOperationsFacets,
  type TaskStatus,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import type { Actor } from '@/auth/actor'
import { createPostgresqlTaskExecutionCatalogSourceFactory } from '@/modules/task-execution/infrastructure/postgresqlTaskCatalogSources'
import type { TaskRouteListFilters } from '@/modules/task-execution/public/taskRoutes'
import { ValidationError } from '@/util/errors'

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

let seq = 0

function task(status: TaskStatus, overrides: Partial<TaskListItem> = {}): TaskListItem {
  seq += 1
  return {
    id: `task-${String(seq).padStart(3, '0')}`,
    name: `task ${seq}`,
    workflowId: 'wf-1',
    workflowName: 'Workflow one',
    repoPath: '/repo/one',
    repoUrl: null,
    cachedRepoId: null,
    status,
    startedAt: 1_000 + seq,
    finishedAt: null,
    errorSummary: null,
    repoCount: 1,
    openAlertCount: 0,
    scheduledTaskId: null,
    workgroupId: null,
    workgroupName: null,
    spaceKind: 'remote',
    parentTaskId: null,
    invocationDepth: 0,
    sourceAgentName: null,
    sourceAgentId: null,
    codeRoundId: null,
    childCount: 0,
    ownerUserId: 'catalog-admin',
    owner: null,
    ...overrides,
  } as TaskListItem
}

/** 全部落 `workflow` 源，让一次 list 就能看到整份集合。 */
function fixture() {
  seq = 0
  return [
    task('running'),
    task('pending'),
    task('awaiting_review'),
    task('awaiting_human'),
    task('failed'),
    task('done'),
    task('done', { openAlertCount: 2 }),
    task('canceled'),
    task('interrupted'),
  ]
}

function catalogSource(rows: readonly TaskListItem[], seen: TaskRouteListFilters[] = []) {
  return createPostgresqlTaskExecutionCatalogSourceFactory({
    async listItems(filters) {
      seen.push(filters)
      return rows
    },
  }).create('workflow')
}

// 手算的期望值（四个桶重叠，attention 含 openAlertCount > 0 的那行 done）：
//   all       = 9
//   active    = running, pending, awaiting_review, awaiting_human            → 4
//   attention = failed, awaiting_review, awaiting_human, done(告警)          → 4
//   finished  = failed, done, done(告警), canceled, interrupted              → 5
const EXPECTED: TaskOperationsFacets = { all: 9, active: 4, attention: 4, finished: 5 }

describe('RFC-349 PostgreSQL 任务目录：facets 与 view 无关', () => {
  test('四个 view 返回同一份 facets，而 items 各自按 view 过滤', async () => {
    const source = catalogSource(fixture())
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
    const source = catalogSource(fixture())
    expect((await source.list({ actor: actor() })).facets).toEqual(EXPECTED)
  })

  test('attention 收未结告警的行，与状态无关', async () => {
    const source = catalogSource(fixture())
    const page = await source.list({ actor: actor(), view: 'attention' })
    const alerted = page.items.find((item) => item.openAlertCount > 0)
    expect(alerted).toBeDefined()
    expect(alerted?.status).toBe('done')
  })

  test('显式 statuses 收窄 facets 分母，且与 view 叠加而不是互相取代', async () => {
    const source = catalogSource(fixture())
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
    const source = catalogSource(fixture())
    expect(source.list({ actor: actor(), view: 'nope' })).rejects.toThrow(ValidationError)
    expect(source.list({ actor: actor(), statuses: 'not-a-status' })).rejects.toThrow(
      ValidationError,
    )
  })

  test('分页游标只切 items，facets 仍是整份分母', async () => {
    const source = catalogSource(fixture())
    const first = await source.list({ actor: actor(), limit: '4' })
    expect(first.facets).toEqual(EXPECTED)
    expect(first.items).toHaveLength(4)
    expect(first.nextCursor).not.toBeNull()
    const second = await source.list({ actor: actor(), limit: '4', cursor: first.nextCursor! })
    expect(second.facets).toEqual(EXPECTED)
    expect(second.items).toHaveLength(4)
  })
})
