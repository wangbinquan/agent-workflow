// RFC-311 PR-4 — /api/tasks/page default-view fast path oracle.
//
// The default (filter-free) view used to pay O(all tasks) per page: full
// MATERIALIZED base + per-row correlated subqueries + two whole-forest
// recursive CTEs, LIMIT applied last (audit L2-1). The fast path scans the
// (branch_started_at, id) keyset index and enriches only the returned page.
//
// Oracle trick: passing statuses=<every status> forces the exhaustive
// pipeline while keeping its semantics identical to "no filter" (the IN
// predicate is vacuously true), so new-vs-old can be compared page by page on
// the same forest. The migration-0180 backfill statements compute
// branch_started_at exactly like the maintenance hook does, so running them
// over a hand-inserted forest also locks "backfill algorithm == fast-path
// sort-key assumption".

import { TASK_STATUS, type TaskOperationsListItem } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { taskCollaborators, tasks, users, workflows } from '../src/db/schema'
import { isDefaultView, listTaskOperationsPage } from '../src/services/taskOperations'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Db = ReturnType<typeof createInMemoryDb>

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedBase(db: Db): Promise<void> {
  const now = 1_788_278_400_000
  await db.insert(users).values(
    ['admin', 'alice', 'bob'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: id === 'admin' ? ('admin' as const) : ('user' as const),
      createdAt: now,
      updatedAt: now,
    })),
  )
  await db.insert(workflows).values({
    id: 'wf1',
    name: 'wf',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
}

interface SeedTask {
  id: string
  owner: string
  status: 'pending' | 'running' | 'awaiting_review' | 'done' | 'failed' | 'canceled'
  startedAt: number
  parent?: string
}

async function insertForest(db: Db, rows: SeedTask[]): Promise<void> {
  for (const r of rows) {
    await db.insert(tasks).values({
      id: r.id,
      name: r.id,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: `/tmp/${r.id}`,
      worktreePath: `/tmp/wt-${r.id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${r.id}`,
      status: r.status,
      inputs: '{}',
      startedAt: r.startedAt,
      finishedAt: r.status === 'done' || r.status === 'failed' ? r.startedAt + 10 : null,
      runningMs: 0,
      ownerUserId: r.owner,
      parentTaskId: r.parent,
      invocationDepth: r.parent === undefined ? 0 : 1,
      launchOrigin: 'manual',
      branchStartedAt: 0, // deliberately wrong — the backfill below must fix it
    })
  }
  const migrationSql = readFileSync(join(MIGRATIONS, '0180_rfc311_perf_indexes.sql'), 'utf8')
  const statements = migrationSql
    .split('--> statement-breakpoint')
    .map((statement) => statement.replace(/^--.*$/gm, '').trim())
    .filter(
      (statement) =>
        statement.includes('_rfc311_branch_backfill') ||
        statement.startsWith('UPDATE `tasks` SET `branch_started_at`'),
    )
  for (const statement of statements) db.run(sql.raw(statement))
}

/** Deterministic pseudo-random forest — varied owners, states, depths. */
function buildForest(count: number): SeedTask[] {
  const owners = ['alice', 'bob', 'admin']
  const statuses: SeedTask['status'][] = [
    'pending',
    'running',
    'awaiting_review',
    'done',
    'failed',
    'canceled',
  ]
  const rows: SeedTask[] = []
  let seed = 42
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let i = 0; i < count; i += 1) {
    const id = `t${String(i).padStart(3, '0')}`
    const canParent = rows.filter((r) => r.parent === undefined || rand(3) === 0)
    const parent = i > 0 && rand(3) === 0 ? canParent[rand(canParent.length)]?.id : undefined
    rows.push({
      id,
      owner: owners[rand(owners.length)]!,
      status: statuses[rand(statuses.length)]!,
      startedAt: 1_000 + i * 37 + rand(20),
      ...(parent !== undefined ? { parent } : {}),
    })
  }
  return rows
}

function normalize(items: TaskOperationsListItem[]): unknown[] {
  return items.map((item) => ({ ...item }))
}

async function collectPages(
  db: Db,
  who: Actor,
  extraQuery: Record<string, string>,
  limit: number,
  // RFC-311 G1：过滤视图也有了快路径，慢侧必须**显式**钉在旧管线上，否则
  // 两侧被同一条实现服务，oracle 退化成快-vs-快、恒等。
  pipeline: 'auto' | 'exhaustive' = 'auto',
): Promise<{ items: TaskOperationsListItem[]; facets: unknown }> {
  const items: TaskOperationsListItem[] = []
  let cursor: string | undefined
  let facets: unknown
  for (let page = 0; page < 20; page += 1) {
    const result = await listTaskOperationsPage(
      db,
      who,
      {
        ...extraQuery,
        limit: String(limit),
        ...(cursor !== undefined ? { cursor } : {}),
      },
      { pipeline },
    )
    items.push(...result.items)
    if (result.kind === 'root' && facets === undefined) facets = result.facets
    if (result.nextCursor === null) break
    cursor = result.nextCursor
  }
  return { items, facets }
}

