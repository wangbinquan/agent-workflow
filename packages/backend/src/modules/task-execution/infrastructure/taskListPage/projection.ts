// RFC-357 —— SQL 行 → `TaskOperationsListItem` 的投影，以及页内富化的三次批量查询。
//
// 平移自 `services/taskOperations.ts`，唯一的**新增**是数值归一：`db.all(sql)` 这条路上
// drizzle 的列 mapper 不参与，而 PostgreSQL 的 int8 / numeric 按规范由驱动交回**字符串**
// （`docs/dev-gotchas.md` 与 `rfc349-postgresql-numeric-projection` 实测）。SQLite 一直交
// number，于是同一段代码在两侧行为不同。这里统一 `Number()` 归一，并把「不是有限数」
// 当缺陷抛——让它红在这一行，而不是流进 zod 报一个看不懂的形状错。

import type {
  FailureCode,
  TaskCatalogVisibility,
  TaskOperationsListItem,
  TaskStatus,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import {
  defaultTaskListRowRef,
  taskListVisibilityCondition,
  type TaskListViewer,
} from './authorization'
import type { TaskListPageDb } from './db'

// ── 裸 SQL 回读的数值归一。**每一处**从 SQL 行里读数字的地方都必须走这三个 helper ──
//
// 为什么：`db.all(sql)` 这条路上 drizzle 的列 mapper 不参与，而 PostgreSQL 的 int8 /
// numeric 按规范由驱动交回**字符串**（`count(*)` → "100000"，普通 bigint 列同理）；
// SQLite 一直交 number。
//
// 这不是理论风险，是被真库 lane 抓到过**两次**的东西：
//   1. 投影里的 `started_at` 等列（PR-1 就归一了）；
//   2. **分页游标**——`page.ts` 直接拿 `last.branch_started_at` 编码，于是 PostgreSQL 上
//      写出的是 `{"branchStartedAt":"1788278410000"}`，而 `TaskPageCursorSchema` 要求
//      `z.number().int()`，翻第二页时自己解不开自己刚发的游标（422
//      `task-page-cursor-invalid`）。静态守卫当时只盯着投影层，漏了这一处；lane 抓到了。
//
// 所以判据搬进一个独立文件，并由 `rfc357-narrow-projection` 钉住「页目录下不存在绕过它的
// 裸数值读取」——下一处新的读点要么走这里，要么红。
//
// 非有限值一律抛：宁可红在这一行，也不要把 NaN 送进页里，或让 zod 在很远的地方报一个看
// 不懂的形状错。

export function numeric(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`task operations row carried a non-numeric ${field}: ${String(value)}`)
  }
  return parsed
}

export function nullableNumeric(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : numeric(value, field)
}

/** facets 缺列时按 0 计（子页不带 facets），其余与 `numeric` 同判据。 */
export function numericOrZero(value: unknown, field: string): number {
  return value === null || value === undefined ? 0 : numeric(value, field)
}

/** 一页内的富化查询。两个 provider 各自绑定自己的实现（见 `sqlite.ts`）。 */
export interface TaskListPageEnrichment {
  readonly owners: OwnerIdentityQueries
  readonly failureCodes: (
    rows: ReadonlyArray<{ id: string; status: string; failedNodeId: string | null }>,
  ) => Promise<ReadonlyMap<string, FailureCode | null>>
}

export interface OperationsSqlRow {
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
export type CompleteOperationsSqlRow = OperationsSqlRow & {
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
async function loadAuthorizedChildCounts(
  db: TaskListPageDb,
  viewer: TaskListViewer,
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
        taskListVisibilityCondition(db, defaultTaskListRowRef(), viewer),
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
export async function mapRows(
  db: TaskListPageDb,
  enrichment: TaskListPageEnrichment,
  viewer: TaskListViewer,
  rawRows: OperationsSqlRow[],
  kind: 'root' | 'children',
  catalogVisibility?: TaskCatalogVisibility,
): Promise<TaskOperationsListItem[]> {
  const rows = rawRows.flatMap((row): CompleteOperationsSqlRow[] => {
    if (row.id === null) return []
    requiredRow(row)
    return [row]
  })
  const owners = await enrichment.owners.loadOwnerIdentities(rows.map((row) => row.owner_user_id))
  const childCounts = await loadAuthorizedChildCounts(
    db,
    viewer,
    rows.map((row) => row.id),
    catalogVisibility,
  )
  const failureCodes = await enrichment.failureCodes(
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
    startedAt: numeric(row.started_at, 'started_at'),
    finishedAt: nullableNumeric(row.finished_at, 'finished_at'),
    errorSummary: row.error_summary,
    ...(failureCodes.has(row.id) ? { failureCode: failureCodes.get(row.id) ?? null } : {}),
    repoCount: numeric(row.repo_count, 'repo_count'),
    openAlertCount: numeric(row.open_alert_count ?? 0, 'open_alert_count'),
    scheduledTaskId: row.scheduled_task_id,
    workgroupId: row.workgroup_id,
    workgroupName: row.workgroup_name,
    spaceKind: row.space_kind,
    parentTaskId: row.parent_task_id,
    invocationDepth: numeric(row.invocation_depth, 'invocation_depth'),
    sourceAgentName: row.source_agent_name,
    sourceAgentId: row.source_agent_id,
    ownerUserId: row.owner_user_id,
    owner: row.owner_user_id === null ? null : (owners.get(row.owner_user_id) ?? null),
    childCount: childCounts.get(row.id) ?? 0,
    executionClock: {
      runningMs: numeric(row.running_ms, 'running_ms'),
      runningSince: nullableNumeric(row.running_since, 'running_since'),
    },
    listContext: {
      matchKind: row.match_kind,
      parentAvailability:
        row.parent_task_id === null ? 'none' : kind === 'children' ? 'visible' : 'unavailable',
      qualifyingChildCount: numeric(row.qualifying_child_count, 'qualifying_child_count'),
      matchingDescendantCount: numeric(row.matching_descendant_count, 'matching_descendant_count'),
      branchStartedAt: numeric(row.branch_started_at, 'branch_started_at'),
    },
  }))
}
