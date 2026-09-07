// RFC-359 W6-T27 —— 迁移 0180 / 0183 两条回填的**引擎中立**复算。
//
// 为什么需要它：`rfc311-task-page-*fastpath` 两条 oracle 原本直接把迁移文件里的回填 SQL
// 抠出来跑（`UPDATE \`tasks\` SET \`branch_started_at\` = …`，带反引号、带 SQLite 的
// `CREATE TEMP TABLE … WITH RECURSIVE`）。那份 SQL 是 SQLite 方言，PostgreSQL 上跑不了；
// 而 PostgreSQL 侧本来也不跑迁移脚本里的数据语句——它的行是 RFC-349 逻辑复制从 SQLite 带
// 过来的（`postgresqlMigrator` 只投影 DDL）。
//
// 所以两个引擎共用这份 TypeScript 复算来种正确的列值，**同时**在 SQLite 那一侧保留
// 「迁移 SQL 算出来的与这份复算逐行相等」的断言（见各 oracle 文件里的 backfill 对拍用例）。
// 这样「回填算法 == 快路径的排序键假设」这条锁没有丢，只是换了个地方钉。
//
// 语义逐字对齐迁移：
//   · `branch_started_at`（0180）= **该行自己子树**内 `started_at` 的最大值
//     （递归 CTE 从每一行出发向下走 64 层，按起点分组取 MAX），拿不到就退回自己的 started_at；
//   · `root_task_id`（0183）= 向上走到第一个 `parent_task_id IS NULL` 的祖先；
//     走不到（父行不存在于表里）时退回**该行自己**。

/** 回填只关心这三列。 */
export interface ForestNode {
  readonly id: string
  readonly startedAt: number
  readonly parentTaskId?: string | null | undefined
}

export interface ForestBackfill {
  /** id → branch_started_at（迁移 0180）。 */
  readonly branchStartedAt: ReadonlyMap<string, number>
  /** id → root_task_id（迁移 0183）。 */
  readonly rootTaskId: ReadonlyMap<string, string>
}

/** 与迁移里的 `WHERE sub.depth < 64` / `w.depth < 64` 同一个上界。 */
const MAX_DEPTH = 64

export function computeForestBackfill(rows: readonly ForestNode[]): ForestBackfill {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const children = new Map<string, string[]>()
  for (const row of rows) {
    const parent = row.parentTaskId ?? null
    if (parent === null || !byId.has(parent)) continue
    const bucket = children.get(parent)
    if (bucket === undefined) children.set(parent, [row.id])
    else bucket.push(row.id)
  }

  const branchStartedAt = new Map<string, number>()
  for (const row of rows) {
    // 从这一行出发向下走它自己的子树，取 started_at 的最大值。
    let frontier = [row.id]
    let best = row.startedAt
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = []
      for (const id of frontier) {
        const node = byId.get(id)
        if (node !== undefined) best = Math.max(best, node.startedAt)
        for (const child of children.get(id) ?? []) next.push(child)
      }
      frontier = next
    }
    branchStartedAt.set(row.id, best)
  }

  const rootTaskId = new Map<string, string>()
  for (const row of rows) {
    let cursor: string | undefined = row.id
    let resolved: string | undefined
    for (let depth = 0; depth <= MAX_DEPTH && cursor !== undefined; depth += 1) {
      const node: ForestNode | undefined = byId.get(cursor)
      if (node === undefined) break
      const parent = node.parentTaskId ?? null
      if (parent === null) {
        resolved = node.id
        break
      }
      cursor = parent
    }
    // 走不到无父祖先（父行不存在）⇒ 迁移的第二条语句把它设成自己。
    rootTaskId.set(row.id, resolved ?? row.id)
  }

  return { branchStartedAt, rootTaskId }
}
