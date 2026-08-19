// RFC-311 G1 —— 过滤视图快路径 === 旧穷举管线。
//
// 背景:旧管线为了回答「哪些 root 进这一页」，要先物化全部授权任务再走两条递归
// CTE，10 万任务库上单次 68 秒且是一条不可打断的 SQL（单连接同步 daemon ⇒ 整站
// 冻结）。新路径靠 migration 0183 物化的 `root_task_id` 把它塌缩成一次 GROUP BY。
//
// 这类改写唯一有意义的验收是**逐页逐 id 等价**：本文件用「过滤矩阵 × 多 actor」
// 把两条实现整段序列 + facets 对齐。慢侧显式钉在 `pipeline: 'exhaustive'` 上——
// 不钉的话新快路径会把慢侧一起服务掉，oracle 退化成快-vs-快、恒等（同一份文件
// 里默认视图那条 oracle 曾差点栽在这上面）。
//
// 覆盖的语义面（都是旧管线里由递归 CTE 表达、新路径必须复现的）：
//   - **context-ancestor**：匹配行的可见祖先要作为 `match_kind: 'context'` 的 root 出现；
//   - 分支排序键 = 该 root 下**匹配行**的 max(started_at)（不是子树全量 max）；
//   - `matchingDescendantCount` / `qualifyingChildCount` 的口径；
//   - facets 的分母是「过滤但未套视图」的匹配集。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import type { TaskOperationsListItem } from '@agent-workflow/shared'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { lifecycleAlerts, taskRepos, tasks, users, workflows } from '../src/db/schema'
import {
  canUseFilteredFastPath,
  hasUnrootedTasks,
  isDefaultView,
  listTaskOperationsPage,
} from '../src/services/taskOperations'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
type Db = ReturnType<typeof createInMemoryDb>

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

interface SeedTask {
  id: string
  owner: string
  status: 'pending' | 'running' | 'awaiting_review' | 'done' | 'failed' | 'canceled'
  startedAt: number
  parent?: string
  workgroup?: string
  agentName?: string
  origin: 'manual' | 'scheduled' | 'webhook'
  repoPath: string
  alert?: boolean
}

async function seedBase(db: Db): Promise<void> {
  for (const id of ['admin', 'alice', 'bob']) {
    await db.insert(users).values({
      id,
      username: id,
      displayName: id,
      role: id === 'admin' ? 'admin' : 'user',
      createdAt: 1,
      updatedAt: 1,
    })
  }
  await db.insert(workflows).values({ id: 'wf1', name: 'nightly-audit', definition: '{}' })
  await db.insert(workflows).values({ id: 'wf2', name: 'release-train', definition: '{}' })
}

async function insertForest(db: Db, rows: SeedTask[]): Promise<void> {
  for (const r of rows) {
    await db.insert(tasks).values({
      id: r.id,
      name: `task ${r.id}`,
      workflowId: r.id.endsWith('3') ? 'wf2' : 'wf1',
      workflowSnapshot: '{}',
      repoPath: r.repoPath,
      repoUrl: `git@github.com:acme/${r.repoPath.split('/').pop()}.git`,
      worktreePath: `/tmp/wt-${r.id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${r.id}`,
      status: r.status,
      inputs: '{}',
      startedAt: r.startedAt,
      finishedAt: r.status === 'done' || r.status === 'failed' ? r.startedAt + 10 : null,
      runningMs: 0,
      ownerUserId: r.owner,
      parentTaskId: r.parent ?? null,
      invocationDepth: r.parent === undefined ? 0 : 1,
      launchOrigin: r.origin,
      workgroupId: r.workgroup ?? null,
      workgroupConfigJson:
        r.workgroup === undefined
          ? null
          : JSON.stringify({ workgroupName: `squad-${r.workgroup}` }),
      sourceAgentName: r.agentName ?? null,
      branchStartedAt: 0,
      // 故意留空:下面跑 migration 0183 的真实回填 SQL 把它算出来,
      // 这样 oracle 顺带成为回填算法的验收。
      rootTaskId: null,
    })
    await db.insert(taskRepos).values({
      taskId: r.id,
      repoIndex: 0,
      repoPath: r.repoPath,
      repoUrl: `git@github.com:acme/${r.repoPath.split('/').pop()}.git`,
      worktreePath: `/tmp/wt-${r.id}`,
      branch: `agent-workflow/${r.id}`,
    })
    if (r.alert === true) {
      await db.insert(lifecycleAlerts).values({
        id: `al-${r.id}`,
        taskId: r.id,
        rule: 'stuck',
        severity: 'warn',
        detail: 'seeded for the attention view',
        detectedAt: r.startedAt,
        resolvedAt: null,
      })
    }
  }
  applyBackfill(
    db,
    '0180_rfc311_perf_indexes.sql',
    (statement) =>
      statement.includes('_rfc311_branch_backfill') ||
      statement.startsWith('UPDATE `tasks` SET `branch_started_at`'),
  )
  applyBackfill(
    db,
    '0183_rfc311_tasks_root_task_id.sql',
    (statement) =>
      statement.startsWith('WITH RECURSIVE walk') ||
      statement.startsWith('UPDATE tasks SET root_task_id = id'),
  )
}