describe('RFC-311 — default-view fast path === exhaustive pipeline', () => {
  test('whole paged sequence and facets match on a random forest, per actor', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await insertForest(db, buildForest(60))
    await db.insert(taskCollaborators).values({
      taskId: 't005',
      userId: 'bob',
      role: 'collaborator',
      addedBy: 'alice',
      addedAt: 1,
    })

    const allStatuses = TASK_STATUS.join(',')
    for (const who of [actor('admin', 'admin'), actor('alice'), actor('bob')]) {
      const fast = await collectPages(db, who, {}, 7)
      const slow = await collectPages(db, who, { statuses: allStatuses }, 7, 'exhaustive')
      expect(normalize(fast.items)).toEqual(normalize(slow.items))
      expect(fast.facets).toEqual(slow.facets)
      expect(fast.items.length).toBeGreaterThan(0)
    }
  })

  test('fast path answers a mid-sequence cursor identically', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await insertForest(db, buildForest(25))
    const who = actor('admin', 'admin')
    const first = await listTaskOperationsPage(db, who, { limit: '5' })
    expect(first.kind).toBe('root')
    expect(first.nextCursor).not.toBeNull()
    const second = await listTaskOperationsPage(db, who, {
      limit: '5',
      cursor: first.nextCursor!,
    })
    const firstIds = new Set(first.items.map((item) => item.id))
    for (const item of second.items) expect(firstIds.has(item.id)).toBe(false)
  })

  // RFC-311 基准实测回归:keyset 断点写成展开的 `a < ? OR (a = ? AND id < ?)`
  // 时,SQLite 在**绑定参数**下会选 MULTI-INDEX OR 并回落 TEMP B-TREE 排序,
  // 把全部根行物化排一遍(10 万任务库实测翻页 197ms vs 首页 30ms)。行值形式
  // `(a, id) < (?, ?)` 才落成一次有序 SEARCH。EXPLAIN 用**字面量**看不出差异
  // (字面量下反而选对索引),所以这条断言必须用 `?` 占位符。
  test('the paging boundary keeps an ordered index seek (no TEMP B-TREE)', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const plan = db
      .all<{ detail: string }>(
        sql.raw(
          `EXPLAIN QUERY PLAN SELECT t.id FROM tasks t
             WHERE (t.parent_task_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = t.parent_task_id))
               AND (t.branch_started_at, t.id) < (?, ?)
             ORDER BY t.branch_started_at DESC, t.id DESC LIMIT 51`,
        ),
      )
      .map((row) => row.detail)
      .join('\n')
    expect(plan).toContain('idx_tasks_branch_started_id')
    expect(plan).not.toContain('TEMP B-TREE')
    // 源码层守卫:两处断点都必须是行值形式,任何一处退回 OR 展开都在这里红。
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'taskOperations.ts'),
      'utf8',
    )
    // 注:插值变量是 camelCase(`${parsed.cursor.branchStartedAt}`),此前这条正则
    // 写成 snake_case 永不匹配 ⇒ 恒真(实现门 P2-9)。
    expect(src).not.toMatch(/branchStartedAt\} AND [a-z]+\.id </)
    expect(src.match(/branch_started_at, [a-z]+\.id\) < \(/g)).toHaveLength(2)
  })

  // 实现门 P0-2:oracle 比的是「快路径 vs 旧管线」,一旦 isDefaultView 恒 false 就
  // 退化成 slow-vs-slow 的恒真比较——RFC 的头号交付可以被静默关掉而 CI 全绿。
  // 这里直接把分流判据本身锁住(顺带锁 PR-4 的范围修正:受限 actor 不得走快路径)。
  test('the fast path is actually selected for the admin default view only', () => {
    const defaults = {
      view: 'all' as const,
      statuses: [],
      subject: 'all' as const,
      scope: 'all' as const,
      origin: 'all' as const,
    }
    expect(isDefaultView(actor('admin', 'admin'), defaults)).toBe(true)
    // 受限 actor:分支聚合按可见性裁剪树算,共享物化列答不了它的排序。
    expect(isDefaultView(actor('alice', 'user'), { ...defaults, scope: 'mine' })).toBe(false)
    // 任一过滤位被动过就必须回旧管线。
    expect(isDefaultView(actor('admin', 'admin'), { ...defaults, view: 'active' })).toBe(false)
    expect(isDefaultView(actor('admin', 'admin'), { ...defaults, statuses: ['running'] })).toBe(
      false,
    )
    expect(isDefaultView(actor('admin', 'admin'), { ...defaults, origin: 'webhook' })).toBe(false)
    expect(isDefaultView(actor('admin', 'admin'), { ...defaults, subject: 'agent' })).toBe(false)
    expect(isDefaultView(actor('admin', 'admin'), { ...defaults, q: 'x' })).toBe(false)
  })
})
