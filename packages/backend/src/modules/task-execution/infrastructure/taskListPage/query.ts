// RFC-357 —— 列表页的四种 SQL 形状：穷举管线（root / children）与 RFC-311 的两条快路径。
//
// 平移自 `services/taskOperations.ts`，SQL 文本逐字不变。可以逐字搬到两个 provider 上跑，
// 依据见 `db.ts` 的调查记录（sqlite-proxy 客户端 / `search_path` 上的 SQLite 函数 shim /
// `MATERIALIZED`、行值比较、递归 CTE 两方言同义 / 搜索两侧都已 `lower()`）。

import {
  TASK_LIST_ACTIVE_STATUSES,
  TASK_LIST_ATTENTION_STATUSES,
  TASK_LIST_FINISHED_STATUSES,
  type TaskCatalogVisibility,
  type TaskOperationsFilters,
} from '@agent-workflow/shared'
import { sql, type SQL } from 'drizzle-orm'

import {
  taskListOwnershipScopeCondition,
  taskListVisibilityCondition,
  type TaskListViewer,
} from './authorization'
import type { TaskListPageDb } from './db'
import {
  catalogVisibilityCondition,
  list,
  nonViewCondition,
  viewCondition,
  type ParsedTaskOperationsQuery,
  type TaskPageCursorV1,
} from './filters'

const MAX_TREE_DEPTH = 64
export function baseCtes(authorizedIds: SQL, nonView: SQL, view: SQL): SQL {
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
          CASE WHEN json_type(t.workgroup_config_json, '$.workgroupName') IN ('text', 'string')
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
export function branchCtes(rootIds: SQL): SQL {
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
export function pageBoundary(cursor: TaskPageCursorV1 | undefined): SQL {
  if (cursor === undefined) return sql`1 = 1`
  // 同 fastDefaultRootQuery 的行值形式(见那里的实测注记)。这条作用在旧管线
  // 已物化的 branch summary 上,规模小得多,但形式保持一致以免两处漂移。
  return sql`(bs.branch_started_at, bs.id) < (${cursor.branchStartedAt}, ${cursor.taskId})`
}
export function projectedRows(limit: number, cursor: TaskPageCursorV1 | undefined): SQL {
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
export function rootQuery(
  db: TaskListPageDb,
  viewer: TaskListViewer,
  parsed: ParsedTaskOperationsQuery,
  catalogVisibility?: TaskCatalogVisibility,
): SQL {
  const auth = taskListVisibilityCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    viewer,
  )
  const authorizedIds = sql`
    SELECT t.id FROM tasks t
    WHERE ${auth} AND ${catalogVisibilityCondition('t', catalogVisibility)}
  `
  const base = baseCtes(
    authorizedIds,
    nonViewCondition(db, viewer, parsed.filters),
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
export function childQuery(
  db: TaskListPageDb,
  viewer: TaskListViewer,
  parsed: ParsedTaskOperationsQuery & { parentId: string },
  catalogVisibility?: TaskCatalogVisibility,
): SQL {
  const auth = taskListVisibilityCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    viewer,
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
    nonViewCondition(db, viewer, parsed.filters),
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
export function isDefaultView(viewer: TaskListViewer, filters: TaskOperationsFilters): boolean {
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
    viewer.canReadAllTasks &&
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
export function fastDefaultRootQuery(
  db: TaskListPageDb,
  viewer: TaskListViewer,
  parsed: ParsedTaskOperationsQuery,
): SQL {
  const auth = taskListVisibilityCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    viewer,
  )
  const scope = taskListOwnershipScopeCondition(
    db,
    { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
    viewer.userId,
    parsed.filters.scope,
  )
  const parentAuth = taskListVisibilityCondition(
    db,
    { id: sql.raw('p.id'), ownerUserId: sql.raw('p.owner_user_id') },
    viewer,
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
        CASE WHEN json_type(t.workgroup_config_json, '$.workgroupName') IN ('text', 'string')
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
        WHERE c.parent_task_id = t.id AND ${taskListVisibilityCondition(
          db,
          { id: sql.raw('c.id'), ownerUserId: sql.raw('c.owner_user_id') },
          viewer,
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
      WHERE ${taskListVisibilityCondition(
        db,
        { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
        viewer,
      )} AND ${taskListOwnershipScopeCondition(
        db,
        { id: sql.raw('t.id'), ownerUserId: sql.raw('t.owner_user_id') },
        viewer.userId,
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
export function canUseFilteredFastPath(viewer: TaskListViewer): boolean {
  return viewer.canReadAllTasks
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
export function fastFilteredRootQuery(
  db: TaskListPageDb,
  viewer: TaskListViewer,
  parsed: ParsedTaskOperationsQuery,
  catalogVisibility?: TaskCatalogVisibility,
): SQL {
  const authOf = (alias: string): SQL =>
    taskListVisibilityCondition(
      db,
      { id: sql.raw(`${alias}.id`), ownerUserId: sql.raw(`${alias}.owner_user_id`) },
      viewer,
    )
  const openAlertExists = sql`EXISTS (
    SELECT 1 FROM lifecycle_alerts la WHERE la.task_id = t.id AND la.resolved_at IS NULL
  )`
  // 合格集的两层：non_view 决定 facets 的分母，再叠 view 得到真正的匹配集。
  // 与旧管线共用 nonViewCondition / viewCondition，只是换了别名。
  const nonView = nonViewCondition(db, viewer, parsed.filters, 't')
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
          CASE WHEN json_type(t.workgroup_config_json, '$.workgroupName') IN ('text', 'string')
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