function applyBackfill(db: Db, file: string, keep: (statement: string) => boolean): void {
  const statements = readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.replace(/^--.*$/gm, '').trim())
    .filter(keep)
  for (const statement of statements) db.run(sql.raw(statement))
}

/** 确定性伪随机森林:多 owner / 多状态 / 两层父子 / 工作组 / 代理 / 来源 / 告警。 */
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
  const origins: SeedTask['origin'][] = ['manual', 'scheduled', 'webhook']
  const repos = ['/srv/repos/alpha', '/srv/repos/beta', '/srv/repos/gamma-service']
  const rows: SeedTask[] = []
  let seed = 7
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let i = 0; i < count; i += 1) {
    const id = `t${String(i).padStart(3, '0')}`
    // 只让**已有的**任务当父，且允许两层以上（父本身可能已经有父）。
    const parent = i > 2 && rand(3) === 0 ? rows[rand(rows.length)]?.id : undefined
    const flavour = rand(3)
    rows.push({
      id,
      owner: owners[rand(owners.length)]!,
      status: statuses[rand(statuses.length)]!,
      startedAt: 1_000 + i * 37 + rand(20),
      ...(parent !== undefined ? { parent } : {}),
      ...(flavour === 0 ? { workgroup: `wg${rand(2)}` } : {}),
      ...(flavour === 1 ? { agentName: `auditor-${rand(2)}` } : {}),
      origin: origins[rand(origins.length)]!,
      repoPath: repos[rand(repos.length)]!,
      ...(rand(4) === 0 ? { alert: true } : {}),
    })
  }
  return rows
}

async function collectPages(
  db: Db,
  who: Actor,
  query: Record<string, string>,
  limit: number,
  pipeline: 'auto' | 'exhaustive',
): Promise<{ items: TaskOperationsListItem[]; facets: unknown; pages: number }> {
  const items: TaskOperationsListItem[] = []
  let cursor: string | undefined
  let facets: unknown
  let pages = 0
  for (; pages < 40; pages += 1) {
    const result = await listTaskOperationsPage(
      db,
      who,
      { ...query, limit: String(limit), ...(cursor !== undefined ? { cursor } : {}) },
      { pipeline },
    )
    items.push(...result.items)
    if (result.kind === 'root' && facets === undefined) facets = result.facets
    if (result.nextCursor === null) break
    cursor = result.nextCursor
  }
  return { items, facets, pages }
}

/** 过滤组合矩阵。刻意包含「命中零行」与「命中全部」两个极端。 */
const FILTER_MATRIX: Array<Record<string, string>> = [
  { statuses: 'running' },
  { statuses: 'done,failed' },
  { statuses: 'pending,awaiting_review,canceled' },
  { view: 'active' },
  { view: 'finished' },
  { view: 'attention' },
  { view: 'active', statuses: 'running' },
  { view: 'attention', statuses: 'failed' },
  { subject: 'workgroup' },
  { subject: 'agent' },
  { subject: 'workflow' },
  { subject: 'workgroup', view: 'active' },
  { origin: 'manual' },
  { origin: 'scheduled' },
  { origin: 'webhook', view: 'finished' },
  { q: 'gamma' },
  { q: 'squad-wg1' },
  { q: 'auditor-1' },
  { q: 'release-train' },
  { q: 't01' },
  { q: 'zzz-no-such-thing' },
  { q: 'alpha', statuses: 'done' },
  { scope: 'mine' },
  { scope: 'mine', view: 'active' },
  { scope: 'shared' },
  { statuses: 'running', origin: 'manual', subject: 'workgroup' },
  { view: 'attention', q: 'beta' },
]

