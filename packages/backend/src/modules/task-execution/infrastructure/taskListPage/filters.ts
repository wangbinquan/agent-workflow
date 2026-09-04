// RFC-357 —— 列表页的查询参数解析与过滤谓词。
//
// 平移自 `services/taskOperations.ts`（RFC-244 / RFC-311），逐条判据不变；改动只有两处：
//   · 数据库参数类型放宽到 provider 中立的 `TaskListPageDb`（见 `db.ts` 的调查记录）；
//   · 启动来源不再在这里手写 `IN ('event','webhook')`，改走 shared 的
//     `taskListOriginMatches`——`origin` 的映射在 PostgreSQL 目录源上曾另写一份并猜错
//     （「事件」/「API」筛选直接 400），2026-09-04 收成一份判据后这里跟着用同一份。

import {
  TASK_LIST_ACTIVE_STATUSES,
  TASK_LIST_ATTENTION_STATUSES,
  TASK_LIST_FINISHED_STATUSES,
  TaskListOriginSchema,
  TaskListSubjectSchema,
  TaskListViewSchema,
  canonicalTaskStatuses,
  parseTaskStatusList,
  taskListOriginMatches,
  type TaskCatalogVisibility,
  type TaskListOrigin,
  type TaskListScope,
  type TaskListSubject,
  type TaskListView,
  type TaskOperationsFilters,
} from '@agent-workflow/shared'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import { ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import { taskListOwnershipScopeCondition, type TaskListViewer } from './authorization'
import type { TaskListPageDb } from './db'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_QUERY_CODE_POINTS = 100
export interface TaskOperationsRawQuery {
  view?: string
  q?: string
  statuses?: string
  subject?: string
  scope?: string
  origin?: string
  parent_id?: string
  cursor?: string
  limit?: string
}
/** Internal execution-query controls; wire filters remain unchanged. */
export interface TaskOperationsPageOptions {
  pipeline?: 'auto' | 'exhaustive'
  catalogVisibility?: TaskCatalogVisibility
}
export interface ParsedTaskOperationsQuery {
  filters: TaskOperationsFilters
  parentId?: string
  cursor?: TaskPageCursorV1
  limit: number
  filterFingerprint: string
}
export interface TaskPageCursorV1 {
  v: 1
  branchStartedAt: number
  taskId: string
  filterFingerprint: string
}
const TaskPageCursorSchema = z
  .object({
    v: z.literal(1),
    branchStartedAt: z.number().int().nonnegative(),
    taskId: z.string().min(1),
    filterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
function filterError(message: string): never {
  throw new ValidationError('task-page-filter-invalid', message)
}
function cursorError(message: string): never {
  throw new ValidationError('task-page-cursor-invalid', message)
}
function parseEnum<T>(raw: string | undefined, fallback: T, schema: z.ZodType<T>, name: string): T {
  if (raw === undefined) return fallback
  const parsed = schema.safeParse(raw)
  if (!parsed.success) filterError(`unknown ${name}: ${raw}`)
  return parsed.data
}
function effectiveScope(viewer: TaskListViewer, raw: string | undefined): TaskListScope {
  if (raw !== undefined && raw !== 'mine' && raw !== 'shared' && raw !== 'all') {
    filterError(`unknown scope: ${raw}`)
  }
  const requested = raw === undefined ? (viewer.canReadAllTasks ? 'all' : 'mine') : raw
  return requested === 'all' && !viewer.canReadAllTasks ? 'mine' : requested
}
function decodeCursor(raw: string): TaskPageCursorV1 {
  let decoded: unknown
  try {
    const bytes = Buffer.from(raw, 'base64url')
    if (bytes.toString('base64url') !== raw) cursorError('cursor is not canonical base64url')
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error instanceof ValidationError) throw error
    cursorError('cursor is malformed')
  }
  const parsed = TaskPageCursorSchema.safeParse(decoded)
  if (!parsed.success) cursorError('cursor has an unsupported shape')
  return parsed.data
}
export function encodeCursor(cursor: TaskPageCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}
function fingerprint(
  viewer: TaskListViewer,
  filters: TaskOperationsFilters,
  parentId?: string,
  catalogVisibility?: TaskCatalogVisibility,
): string {
  const canonical = JSON.stringify({
    actorUserId: viewer.userId,
    canReadAll: viewer.canReadAllTasks,
    parentId: parentId ?? null,
    view: filters.view,
    q: filters.q ?? null,
    statuses: canonicalTaskStatuses(filters.statuses),
    subject: filters.subject,
    scope: filters.scope,
    origin: filters.origin,
    catalogVisibility: catalogVisibility ?? null,
  })
  return sha256Hex(canonical)
}
export function parseTaskOperationsQuery(
  viewer: TaskListViewer,
  raw: TaskOperationsRawQuery,
  options: Pick<TaskOperationsPageOptions, 'catalogVisibility'> = {},
): ParsedTaskOperationsQuery {
  const view = parseEnum<TaskListView>(raw.view, 'all', TaskListViewSchema, 'view')
  const subject = parseEnum<TaskListSubject>(raw.subject, 'all', TaskListSubjectSchema, 'subject')
  const origin = parseEnum<TaskListOrigin>(raw.origin, 'all', TaskListOriginSchema, 'origin')
  const scope = effectiveScope(viewer, raw.scope)

  const trimmedQuery = raw.q?.trim()
  if (trimmedQuery !== undefined && Array.from(trimmedQuery).length > MAX_QUERY_CODE_POINTS) {
    filterError(`q must be at most ${MAX_QUERY_CODE_POINTS} code points`)
  }
  const statuses =
    raw.statuses === undefined
      ? []
      : (parseTaskStatusList(raw.statuses) ?? filterError('statuses must contain known values'))

  let limit = DEFAULT_LIMIT
  if (raw.limit !== undefined) {
    if (!/^\d+$/.test(raw.limit)) filterError('limit must be an integer from 1 to 100')
    limit = Number(raw.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      filterError('limit must be an integer from 1 to 100')
    }
  }

  const parentId = raw.parent_id
  if (parentId !== undefined && parentId.length === 0) filterError('parent_id must not be empty')
  const filters: TaskOperationsFilters = {
    view,
    ...(trimmedQuery ? { q: trimmedQuery } : {}),
    statuses,
    subject,
    scope,
    origin,
  }
  const filterFingerprint = fingerprint(viewer, filters, parentId, options.catalogVisibility)
  const cursor = raw.cursor === undefined ? undefined : decodeCursor(raw.cursor)
  if (cursor !== undefined && cursor.filterFingerprint !== filterFingerprint) {
    cursorError('cursor does not match the current viewer or filters')
  }

  return { filters, parentId, cursor, limit, filterFingerprint }
}
export function list(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )
}
export function andConditions(conditions: SQL[]): SQL {
  return conditions.length === 0 ? sql`1 = 1` : sql.join(conditions, sql` AND `)
}
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}
export function catalogVisibilityCondition(
  alias: string,
  catalogVisibility?: TaskCatalogVisibility,
): SQL {
  if (catalogVisibility === undefined) return sql`1 = 1`
  const col = (name: string): SQL => sql.raw(`${alias}.${name}`)
  return sql`${col('catalog_visibility')} = ${catalogVisibility}`
}
export function nonViewCondition(
  db: TaskListPageDb,
  viewer: TaskListViewer,
  filters: TaskOperationsFilters,
  // 旧管线在已物化的 `base b` 上求值；G1 的快路径直接打 `tasks t`，谓词逐字
  // 相同、只换别名——两条路径共用这一个函数，避免过滤语义在两处漂移。
  alias: string = 'b',
): SQL {
  const col = (name: string): SQL => sql.raw(`${alias}.${name}`)
  const ref = { id: col('id'), ownerUserId: col('owner_user_id') }
  const conditions: SQL[] = [
    taskListOwnershipScopeCondition(db, ref, viewer.userId, filters.scope) as SQL,
  ]

  if (filters.statuses.length > 0) {
    conditions.push(sql`${col('status')} IN (${list(filters.statuses)})`)
  }
  if (filters.subject === 'workgroup') {
    conditions.push(sql`${col('workgroup_id')} IS NOT NULL AND ${col('workgroup_id')} <> ''`)
  } else if (filters.subject === 'agent') {
    conditions.push(sql`(${col('workgroup_id')} IS NULL OR ${col('workgroup_id')} = '')`)
    conditions.push(
      sql`${col('source_agent_name')} IS NOT NULL AND ${col('source_agent_name')} <> ''`,
    )
  } else if (filters.subject === 'workflow') {
    conditions.push(sql`(${col('workgroup_id')} IS NULL OR ${col('workgroup_id')} = '')`)
    conditions.push(sql`(${col('source_agent_name')} IS NULL OR ${col('source_agent_name')} = '')`)
  }
  // RFC-357：来源 → 存储值的映射只有 shared 的 `taskListOriginMatches` 一份。
  // 它此前在这里是手写的 `IN ('event','webhook')`，而 PostgreSQL 目录源另写了一份按
  // `scheduled_task_id` 猜的实现——「事件」/「API」两个选项直接 400（2026-09-04 修）。
  const originMatches = taskListOriginMatches(filters.origin)
  if (originMatches !== null) {
    conditions.push(sql`${col('launch_origin')} IN (${list(originMatches)})`)
  }

  if (filters.q !== undefined) {
    const pattern = `%${escapeLike(filters.q.toLocaleLowerCase('en-US'))}%`
    const escape = '\\'
    // `base` 里的两个**派生**列在裸 tasks 上不存在，快路径按同一定义还原：
    // workflow_name 是 workflows 的 JOIN，workgroup_name 是 workgroup_config_json
    // 的 json_extract（与 baseCtes 逐字同源，改一处必须改两处——由 oracle 锁）。
    const derived = (name: 'workflow_name' | 'workgroup_name'): SQL => {
      if (alias === 'b') return col(name)
      if (name === 'workflow_name') {
        return sql`(SELECT w_q.name FROM workflows w_q WHERE w_q.id = ${col('workflow_id')})`
      }
      return sql`CASE WHEN json_valid(${col('workgroup_config_json')}) THEN
          CASE WHEN json_type(${col('workgroup_config_json')}, '$.workgroupName') IN ('text', 'string')
            THEN NULLIF(json_extract(${col('workgroup_config_json')}, '$.workgroupName'), '')
            ELSE NULL
          END
        ELSE NULL END`
    }
    conditions.push(sql`(
      lower(${col('name')}) LIKE ${pattern} ESCAPE ${escape}
      OR lower(${col('id')}) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(${derived('workflow_name')}, '')) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(${derived('workgroup_name')}, '')) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(${col('source_agent_name')}, '')) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(${col('repo_path')}, '')) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(${col('repo_url')}, '')) LIKE ${pattern} ESCAPE ${escape}
      OR EXISTS (
        SELECT 1 FROM task_repos tr
        WHERE tr.task_id = ${col('id')}
          AND (
            lower(COALESCE(tr.repo_path, '')) LIKE ${pattern} ESCAPE ${escape}
            OR lower(COALESCE(tr.repo_url, '')) LIKE ${pattern} ESCAPE ${escape}
          )
      )
    )`)
  }
  return andConditions(conditions)
}
/** `openAlert` 覆盖 attention 视图里「有未结告警」这一半：旧管线读已物化的
 *  `open_alert_count`，快路径直接打裸 tasks，只能用 EXISTS 子查询。其余分支
 *  两条路径逐字相同。 */
export function viewCondition(view: TaskListView, alias: string = 'nvm', openAlert?: SQL): SQL {
  const col = (name: string): SQL => sql.raw(`${alias}.${name}`)
  if (view === 'all') return sql`1 = 1`
  if (view === 'active') return sql`${col('status')} IN (${list(TASK_LIST_ACTIVE_STATUSES)})`
  if (view === 'finished') return sql`${col('status')} IN (${list(TASK_LIST_FINISHED_STATUSES)})`
  return sql`(
    ${col('status')} IN (${list(TASK_LIST_ATTENTION_STATUSES)})
    OR ${openAlert ?? sql`${col('open_alert_count')} > 0`}
  )`
}
