// RFC-357 —— 列表页的编排：解析 → 选查询形状 → 一次 `db.all` → 页内富化 → 组页。
//
// 平移自 `services/taskOperations.ts` 的 `listTaskOperationsPage`，管线选择规则逐字不变
// （默认视图快路径 / 过滤视图快路径 / 穷举管线 / 子页），只把数据库参数放宽到两个
// provider 的公共基类型。

import {
  TaskOperationsChildPageSchema,
  TaskOperationsRootPageSchema,
  type TaskCatalogVisibility,
  type TaskOperationsPage,
} from '@agent-workflow/shared'
import { and, eq, sql } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import { NotFoundError } from '@/util/errors'
import { taskListVisibilityCondition, type TaskListViewer } from './authorization'
import type { TaskListPageDb } from './db'
import {
  encodeCursor,
  parseTaskOperationsQuery,
  type TaskOperationsPageOptions,
  type TaskOperationsRawQuery,
} from './filters'
import { mapRows, type OperationsSqlRow, type TaskListPageEnrichment } from './projection'
import {
  canUseFilteredFastPath,
  childQuery,
  fastDefaultRootQuery,
  fastFilteredRootQuery,
  isDefaultView,
  rootQuery,
} from './query'

async function assertVisibleParent(
  db: TaskListPageDb,
  viewer: TaskListViewer,
  parentId: string,
  catalogVisibility?: TaskCatalogVisibility,
): Promise<void> {
  const row = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, parentId),
        taskListVisibilityCondition(db, tasks, viewer),
        catalogVisibility === undefined
          ? undefined
          : eq(tasks.catalogVisibility, catalogVisibility),
      ),
    )
    .limit(1)
  if (row.length === 0) {
    throw new NotFoundError('task-not-found', `task '${parentId}' not found`)
  }
}
/**
 * 快路径把 `root_task_id` 当分组键。一旦库里有行没落根（绕过服务层的裸 SQL
 * 插入、或将来某条迁移漏了回填），那行会被当成**自己的**根静默挂错分支——
 * 用户看到的是「某个子任务突然自成一行」，没有任何报错。
 *
 * 所以每次取页先问一句「还有没有未落根的行」：有就整条退回旧管线，宁可慢、
 * 不可错。谓词与 `idx_tasks_root_missing` 的部分索引逐字一致，正常库上这是
 * 一次命中空集的索引探查。
 */
export async function hasUnrootedTasks(db: TaskListPageDb): Promise<boolean> {
  const row = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(sql`${tasks.rootTaskId} IS NULL`)
    .limit(1)
  return row.length > 0
}
/** 页查询的完整装配：一个数据库客户端加两条页内富化查询。 */
export interface TaskListPageDeps extends TaskListPageEnrichment {
  readonly db: TaskListPageDb
}

export interface TaskListPage {
  list(
    viewer: TaskListViewer,
    rawQuery: TaskOperationsRawQuery,
    options?: TaskOperationsPageOptions,
  ): Promise<TaskOperationsPage>
}

export function createTaskListPage(deps: TaskListPageDeps): TaskListPage {
  return Object.freeze({
    list: async (viewer, rawQuery, options = {}) => await listPage(deps, viewer, rawQuery, options),
  } satisfies TaskListPage)
}

async function listPage(
  deps: TaskListPageDeps,
  viewer: TaskListViewer,
  rawQuery: TaskOperationsRawQuery,
  options: TaskOperationsPageOptions = {},
): Promise<TaskOperationsPage> {
  const db = deps.db
  const parsed = parseTaskOperationsQuery(viewer, rawQuery, options)
  if (parsed.parentId !== undefined) {
    await assertVisibleParent(db, viewer, parsed.parentId, options.catalogVisibility)
  }

  const defaultFastPath =
    options.catalogVisibility === undefined && isDefaultView(viewer, parsed.filters)

  const filteredFastPath =
    parsed.parentId === undefined &&
    options.pipeline !== 'exhaustive' &&
    !defaultFastPath &&
    canUseFilteredFastPath(viewer) &&
    !(await hasUnrootedTasks(db))

  const rawRows = (await db.all(
    parsed.parentId === undefined
      ? options.pipeline === 'exhaustive'
        ? rootQuery(db, viewer, parsed, options.catalogVisibility)
        : defaultFastPath
          ? fastDefaultRootQuery(db, viewer, parsed)
          : filteredFastPath
            ? fastFilteredRootQuery(db, viewer, parsed, options.catalogVisibility)
            : rootQuery(db, viewer, parsed, options.catalogVisibility)
      : childQuery(db, viewer, { ...parsed, parentId: parsed.parentId }, options.catalogVisibility),
  )) as OperationsSqlRow[]

  const pageRows = rawRows.filter((row) => row.id !== null)
  const hasNext = pageRows.length > parsed.limit
  const visibleRows = hasNext ? pageRows.slice(0, parsed.limit) : pageRows
  const items = await mapRows(
    db,
    deps,
    viewer,
    visibleRows,
    parsed.parentId === undefined ? 'root' : 'children',
    options.catalogVisibility,
  )
  let nextCursor: string | null = null
  if (hasNext) {
    const last = visibleRows.at(-1)
    if (last === undefined || last.id === null || last.branch_started_at === null) {
      throw new Error('task operations query returned an invalid page boundary')
    }
    nextCursor = encodeCursor({
      v: 1,
      branchStartedAt: last.branch_started_at,
      taskId: last.id,
      filterFingerprint: parsed.filterFingerprint,
    })
  }

  if (parsed.parentId !== undefined) {
    return TaskOperationsChildPageSchema.parse({
      kind: 'children',
      parentId: parsed.parentId,
      items,
      nextCursor,
    })
  }
  const facetRow = rawRows[0]
  return TaskOperationsRootPageSchema.parse({
    kind: 'root',
    items,
    nextCursor,
    facets: {
      all: facetCount(facetRow?.facet_all, 'facet_all'),
      active: facetCount(facetRow?.facet_active, 'facet_active'),
      attention: facetCount(facetRow?.facet_attention, 'facet_attention'),
      finished: facetCount(facetRow?.facet_finished, 'facet_finished'),
    },
  })
}

/** 同 `projection.ts` 的 `numeric`：PostgreSQL 的 `count(*)` 是 int8，驱动交回字符串。 */
function facetCount(value: unknown, field: string): number {
  const parsed = value === null || value === undefined ? 0 : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`task operations page carried a non-numeric ${field}: ${String(value)}`)
  }
  return parsed
}