describe('RFC-311 G1 — filtered fast path === exhaustive pipeline', () => {
  test('every filter combination matches page-for-page, for every actor', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await insertForest(db, buildForest(70))

    let nonEmpty = 0
    for (const who of [actor('admin', 'admin'), actor('alice'), actor('bob')]) {
      for (const filters of FILTER_MATRIX) {
        const fast = await collectPages(db, who, filters, 4, 'auto')
        const slow = await collectPages(db, who, filters, 4, 'exhaustive')
        const label = `${who.user.id} ${JSON.stringify(filters)}`
        expect(
          fast.items.map((i) => i.id),
          label,
        ).toEqual(slow.items.map((i) => i.id))
        expect(fast.items, label).toEqual(slow.items)
        expect(fast.facets, label).toEqual(slow.facets)
        if (fast.items.length > 0) nonEmpty += 1
      }
    }
    // 防「矩阵全空 ⇒ 恒等」的空洞绿:多数组合必须真的返回了行。
    expect(nonEmpty).toBeGreaterThan(FILTER_MATRIX.length)
  })

  test('context ancestors and branch aggregates survive the rewrite', async () => {
    // 手工构造一棵树:只有孙子匹配 ⇒ 父与祖父必须作为 context 出现在同一分支里,
    // 且排序键取**匹配行**的 started_at（不是子树里最新的那一行）。
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await insertForest(db, [
      {
        id: 'root',
        owner: 'alice',
        status: 'done',
        startedAt: 9_000,
        origin: 'manual',
        repoPath: '/srv/repos/alpha',
      },
      {
        id: 'mid',
        owner: 'alice',
        status: 'done',
        startedAt: 8_000,
        parent: 'root',
        origin: 'manual',
        repoPath: '/srv/repos/alpha',
      },
      {
        id: 'leaf',
        owner: 'alice',
        status: 'running',
        startedAt: 5_000,
        parent: 'mid',
        origin: 'manual',
        repoPath: '/srv/repos/alpha',
      },
      {
        id: 'other',
        owner: 'alice',
        status: 'running',
        startedAt: 6_000,
        origin: 'manual',
        repoPath: '/srv/repos/beta',
      },
    ])
    const who = actor('admin', 'admin')
    const fast = await collectPages(db, who, { statuses: 'running' }, 10, 'auto')
    const slow = await collectPages(db, who, { statuses: 'running' }, 10, 'exhaustive')
    expect(fast.items).toEqual(slow.items)

    const rootRow = fast.items.find((i) => i.id === 'root')
    expect(rootRow, 'the invisible-to-filter ancestor must still anchor its branch').toBeDefined()
    expect(rootRow!.listContext.matchKind).toBe('context')
    // 排序键 = 匹配行 leaf 的 started_at(5000)，而不是子树最新的 root 自己(9000);
    // 所以 root 排在 other(6000) 后面——这条正是「分支排序键取匹配行」的判据。
    expect(fast.items.map((i) => i.id)).toEqual(['other', 'root'])
    expect(rootRow!.listContext.branchStartedAt).toBe(5_000)
    expect(rootRow!.listContext.matchingDescendantCount).toBe(1)
    // 直接子 mid 自身不匹配,但它是匹配行 leaf 的祖先 ⇒ 属于合格集,计入。
    expect(rootRow!.listContext.qualifyingChildCount).toBe(1)
  })

  // 快路径把 root_task_id 当分组键。任何**没落根**的行（绕过服务层的裸 SQL 插入、
  // 或将来某条迁移漏了回填）都会被当成自己的根静默挂错分支——用户看到的是「某个
  // 子任务突然自成一行」，没有报错、没有日志。所以准入闸门先问一句「还有没有未
  // 落根的行」，有就整条退回旧管线。这条锁的是「宁可慢、不可错」。
  test('one unrooted row disables the fast path instead of silently mis-branching', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await insertForest(db, buildForest(20))
    expect(await hasUnrootedTasks(db)).toBe(false)

    // 模拟绕过服务层的写入:有父、但没落根。
    const parent = (await db.select({ id: tasks.id }).from(tasks).limit(1))[0]!.id
    db.run(
      sql.raw(`INSERT INTO tasks (
        id, name, workflow_id, workflow_snapshot, repo_path, worktree_path, base_branch, branch,
        status, inputs, started_at, running_ms, owner_user_id, parent_task_id, invocation_depth,
        launch_origin, branch_started_at, root_task_id
      ) VALUES (
        'orphan', 'orphan', 'wf1', '{}', '/srv/repos/alpha', '/tmp/wt-orphan', 'main',
        'agent-workflow/orphan', 'running', '{}', 9999, 0, 'alice', '${parent}', 1, 'manual', 9999, NULL
      )`),
    )
    expect(await hasUnrootedTasks(db)).toBe(true)

    const who = actor('admin', 'admin')
    const auto = await collectPages(db, who, { statuses: 'running' }, 5, 'auto')
    const slow = await collectPages(db, who, { statuses: 'running' }, 5, 'exhaustive')
    expect(auto.items).toEqual(slow.items)
    // 判据不是「相等」而已——没有闸门时这一行会作为**自己的 root** 冒出来。
    expect(auto.items.some((i) => i.id === 'orphan')).toBe(false)
  })

  test('the filtered fast path is actually the one under test (not a silent fallback)', () => {
    const admin = actor('admin', 'admin')
    const user = actor('alice')
    const filters = {
      scope: 'all' as const,
      view: 'all' as const,
      statuses: ['running' as const],
      subject: 'all' as const,
      origin: 'all' as const,
      q: undefined,
    }
    // 有过滤 ⇒ 默认快路径不接；admin 走过滤快路径，受限 actor 仍回旧管线。
    expect(isDefaultView(admin, filters)).toBe(false)
    expect(canUseFilteredFastPath(admin)).toBe(true)
    expect(canUseFilteredFastPath(user)).toBe(false)
  })
})
