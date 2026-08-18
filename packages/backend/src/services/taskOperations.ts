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
  type TaskListOrigin,
  type TaskListScope,
  type TaskListSubject,
  type TaskListView,
  type TaskOperationsFilters,
  type TaskOperationsListItem,
  type TaskOperationsPage,
  type TaskStatus,
} from '@agent-workflow/shared'
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
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

function fingerprint(actor: Actor, filters: TaskOperationsFilters, parentId?: string): string {
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
  })
  return sha256Hex(canonical)
}

export function parseTaskOperationsQuery(
  actor: Actor,
  raw: TaskOperationsRawQuery,
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
  const filterFingerprint = fingerprint(actor, filters, parentId)
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

function nonViewCondition(db: DbClient, actor: Actor, filters: TaskOperationsFilters): SQL {
  const ref = { id: sql.raw('b.id'), ownerUserId: sql.raw('b.owner_user_id') }
  const conditions: SQL[] = [
    taskOwnershipScopeCondition(db, ref, actor.user.id, filters.scope) as SQL,
  ]

  if (filters.statuses.length > 0) {
    conditions.push(sql`b.status IN (${list(filters.statuses)})`)
  }
  if (filters.subject === 'workgroup') {
    conditions.push(sql`b.workgroup_id IS NOT NULL AND b.workgroup_id <> ''`)
  } else if (filters.subject === 'agent') {
    conditions.push(sql`(b.workgroup_id IS NULL OR b.workgroup_id = '')`)
    conditions.push(sql`b.source_agent_name IS NOT NULL AND b.source_agent_name <> ''`)
  } else if (filters.subject === 'workflow') {
    conditions.push(sql`(b.workgroup_id IS NULL OR b.workgroup_id = '')`)
    conditions.push(sql`(b.source_agent_name IS NULL OR b.source_agent_name = '')`)
  }
  if (filters.origin !== 'all') conditions.push(sql`b.launch_origin = ${filters.origin}`)

  if (filters.q !== undefined) {
    const pattern = `%${escapeLike(filters.q.toLocaleLowerCase('en-US'))}%`
    const escape = '\\'
    conditions.push(sql`(
      lower(b.name) LIKE ${pattern} ESCAPE ${escape}
      OR lower(b.id) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(b.workflow_name, '')) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(b.workgroup_name, '')) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(b.source_agent_name, '')) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(b.repo_path, '')) LIKE ${pattern} ESCAPE ${escape}
      OR lower(COALESCE(b.repo_url, '')) LIKE ${pattern} ESCAPE ${escape}
      OR EXISTS (
        SELECT 1 FROM task_repos tr
        WHERE tr.task_id = b.id
          AND (
            lower(COALESCE(tr.repo_path, '')) LIKE ${pattern} ESCAPE ${escape}
            OR lower(COALESCE(tr.repo_url, '')) LIKE ${pattern} ESCAPE ${escape}
          )
      )
    )`)
  }
  return andConditions(conditions)
}

function viewCondition(view: TaskListView, alias: string = 'nvm'): SQL {
  const col = (name: string): SQL => sql.raw(`${alias}.${name}`)
  if (view === 'all') return sql`1 = 1`
  if (view === 'active') return sql`${col('status')} IN (${list(TASK_LIST_ACTIVE_STATUSES)})`
  if (view === 'finished') return sql`${col('status')} IN (${list(TASK_LIST_FINISHED_STATUSES)})`
  return sql`(
    ${col('status')} IN (${list(TASK_LIST_ATTENTION_STATUSES)})
    OR ${col('open_alert_count')} > 0
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
  return sql`(
    bs.branch_started_at < ${cursor.branchStartedAt}
    OR (bs.branch_started_at = ${cursor.branchStartedAt} AND bs.id < ${cursor.taskId})
  )`
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

function rootQuery(db: DbClient, actor: Actor, parsed: ParsedTaskOperationsQuery): SQL {
  const auth = taskAuthorizationCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    actor,
  )
  const authorizedIds = sql`SELECT t.id FROM tasks t WHERE ${auth}`
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

async function assertVisibleParent(db: DbClient, actor: Actor, parentId: string): Promise<void> {
  const row = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, parentId), taskAuthorizationCondition(db, tasks, actor)))
    .limit(1)
  if (row.length === 0) {
    throw new NotFoundError('task-not-found', `task '${parentId}' not found`)
  }
}

function childQuery(
  db: DbClient,
  actor: Actor,
  parsed: ParsedTaskOperationsQuery & { parentId: string },
): SQL {
  const auth = taskAuthorizationCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    actor,
  )
  const authorizedIds = sql`
    SELECT t.id, ',' || t.id || ',' AS path, 1 AS depth
    FROM tasks t
    WHERE t.parent_task_id = ${parsed.parentId} AND ${auth}
    UNION ALL
    SELECT t.id, subtree.path || t.id || ',', subtree.depth + 1
    FROM tasks t
    JOIN authorized_ids subtree ON t.parent_task_id = subtree.id
    WHERE subtree.depth < ${MAX_TREE_DEPTH}
      AND instr(subtree.path, ',' || t.id || ',') = 0
      AND ${auth}
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
  db: DbClient,
  actor: Actor,
  parentIds: readonly string[],
): Promise<Map<string, number>> {
  if (parentIds.length === 0) return new Map()
  const rows = await db
    .select({ parentTaskId: tasks.parentTaskId, id: tasks.id })
    .from(tasks)
    .where(
      and(
        inArray(tasks.parentTaskId, [...parentIds]),
        taskAuthorizationCondition(db, defaultTaskAuthorizationRef(), actor),
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
  db: DbClient,
  actor: Actor,
  rawRows: OperationsSqlRow[],
  kind: 'root' | 'children',
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
function isDefaultView(actor: Actor, filters: TaskOperationsFilters): boolean {
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
function fastDefaultRootQuery(db: DbClient, actor: Actor, parsed: ParsedTaskOperationsQuery): SQL {
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
  const boundary =
    parsed.cursor === undefined
      ? sql`1 = 1`
      : sql`(
          t.branch_started_at < ${parsed.cursor.branchStartedAt}
          OR (t.branch_started_at = ${parsed.cursor.branchStartedAt} AND t.id < ${parsed.cursor.taskId})
        )`
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

export async function listTaskOperationsPage(
  db: DbClient,
  actor: Actor,
  rawQuery: TaskOperationsRawQuery,
): Promise<TaskOperationsPage> {
  const parsed = parseTaskOperationsQuery(actor, rawQuery)
  if (parsed.parentId !== undefined) await assertVisibleParent(db, actor, parsed.parentId)

  const rawRows = (await db.all(
    parsed.parentId === undefined
      ? isDefaultView(actor, parsed.filters)
        ? fastDefaultRootQuery(db, actor, parsed)
        : rootQuery(db, actor, parsed)
      : childQuery(db, actor, { ...parsed, parentId: parsed.parentId }),
  )) as OperationsSqlRow[]

  const pageRows = rawRows.filter((row) => row.id !== null)
  const hasNext = pageRows.length > parsed.limit
  const visibleRows = hasNext ? pageRows.slice(0, parsed.limit) : pageRows
  const items = await mapRows(
    db,
    actor,
    visibleRows,
    parsed.parentId === undefined ? 'root' : 'children',
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
