import {
  TASK_LIST_ACTIVE_STATUSES,
  TASK_LIST_ATTENTION_STATUSES,
  TASK_LIST_FINISHED_STATUSES,
  TaskListOriginSchema,
  TaskListSubjectSchema,
  TaskListViewSchema,
  TaskOperationsChildPageSchema,
  TaskOperationsRootPageSchema,
  canonicalTaskStatuses,
  parseTaskStatusList,
  type TaskCatalogVisibility,
  type TaskListOrigin,
  type TaskListScope,
  type TaskListSubject,
  type TaskListView,
  type TaskOperationsFilters,
  type TaskOperationsListItem,
  type TaskOperationsPage,
  type TaskStatus,
} from '@agent-workflow/shared'
import {
  and,
  eq,
  inArray,
  sql,
  tasks,
  type SQL,
  type LegacySqliteTaskDatabase,
} from '@/modules/task-execution/infrastructure/legacySqliteTransportMechanisms'
import { z } from 'zod'

import type { Actor } from '@/auth/actor'
import { loadOwnerIdentities } from '@/services/ownerIdentity'
import {
  defaultTaskAuthorizationRef,
  taskAuthorizationCondition,
  taskOwnershipScopeCondition,
} from '@/services/taskAuthorization'
import { loadTaskFailureCodes } from '@/services/task'
import { NotFoundError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_QUERY_CODE_POINTS = 100
const MAX_TREE_DEPTH = 64

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

interface TaskPageCursorV1 {
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

interface OperationsSqlRow {
  id: string | null
  name: string | null
  workflow_id: string | null
  workflow_name: string | null
  repo_path: string | null
  repo_url: string | null
  cached_repo_id: string | null
  status: string | null
  started_at: number | null
  running_ms: number | null
  running_since: number | null
  finished_at: number | null
  error_summary: string | null
  failed_node_id: string | null
  repo_count: number | null
  open_alert_count: number | null
  scheduled_task_id: string | null
  launch_origin: string | null
  workgroup_id: string | null
  workgroup_name: string | null
  space_kind: string | null
  parent_task_id: string | null
  invocation_depth: number | null
  source_agent_name: string | null
  source_agent_id: string | null
  owner_user_id: string | null
  branch_started_at: number | null
  match_kind: 'self' | 'context' | null
  qualifying_child_count: number | null
  matching_descendant_count: number | null
  facet_all?: number | null
  facet_active?: number | null
  facet_attention?: number | null
  facet_finished?: number | null
}

type CompleteOperationsSqlRow = OperationsSqlRow & {
  id: string
  name: string
  workflow_id: string
  repo_path: string
  status: TaskStatus
  started_at: number
  running_ms: number
  repo_count: number
  space_kind: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
  invocation_depth: number
  branch_started_at: number
  match_kind: 'self' | 'context'
  qualifying_child_count: number
  matching_descendant_count: number
}

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

function effectiveScope(actor: Actor, raw: string | undefined): TaskListScope {
  if (raw !== undefined && raw !== 'mine' && raw !== 'shared' && raw !== 'all') {
    filterError(`unknown scope: ${raw}`)
  }
  const requested =
    raw === undefined ? (actor.permissions.has('tasks:read:all') ? 'all' : 'mine') : raw
  return requested === 'all' && !actor.permissions.has('tasks:read:all') ? 'mine' : requested
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

function encodeCursor(cursor: TaskPageCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function fingerprint(
  actor: Actor,
  filters: TaskOperationsFilters,
  parentId?: string,
  catalogVisibility?: TaskCatalogVisibility,
): string {
  const canonical = JSON.stringify({
    actorUserId: actor.user.id,
    canReadAll: actor.permissions.has('tasks:read:all'),
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
  actor: Actor,
  raw: TaskOperationsRawQuery,
  options: Pick<TaskOperationsPageOptions, 'catalogVisibility'> = {},
): ParsedTaskOperationsQuery {
  const view = parseEnum<TaskListView>(raw.view, 'all', TaskListViewSchema, 'view')
  const subject = parseEnum<TaskListSubject>(raw.subject, 'all', TaskListSubjectSchema, 'subject')
  const origin = parseEnum<TaskListOrigin>(raw.origin, 'all', TaskListOriginSchema, 'origin')
  const scope = effectiveScope(actor, raw.scope)

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
  const filterFingerprint = fingerprint(actor, filters, parentId, options.catalogVisibility)
  const cursor = raw.cursor === undefined ? undefined : decodeCursor(raw.cursor)
  if (cursor !== undefined && cursor.filterFingerprint !== filterFingerprint) {
    cursorError('cursor does not match the current actor or filters')
  }

  return { filters, parentId, cursor, limit, filterFingerprint }
}

function list(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )
}

function andConditions(conditions: SQL[]): SQL {
  return conditions.length === 0 ? sql`1 = 1` : sql.join(conditions, sql` AND `)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function catalogVisibilityCondition(alias: string, catalogVisibility?: TaskCatalogVisibility): SQL {
  if (catalogVisibility === undefined) return sql`1 = 1`
  const col = (name: string): SQL => sql.raw(`${alias}.${name}`)
  return sql`${col('catalog_visibility')} = ${catalogVisibility}`
}

function nonViewCondition(
  db: LegacySqliteTaskDatabase,
  actor: Actor,
  filters: TaskOperationsFilters,
  // 旧管线在已物化的 `base b` 上求值；G1 的快路径直接打 `tasks t`，谓词逐字
  // 相同、只换别名——两条路径共用这一个函数，避免过滤语义在两处漂移。
  alias: string = 'b',
): SQL {
  const col = (name: string): SQL => sql.raw(`${alias}.${name}`)
  const ref = { id: col('id'), ownerUserId: col('owner_user_id') }
  const conditions: SQL[] = [
    taskOwnershipScopeCondition(db, ref, actor.user.id, filters.scope) as SQL,
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
  if (filters.origin === 'event') {
    // RFC-310 unified Webhook delivery under Event Center. Historical rows
    // keep their immutable `webhook` fact but belong to the one event filter.
    conditions.push(sql`${col('launch_origin')} IN ('event', 'webhook')`)
  } else if (filters.origin !== 'all') {
    conditions.push(sql`${col('launch_origin')} = ${filters.origin}`)
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
          CASE WHEN json_type(${col('workgroup_config_json')}, '$.workgroupName') = 'text'
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
function viewCondition(view: TaskListView, alias: string = 'nvm', openAlert?: SQL): SQL {
  const col = (name: string): SQL => sql.raw(`${alias}.${name}`)
  if (view === 'all') return sql`1 = 1`
  if (view === 'active') return sql`${col('status')} IN (${list(TASK_LIST_ACTIVE_STATUSES)})`
  if (view === 'finished') return sql`${col('status')} IN (${list(TASK_LIST_FINISHED_STATUSES)})`
  return sql`(
    ${col('status')} IN (${list(TASK_LIST_ATTENTION_STATUSES)})
    OR ${openAlert ?? sql`${col('open_alert_count')} > 0`}
  )`
}

function baseCtes(authorizedIds: SQL, nonView: SQL, view: SQL): SQL {
  return sql`
    authorized_ids AS MATERIALIZED (${authorizedIds}),
    base AS MATERIALIZED (
      SELECT
        t.id,
        t.name,
        t.workflow_id,
        w.name AS workflow_name,
        t.repo_path,
        t.repo_url,
        t.cached_repo_id,
        t.status,
        t.started_at,
        t.running_ms,
        t.running_since,
        t.finished_at,
        t.error_summary,
        t.failed_node_id,
        t.repo_count,
        (
          SELECT COUNT(*) FROM lifecycle_alerts la
          WHERE la.task_id = t.id AND la.resolved_at IS NULL
        ) AS open_alert_count,
        t.scheduled_task_id,
        t.launch_origin,
        t.workgroup_id,
        CASE WHEN json_valid(t.workgroup_config_json) THEN
          CASE WHEN json_type(t.workgroup_config_json, '$.workgroupName') = 'text'
            THEN NULLIF(json_extract(t.workgroup_config_json, '$.workgroupName'), '')
            ELSE NULL
          END
        ELSE NULL END AS workgroup_name,
        t.space_kind,
        t.parent_task_id,
        t.invocation_depth,
        t.source_agent_name,
        t.source_agent_id,
        t.owner_user_id
      FROM tasks t
      JOIN authorized_ids ai ON ai.id = t.id
      LEFT JOIN workflows w ON w.id = t.workflow_id
    ),
    non_view_matches AS MATERIALIZED (
      SELECT b.* FROM base b WHERE ${nonView}
    ),
    self_matches AS MATERIALIZED (
      SELECT nvm.* FROM non_view_matches nvm WHERE ${view}
    ),
    qualified_walk(id, path, depth) AS (
      SELECT sm.id, ',' || sm.id || ',', 0 FROM self_matches sm
      UNION ALL
      SELECT parent.id, qw.path || parent.id || ',', qw.depth + 1
      FROM qualified_walk qw
      JOIN base child ON child.id = qw.id
      JOIN base parent ON parent.id = child.parent_task_id
      WHERE qw.depth < ${MAX_TREE_DEPTH}
        AND instr(qw.path, ',' || parent.id || ',') = 0
    ),
    qualified_ids AS MATERIALIZED (
      SELECT DISTINCT id FROM qualified_walk
    )
  `
}

function branchCtes(rootIds: SQL): SQL {
  return sql`
    root_ids AS MATERIALIZED (${rootIds}),
    branch_walk(root_id, id, path, depth) AS (
      SELECT r.id, r.id, ',' || r.id || ',', 0 FROM root_ids r
      UNION ALL
      SELECT bw.root_id, child.id, bw.path || child.id || ',', bw.depth + 1
      FROM branch_walk bw
      JOIN base child ON child.parent_task_id = bw.id
      JOIN qualified_ids q ON q.id = child.id
      WHERE bw.depth < ${MAX_TREE_DEPTH}
        AND instr(bw.path, ',' || child.id || ',') = 0
    ),
    branch_stats AS (
      SELECT
        bw.root_id AS id,
        MAX(CASE WHEN sm.id IS NOT NULL THEN member.started_at ELSE 0 END) AS branch_started_at,
        MAX(CASE WHEN root_match.id IS NOT NULL THEN 1 ELSE 0 END) AS is_self,
        SUM(CASE WHEN sm.id IS NOT NULL AND bw.id <> bw.root_id THEN 1 ELSE 0 END)
          AS matching_descendant_count,
        (
          SELECT COUNT(*)
          FROM base direct_child
          JOIN qualified_ids direct_q ON direct_q.id = direct_child.id
          WHERE direct_child.parent_task_id = bw.root_id
        ) AS qualifying_child_count
      FROM branch_walk bw
      JOIN base member ON member.id = bw.id
      LEFT JOIN self_matches sm ON sm.id = bw.id
      LEFT JOIN self_matches root_match ON root_match.id = bw.root_id
      GROUP BY bw.root_id
    )
  `
}

function pageBoundary(cursor: TaskPageCursorV1 | undefined): SQL {
  if (cursor === undefined) return sql`1 = 1`
  // 同 fastDefaultRootQuery 的行值形式(见那里的实测注记)。这条作用在旧管线
  // 已物化的 branch summary 上,规模小得多,但形式保持一致以免两处漂移。
  return sql`(bs.branch_started_at, bs.id) < (${cursor.branchStartedAt}, ${cursor.taskId})`
}

function projectedRows(limit: number, cursor: TaskPageCursorV1 | undefined): SQL {
  return sql`
    SELECT
      b.*,
      bs.branch_started_at,
      CASE WHEN bs.is_self = 1 THEN 'self' ELSE 'context' END AS match_kind,
      bs.qualifying_child_count,
      bs.matching_descendant_count
    FROM branch_stats bs
    JOIN base b ON b.id = bs.id
    WHERE ${pageBoundary(cursor)}
    ORDER BY bs.branch_started_at DESC, bs.id DESC
    LIMIT ${limit + 1}
  `
}

function rootQuery(
  db: LegacySqliteTaskDatabase,
  actor: Actor,
  parsed: ParsedTaskOperationsQuery,
  catalogVisibility?: TaskCatalogVisibility,
): SQL {
  const auth = taskAuthorizationCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    actor,
  )
  const authorizedIds = sql`
    SELECT t.id FROM tasks t
    WHERE ${auth} AND ${catalogVisibilityCondition('t', catalogVisibility)}
  `
  const base = baseCtes(
    authorizedIds,
    nonViewCondition(db, actor, parsed.filters),
    viewCondition(parsed.filters.view),
  )
  const roots = sql`
    SELECT q.id
    FROM qualified_ids q
    JOIN base child ON child.id = q.id
    LEFT JOIN authorized_ids parent ON parent.id = child.parent_task_id
    WHERE child.parent_task_id IS NULL OR parent.id IS NULL
  `
  const branches = branchCtes(roots)
  const paged = projectedRows(parsed.limit, parsed.cursor)
  return sql`
    WITH RECURSIVE
    ${base},
    ${branches},
    facet_values AS (
      SELECT
        COUNT(*) AS facet_all,
        COALESCE(SUM(CASE WHEN status IN (${list(TASK_LIST_ACTIVE_STATUSES)}) THEN 1 ELSE 0 END), 0)
          AS facet_active,
        COALESCE(SUM(CASE
          WHEN status IN (${list(TASK_LIST_ATTENTION_STATUSES)}) OR open_alert_count > 0
          THEN 1 ELSE 0 END), 0) AS facet_attention,
        COALESCE(SUM(CASE WHEN status IN (${list(TASK_LIST_FINISHED_STATUSES)}) THEN 1 ELSE 0 END), 0)
          AS facet_finished
      FROM non_view_matches
    ),
    paged AS (${paged})
    SELECT
      p.*,
      f.facet_all,
      f.facet_active,
      f.facet_attention,
      f.facet_finished
    FROM facet_values f
    LEFT JOIN paged p ON 1 = 1
    ORDER BY p.branch_started_at DESC, p.id DESC
  `
}

async function assertVisibleParent(
  db: LegacySqliteTaskDatabase,
  actor: Actor,
  parentId: string,
  catalogVisibility?: TaskCatalogVisibility,
): Promise<void> {
  const row = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, parentId),
        taskAuthorizationCondition(db, tasks, actor),
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

function childQuery(
  db: LegacySqliteTaskDatabase,
  actor: Actor,
  parsed: ParsedTaskOperationsQuery & { parentId: string },
  catalogVisibility?: TaskCatalogVisibility,
): SQL {
  const auth = taskAuthorizationCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    actor,
  )
  const authorizedIds = sql`
    SELECT t.id, ',' || t.id || ',' AS path, 1 AS depth
    FROM tasks t
    WHERE t.parent_task_id = ${parsed.parentId}
      AND ${auth}
      AND ${catalogVisibilityCondition('t', catalogVisibility)}
    UNION ALL
    SELECT t.id, subtree.path || t.id || ',', subtree.depth + 1
    FROM tasks t
    JOIN authorized_ids subtree ON t.parent_task_id = subtree.id
    WHERE subtree.depth < ${MAX_TREE_DEPTH}
      AND instr(subtree.path, ',' || t.id || ',') = 0
      AND ${auth}
      AND ${catalogVisibilityCondition('t', catalogVisibility)}
  `
  const base = baseCtes(
    authorizedIds,
    nonViewCondition(db, actor, parsed.filters),
    viewCondition(parsed.filters.view),
  )
  const roots = sql`
    SELECT q.id
    FROM qualified_ids q
    JOIN base child ON child.id = q.id
    WHERE child.parent_task_id = ${parsed.parentId}
  `
  const branches = branchCtes(roots)
  return sql`
    WITH RECURSIVE
    ${base},
    ${branches}
    ${projectedRows(parsed.limit, parsed.cursor)}
  `
}

async function loadAuthorizedChildCounts(
  db: LegacySqliteTaskDatabase,
  actor: Actor,
  parentIds: readonly string[],
  catalogVisibility?: TaskCatalogVisibility,
): Promise<Map<string, number>> {
  if (parentIds.length === 0) return new Map()
  const rows = await db
    .select({ parentTaskId: tasks.parentTaskId, id: tasks.id })
    .from(tasks)
    .where(
      and(
        inArray(tasks.parentTaskId, [...parentIds]),
        taskAuthorizationCondition(db, defaultTaskAuthorizationRef(), actor),
        catalogVisibility === undefined
          ? undefined
          : eq(tasks.catalogVisibility, catalogVisibility),
      ),
    )
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.parentTaskId !== null) {
      counts.set(row.parentTaskId, (counts.get(row.parentTaskId) ?? 0) + 1)
    }
  }
  return counts
}

function requiredRow(row: OperationsSqlRow): asserts row is CompleteOperationsSqlRow {
  if (
    row.id === null ||
    row.name === null ||
    row.workflow_id === null ||
    row.repo_path === null ||
    row.status === null ||
    row.started_at === null ||
    row.running_ms === null ||
    row.repo_count === null ||
    row.space_kind === null ||
    row.invocation_depth === null ||
    row.branch_started_at === null ||
    row.match_kind === null ||
    row.qualifying_child_count === null ||
    row.matching_descendant_count === null
  ) {
    throw new Error('task operations query returned an incomplete row')
  }
}

async function mapRows(
  db: LegacySqliteTaskDatabase,
  actor: Actor,
  rawRows: OperationsSqlRow[],
  kind: 'root' | 'children',
  catalogVisibility?: TaskCatalogVisibility,
): Promise<TaskOperationsListItem[]> {
  const rows = rawRows.flatMap((row): CompleteOperationsSqlRow[] => {
    if (row.id === null) return []
    requiredRow(row)
    return [row]
  })
  const owners = await loadOwnerIdentities(
    db,
    rows.map((row) => row.owner_user_id),
  )
  const childCounts = await loadAuthorizedChildCounts(
    db,
    actor,
    rows.map((row) => row.id),
    catalogVisibility,
  )
  const failureCodes = await loadTaskFailureCodes(
    db,
    rows.map((row) => ({
      id: row.id,
      status: row.status,
      failedNodeId: row.failed_node_id,
    })),
  )

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    repoPath: row.repo_path,
    repoUrl: row.repo_url,
    cachedRepoId: row.cached_repo_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorSummary: row.error_summary,
    ...(failureCodes.has(row.id) ? { failureCode: failureCodes.get(row.id) ?? null } : {}),
    repoCount: row.repo_count,
    openAlertCount: Number(row.open_alert_count ?? 0),
    scheduledTaskId: row.scheduled_task_id,
    workgroupId: row.workgroup_id,
    workgroupName: row.workgroup_name,
    spaceKind: row.space_kind,
    parentTaskId: row.parent_task_id,
    invocationDepth: row.invocation_depth,
    sourceAgentName: row.source_agent_name,
    sourceAgentId: row.source_agent_id,
    ownerUserId: row.owner_user_id,
    owner: row.owner_user_id === null ? null : (owners.get(row.owner_user_id) ?? null),
    childCount: childCounts.get(row.id) ?? 0,
    executionClock: {
      runningMs: row.running_ms,
      runningSince: row.running_since,
    },
    listContext: {
      matchKind: row.match_kind,
      parentAvailability:
        row.parent_task_id === null ? 'none' : kind === 'children' ? 'visible' : 'unavailable',
      qualifyingChildCount: Number(row.qualifying_child_count),
      matchingDescendantCount: Number(row.matching_descendant_count),
      branchStartedAt: row.branch_started_at,
    },
  }))
}

/** RFC-311 — the default (filter-free) view is the page users land on and the
 *  one WS invalidation re-fetches; only IT can use the pure keyset fast path,
 *  because with no predicate every task self-matches, the qualified tree
 *  equals the whole tree and the branch sort key equals the materialized
 *  `tasks.branch_started_at`. Any active filter changes the branch aggregate's
 *  member set, so filtered queries keep the exhaustive pipeline. */
/** Exported for the fast-path oracle: without a direct assertion the whole
 *  O(page) path can be switched off (`isDefaultView` → false) and every test
 *  still passes, because the oracle degenerates into slow-vs-slow (实现门 P0-2 /
 *  变异 #2a). */
export function isDefaultView(actor: Actor, filters: TaskOperationsFilters): boolean {
  // The fast path serves ONLY tasks:read:all actors on the untouched default
  // view. Two reasons (both verified by the rfc311 fast-path oracle):
  //  - a restricted actor's branch aggregates (sort key included!) are
  //    computed over the VISIBILITY-PRUNED tree — an invisible descendant
  //    contributes neither recency nor counts — while the materialized
  //    `branch_started_at` is the global subtree max, so no shared index can
  //    answer their ordering;
  //  - an admin narrowing scope to mine/shared can surface context-ancestor
  //    roots that only the exhaustive pipeline models.
  // Restricted actors' default view is O(their own visible set) under the old
  // pipeline, which is the acceptable size by construction.
  return (
    actor.permissions.has('tasks:read:all') &&
    filters.scope === 'all' &&
    filters.view === 'all' &&
    filters.q === undefined &&
    filters.statuses.length === 0 &&
    filters.subject === 'all' &&
    filters.origin === 'all'
  )
}

/**
 * RFC-311 fast path (audit L2-1): the old shape MATERIALIZED every authorized
 * task (with a correlated alert-count subquery and a json_extract per row),
 * walked two recursive CTEs over the whole forest and only then applied
 * LIMIT — every page requested paid O(all tasks). This path scans the
 * `(branch_started_at, id)` index in order, stops at limit+1 roots, and
 * enriches ONLY the returned page. Facets stay exact (4 indexed counts over
 * the authorized set). Wire shape, cursor encoding and item shape are
 * byte-identical; the rfc311 page oracle pins new === old on random forests.
 */
function fastDefaultRootQuery(
  db: LegacySqliteTaskDatabase,
  actor: Actor,
  parsed: ParsedTaskOperationsQuery,
): SQL {
  const auth = taskAuthorizationCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    actor,
  )
  const scope = taskOwnershipScopeCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    actor.user.id,
    parsed.filters.scope,
  )
  const parentAuth = taskAuthorizationCondition(
    db,
    { id: sql.raw('p.id'), ownerUserId: sql.raw('p.owner_user_id') },
    actor,
  )
  // RFC-311(基准实测,10 万任务库):keyset 断点必须写成**行值比较**。
  // 展开成 `a < ? OR (a = ? AND id < ?)` 时,SQLite 在**绑定参数**下选
  // MULTI-INDEX OR 并回落 `USE TEMP B-TREE FOR ORDER BY`——把全部 9 万根行
  // 物化排序一遍(实测翻页 197ms,首页仅 30ms;EXPLAIN 用字面量看不出来,
  // 字面量下它反而选对索引,这正是这类坑难发现的原因)。行值形式
  // `(a, id) < (?, ?)` 直接落成一次有序 SEARCH,无临时 B 树。
  const boundary =
    parsed.cursor === undefined
      ? sql`1 = 1`
      : sql`(t.branch_started_at, t.id) < (${parsed.cursor.branchStartedAt}, ${parsed.cursor.taskId})`
  // Roots: top-level tasks, plus tasks whose parent this actor cannot see
  // (their branch re-roots at the first visible ancestor — same rule the
  // exhaustive pipeline's `roots` CTE applies).
  const paged = sql`
    SELECT
      t.id,
      t.name,
      t.workflow_id,
      w.name AS workflow_name,
      t.repo_path,
      t.repo_url,
      t.cached_repo_id,
      t.status,
      t.started_at,
      t.running_ms,
      t.running_since,
      t.finished_at,
      t.error_summary,
      t.failed_node_id,
      t.repo_count,
      (
        SELECT COUNT(*) FROM lifecycle_alerts la
        WHERE la.task_id = t.id AND la.resolved_at IS NULL
      ) AS open_alert_count,
      t.scheduled_task_id,
      t.launch_origin,
      t.workgroup_id,
      CASE WHEN json_valid(t.workgroup_config_json) THEN
        CASE WHEN json_type(t.workgroup_config_json, '$.workgroupName') = 'text'
          THEN NULLIF(json_extract(t.workgroup_config_json, '$.workgroupName'), '')
          ELSE NULL
        END
      ELSE NULL END AS workgroup_name,
      t.space_kind,
      t.parent_task_id,
      t.invocation_depth,
      t.source_agent_name,
      t.source_agent_id,
      t.owner_user_id,
      t.branch_started_at,
      'self' AS match_kind,
      (
        SELECT COUNT(*) FROM tasks c
        WHERE c.parent_task_id = t.id AND ${taskAuthorizationCondition(
          db,
          { id: sql.raw('c.id'), ownerUserId: sql.raw('c.owner_user_id') },
          actor,
        )}
      ) AS qualifying_child_count,
      (
        WITH RECURSIVE walk(id, depth) AS (
          SELECT d.id, 1 FROM tasks d WHERE d.parent_task_id = t.id
          UNION ALL
          SELECT d2.id, walk.depth + 1 FROM tasks d2
          JOIN walk ON d2.parent_task_id = walk.id
          WHERE walk.depth < ${MAX_TREE_DEPTH}
        )
        SELECT COUNT(*) FROM walk
      ) AS matching_descendant_count
    FROM tasks t
    LEFT JOIN workflows w ON w.id = t.workflow_id
    WHERE ${auth} AND ${scope} AND ${boundary}
      AND (
        t.parent_task_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM tasks p WHERE p.id = t.parent_task_id AND ${parentAuth}
        )
      )
    ORDER BY t.branch_started_at DESC, t.id DESC
    LIMIT ${parsed.limit + 1}
  `
  return sql`
    WITH facet_values AS (
      SELECT
        COUNT(*) AS facet_all,
        COALESCE(SUM(CASE WHEN t.status IN (${list(TASK_LIST_ACTIVE_STATUSES)}) THEN 1 ELSE 0 END), 0)
          AS facet_active,
        COALESCE(SUM(CASE
          WHEN t.status IN (${list(TASK_LIST_ATTENTION_STATUSES)})
            OR EXISTS (
              SELECT 1 FROM lifecycle_alerts la
              WHERE la.task_id = t.id AND la.resolved_at IS NULL
            )
          THEN 1 ELSE 0 END), 0) AS facet_attention,
        COALESCE(SUM(CASE WHEN t.status IN (${list(TASK_LIST_FINISHED_STATUSES)}) THEN 1 ELSE 0 END), 0)
          AS facet_finished
      FROM tasks t
      WHERE ${taskAuthorizationCondition(
        db,
        { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
        actor,
      )} AND ${taskOwnershipScopeCondition(
        db,
        { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
        actor.user.id,
        parsed.filters.scope,
      )}
    ),
    paged AS (${paged})
    SELECT
      p.*,
      f.facet_all,
      f.facet_active,
      f.facet_attention,
      f.facet_finished
    FROM facet_values f
    LEFT JOIN paged p ON 1 = 1
    ORDER BY p.branch_started_at DESC, p.id DESC
  `
}

/** RFC-311 G1 —— 过滤视图快路径的准入。与默认视图快路径同一条边界：只服务
 *  **全可见** actor。受限 actor 的分支聚合按可见性裁剪后的树计算（不可见后代
 *  既不贡献 recency 也不计数），物化的 root_task_id 是全局树根、答不了那个问题；
 *  而他们的默认视图在旧管线下本就是 O(自身可见集)，规模由构造保证。
 *
 *  与 `isDefaultView` 一样导出：没有直接断言的话，把它整个改成 `false` 会让全部
 *  测试照绿（oracle 退化成慢-vs-慢），快路径可以被静默关掉而无人察觉。 */
export function canUseFilteredFastPath(actor: Actor): boolean {
  return actor.permissions.has('tasks:read:all')
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
export async function hasUnrootedTasks(db: LegacySqliteTaskDatabase): Promise<boolean> {
  const row = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(sql`${tasks.rootTaskId} IS NULL`)
    .limit(1)
  return row.length > 0
}

/**
 * RFC-311 G1 —— **过滤视图**的 O(匹配集) 快路径（旧管线是 O(全部任务) 且不可打断）。
 *
 * 旧管线为了回答「哪些 root 进这一页、怎么排序」，先把全部授权任务物化成 `base`，
 * 再走两条递归 CTE：向上求「匹配行的祖先闭包」得到合格集 Q，向下从 root 走 Q 得到
 * 分支成员，最后才 LIMIT。10 万任务库上单次 68 秒，而且是一条 SQL——单连接同步
 * daemon 上等于整站冻结这么久。
 *
 * 等价改写的支点是 migration 0183 物化的 `root_task_id`：对**全可见** actor，
 * `subtree(root) ∩ Q` 恰好等于「root_task_id = root 且 ∈ Q」的那批行，于是
 *   - root 集合  = 匹配集按 root_task_id 去重；
 *   - 排序键     = 每个 root 下**匹配行**的 max(started_at)（旧管线的 branch_started_at 定义）；
 *   - is_self / matching_descendant_count 都是同一次 GROUP BY 的聚合。
 * 只有 `qualifying_child_count`（root 的直接子里有多少属于 Q）需要祖先信息，
 * 但它只对**页内 ≤ limit+1 个 root** 求值：取这些 root 的整棵树后做一次自底向上
 * 闭包即可，代价与旧管线的全森林递归不在一个量级。
 *
 * 受限 actor 仍走旧管线：他们的分支聚合按**可见性裁剪后**的树计算（不可见后代
 * 既不贡献 recency 也不计数），共享列答不了——与默认视图快路径同一条边界。
 */
function fastFilteredRootQuery(
  db: LegacySqliteTaskDatabase,
  actor: Actor,
  parsed: ParsedTaskOperationsQuery,
  catalogVisibility?: TaskCatalogVisibility,
): SQL {
  const authOf = (alias: string): SQL =>
    taskAuthorizationCondition(
      db,
      { id: sql.raw(`${alias}.id`), ownerUserId: sql.raw(`${alias}.owner_user_id`) },
      actor,
    )
  const openAlertExists = sql`EXISTS (
    SELECT 1 FROM lifecycle_alerts la WHERE la.task_id = t.id AND la.resolved_at IS NULL
  )`
  // 合格集的两层：non_view 决定 facets 的分母，再叠 view 得到真正的匹配集。
  // 与旧管线共用 nonViewCondition / viewCondition，只是换了别名。
  const nonView = nonViewCondition(db, actor, parsed.filters, 't')
  const boundary =
    parsed.cursor === undefined
      ? sql`1 = 1`
      : sql`(r.bsa, r.rid) < (${parsed.cursor.branchStartedAt}, ${parsed.cursor.taskId})`

  return sql`
    WITH RECURSIVE
    non_view_matches AS MATERIALIZED (
      SELECT
        t.id,
        t.root_task_id AS rid,
        t.started_at,
        t.status,
        ${openAlertExists} AS has_open_alert
      FROM tasks t
      WHERE ${authOf('t')}
        AND ${catalogVisibilityCondition('t', catalogVisibility)}
        AND ${nonView}
    ),
    matches AS MATERIALIZED (
      SELECT nvm.* FROM non_view_matches nvm
      WHERE ${viewCondition(parsed.filters.view, 'nvm', sql`nvm.has_open_alert`)}
    ),
    roots AS MATERIALIZED (
      SELECT
        m.rid AS rid,
        MAX(m.started_at) AS bsa,
        MAX(CASE WHEN m.id = m.rid THEN 1 ELSE 0 END) AS is_self,
        SUM(CASE WHEN m.id <> m.rid THEN 1 ELSE 0 END) AS matching_descendant_count
      FROM matches m
      GROUP BY m.rid
    ),
    page_roots AS MATERIALIZED (
      SELECT r.rid, r.bsa, r.is_self, r.matching_descendant_count
      FROM roots r
      WHERE ${boundary}
      ORDER BY r.bsa DESC, r.rid DESC
      LIMIT ${parsed.limit + 1}
    ),
    -- 页内 root 的整棵树。root_task_id 让它是一次索引取回，而不是递归下钻。
    fam AS MATERIALIZED (
      SELECT t.id, t.parent_task_id
      FROM tasks t
      JOIN page_roots pr ON pr.rid = t.root_task_id
      WHERE ${authOf('t')} AND ${catalogVisibilityCondition('t', catalogVisibility)}
    ),
    -- Q = 匹配行 ∪ 其祖先（自底向上闭包；UNION 去重顺带防成环）。
    qualified(id) AS (
      SELECT m.id FROM matches m JOIN page_roots pr ON pr.rid = m.rid
      UNION
      SELECT f.parent_task_id FROM qualified q JOIN fam f ON f.id = q.id
      WHERE f.parent_task_id IS NOT NULL
    ),
    child_counts AS (
      SELECT f.parent_task_id AS rid, COUNT(*) AS qualifying_child_count
      FROM fam f
      JOIN qualified q ON q.id = f.id
      JOIN page_roots pr ON pr.rid = f.parent_task_id
      GROUP BY f.parent_task_id
    ),
    facet_values AS (
      SELECT
        COUNT(*) AS facet_all,
        COALESCE(SUM(CASE WHEN status IN (${list(TASK_LIST_ACTIVE_STATUSES)}) THEN 1 ELSE 0 END), 0)
          AS facet_active,
        COALESCE(SUM(CASE
          WHEN status IN (${list(TASK_LIST_ATTENTION_STATUSES)}) OR has_open_alert
          THEN 1 ELSE 0 END), 0) AS facet_attention,
        COALESCE(SUM(CASE WHEN status IN (${list(TASK_LIST_FINISHED_STATUSES)}) THEN 1 ELSE 0 END), 0)
          AS facet_finished
      FROM non_view_matches
    ),
    paged AS (
      SELECT
        t.id,
        t.name,
        t.workflow_id,
        w.name AS workflow_name,
        t.repo_path,
        t.repo_url,
        t.cached_repo_id,
        t.status,
        t.started_at,
        t.running_ms,
        t.running_since,
        t.finished_at,
        t.error_summary,
        t.failed_node_id,
        t.repo_count,
        (
          SELECT COUNT(*) FROM lifecycle_alerts la
          WHERE la.task_id = t.id AND la.resolved_at IS NULL
        ) AS open_alert_count,
        t.scheduled_task_id,
        t.launch_origin,
        t.workgroup_id,
        CASE WHEN json_valid(t.workgroup_config_json) THEN
          CASE WHEN json_type(t.workgroup_config_json, '$.workgroupName') = 'text'
            THEN NULLIF(json_extract(t.workgroup_config_json, '$.workgroupName'), '')
            ELSE NULL
          END
        ELSE NULL END AS workgroup_name,
        t.space_kind,
        t.parent_task_id,
        t.invocation_depth,
        t.source_agent_name,
        t.source_agent_id,
        t.owner_user_id,
        pr.bsa AS branch_started_at,
        CASE WHEN pr.is_self = 1 THEN 'self' ELSE 'context' END AS match_kind,
        COALESCE(cc.qualifying_child_count, 0) AS qualifying_child_count,
        pr.matching_descendant_count
      FROM page_roots pr
      JOIN tasks t ON t.id = pr.rid
      LEFT JOIN workflows w ON w.id = t.workflow_id
      LEFT JOIN child_counts cc ON cc.rid = pr.rid
    )
    SELECT
      p.*,
      f.facet_all,
      f.facet_active,
      f.facet_attention,
      f.facet_finished
    FROM facet_values f
    LEFT JOIN paged p ON 1 = 1
    ORDER BY p.branch_started_at DESC, p.id DESC
  `
}

export async function listTaskOperationsPage(
  db: LegacySqliteTaskDatabase,
  actor: Actor,
  rawQuery: TaskOperationsRawQuery,
  options: TaskOperationsPageOptions = {},
): Promise<TaskOperationsPage> {
  const parsed = parseTaskOperationsQuery(actor, rawQuery, options)
  if (parsed.parentId !== undefined) {
    await assertVisibleParent(db, actor, parsed.parentId, options.catalogVisibility)
  }

  const defaultFastPath =
    options.catalogVisibility === undefined && isDefaultView(actor, parsed.filters)

  const filteredFastPath =
    parsed.parentId === undefined &&
    options.pipeline !== 'exhaustive' &&
    !defaultFastPath &&
    canUseFilteredFastPath(actor) &&
    !(await hasUnrootedTasks(db))

  const rawRows = (await db.all(
    parsed.parentId === undefined
      ? options.pipeline === 'exhaustive'
        ? rootQuery(db, actor, parsed, options.catalogVisibility)
        : defaultFastPath
          ? fastDefaultRootQuery(db, actor, parsed)
          : filteredFastPath
            ? fastFilteredRootQuery(db, actor, parsed, options.catalogVisibility)
            : rootQuery(db, actor, parsed, options.catalogVisibility)
      : childQuery(db, actor, { ...parsed, parentId: parsed.parentId }, options.catalogVisibility),
  )) as OperationsSqlRow[]

  const pageRows = rawRows.filter((row) => row.id !== null)
  const hasNext = pageRows.length > parsed.limit
  const visibleRows = hasNext ? pageRows.slice(0, parsed.limit) : pageRows
  const items = await mapRows(
    db,
    actor,
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
      all: Number(facetRow?.facet_all ?? 0),
      active: Number(facetRow?.facet_active ?? 0),
      attention: Number(facetRow?.facet_attention ?? 0),
      finished: Number(facetRow?.facet_finished ?? 0),
    },
  })
}
