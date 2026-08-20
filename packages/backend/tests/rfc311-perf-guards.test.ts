// RFC-311 —— 数据库性能的**结构性**防护网。
//
// 背景：生产 2.2GB 库上「所有操作都慢」的六路审计里，真正咬人的不是某条慢 SQL，
// 而是四类**形状**问题：①N+1（每行再查一次）；②全表扫 / 排序（缺索引或排序键与
// 索引不匹配）；③无界 `IN (…)`（SQLite 32766 绑定参数硬上限，超了直接抛）；
// ④全列投影（把只在详情页读的大字段塞进列表）。它们的共同点是**加数据才现形**，
// 单元测试在 5 行的库上永远绿。
//
// 现有防护为什么不够：
//   - CI 的 `Perf microbenchmark gate` 只跑纯 CPU 函数（workflow parse / envelope /
//     redact / safe-join），**数据库面零覆盖**；
//   - 既有的计划断言把 SQL **字面量抄进测试**，只能锁住抄进去的那一条，实现换了
//     形状照样绿，而且没人会记得给新查询补断言。
//
// 这里换一条路：让被测代码正常跑，用 `recordStatements` 把它**实际执行**的每条语句
// 连同绑定参数抓下来，再对**每一条**做统一审计。新增查询自动进入审计面。
//
// 三条不变量，全部**确定性**（不看墙钟，因此可以进每次 PR 的门禁而不 flaky）：
//   1. **语句条数不随行数增长**：同一路径在 4 行库与 40 行库上执行的语句数必须
//      **完全相等**。这是 N+1 的充要形态，且不需要写死任何魔数。
//   2. **不许扫大表、不许临时排序**：每条 SELECT 的 EXPLAIN QUERY PLAN 里不得出现
//      `SCAN <大表>` 或 `USE TEMP B-TREE`。EXPLAIN 用**绑定参数**跑——字面量下
//      SQLite 会选出生产里根本不存在的计划（RFC-311 实测：展开式断点用字面量看不出
//      MULTI-INDEX OR + TEMP B-TREE 全排序）。
//   3. **绑定参数有界**：任何一条语句的参数个数不得超过 900，离 32766 的悬崖足够远。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  cachedRepos,
  developmentMissions,
  taskRepos,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import { listMissionSummariesPage } from '../src/modules/development-automation/infrastructure/missionReadModels'
import { listCachedReposPage } from '../src/services/gitRepoCache'
import { buildOverview } from '../src/services/overview'
import { listTaskOperationsPage } from '../src/services/taskOperations'
import { recordStatements, type RecordedStatement } from './helpers/statementRecorder'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const T0 = 1_700_000_000_000

/**
 * 会无界增长的表。列表页碰它们必须走索引；扫这些表 = 生产上随数据量线性变慢。
 * 配置类小表（users / workflows / settings…）不在此列，扫它们是合理的。
 */
const UNBOUNDED_TABLES = [
  'tasks',
  'task_repos',
  'node_runs',
  'events',
  'cached_repos',
  'development_missions',
] as const

const MAX_BOUND_PARAMS = 900

function actorOf(id: string, role: 'admin' | 'user' = 'admin'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seed(db: DbClient, n: number): Promise<void> {
  await db.insert(users).values({
    id: 'admin',
    username: 'admin',
    displayName: 'admin',
    role: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({ id: 'wf1', name: 'nightly', definition: '{}' })
  for (let i = 0; i < n; i += 1) {
    const id = `t${String(i).padStart(4, '0')}`
    await db.insert(tasks).values({
      id,
      name: `task ${id}`,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: `/repos/r${i % 7}`,
      repoUrl: `git@github.com:acme/r${i % 7}.git`,
      worktreePath: `/tmp/wt-${id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: i % 3 === 0 ? 'running' : 'done',
      inputs: '{}',
      startedAt: T0 + i * 1_000,
      finishedAt: i % 3 === 0 ? null : T0 + i * 1_000 + 10,
      runningMs: 0,
      ownerUserId: 'admin',
      parentTaskId: null,
      invocationDepth: 0,
      launchOrigin: 'manual',
      branchStartedAt: T0 + i * 1_000,
      // 根任务自指:0183 的准入闸门要求全库无未落根行,否则整条退回旧管线,
      // 那样这套防护就在审计一条生产上不会走的路径。
      rootTaskId: id,
    })
    await db.insert(taskRepos).values({
      taskId: id,
      repoIndex: 0,
      repoPath: `/repos/r${i % 7}`,
      repoUrl: `git@github.com:acme/r${i % 7}.git`,
      worktreePath: `/tmp/wt-${id}`,
      branch: `agent-workflow/${id}`,
      baseBranch: 'main',
    })
    await db.insert(cachedRepos).values({
      id: `repo${String(i).padStart(4, '0')}`,
      urlHash: `hash-${i}`,
      urlRedacted: `git@github.com:acme/c${i}.git`,
      localPath: `/cache/c${i}`,
      defaultBranch: 'main',
      lastFetchedAt: T0 + i * 1_000,
      createdAt: T0,
      // facets 里有一格数「子模块同步失败」——播出两种取值，否则那条谓词永远命中
      // 空集，索引用没用上都看不出来。
      hasSubmodules: i % 4 === 0,
      lastSubmoduleSyncOk: i % 8 !== 0,
    })
    await db.insert(developmentMissions).values({
      id: `m${String(i).padStart(4, '0')}`,
      revision: 1,
      status: 'working',
      automationMode: 'auto',
      transitionFence: 'none',
      repositoryId: `repo${String(i).padStart(4, '0')}`,
      sourceKind: 'direct-input',
      deliveryKind: 'merge-request',
      createdAt: T0 + i * 1_000,
      updatedAt: T0 + i * 1_000,
    })
  }
}

interface GuardedPath {
  readonly name: string
  run(db: DbClient): Promise<unknown>
}

/**
 * 受防护的读路径。**新增列表 / 计数端点请加进来**——加一行的成本远低于再来一次
 * 「生产上所有操作都慢」的审计。
 */
const GUARDED: GuardedPath[] = [
  {
    name: '/api/tasks/page — 默认视图首页',
    run: (db) => listTaskOperationsPage(db, actorOf('admin'), {}),
  },
  {
    name: '/api/tasks/page — 过滤视图（G1 快路径）',
    run: (db) => listTaskOperationsPage(db, actorOf('admin'), { statuses: 'running' }),
  },
  {
    name: '/api/cached-repos — keyset 首页',
    run: (db) => listCachedReposPage(db, { limit: 20 }),
  },
  {
    name: '/api/code/missions — keyset 首页',
    run: async (db) => listMissionSummariesPage(db, { limit: 20 }),
  },
  {
    name: '/api/overview — 计数面板',
    run: (db) => buildOverview(db, actorOf('admin')),
  },
]

async function capture(n: number, path: GuardedPath): Promise<RecordedStatement[]> {
  const db = createInMemoryDb(MIGRATIONS)
  await seed(db, n)
  const raw = (db as unknown as { $client: Parameters<typeof recordStatements>[0] }).$client
  const rec = recordStatements(raw)
  try {
    await path.run(db)
  } finally {
    rec.stop()
  }
  return rec.statements
}

function planOf(db: DbClient, stmt: RecordedStatement): string {
  const raw = (
    db as unknown as { $client: { prepare(q: string): { all(...a: unknown[]): unknown[] } } }
  ).$client
  const args = Array.from({ length: stmt.params }, () => null)
  const rows = raw.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`).all(...args) as Array<{
    detail: string
  }>
  return rows.map((r) => r.detail).join('\n')
}

describe('RFC-311 性能防护 —— 每条受防护读路径的三条结构性不变量', () => {
  test.each(GUARDED.map((p) => [p.name, p] as const))(
    '%s',
    async (_name, path) => {
      const small = await capture(4, path)
      const large = await capture(40, path)

      // ① N+1：语句条数必须与行数无关。
      const summarize = (s: RecordedStatement[]): string[] =>
        s.map((x) => x.sql.replace(/\s+/g, ' ').slice(0, 90))
      expect(
        large.length,
        `语句条数随行数增长（4 行 ${small.length} 条 → 40 行 ${large.length} 条）= N+1。\n` +
          `40 行时执行的语句：\n${summarize(large).join('\n')}`,
      ).toBe(small.length)

      // ③ 绑定参数有界（SQLite 硬上限 32766，无界 IN(…) 会在生产上直接抛）。
      const worst = large.reduce((m, s) => Math.max(m, s.params), 0)
      expect(
        worst,
        `某条语句绑定了 ${worst} 个参数，逼近 SQLite 的 32766 上限`,
      ).toBeLessThanOrEqual(MAX_BOUND_PARAMS)

      // ② 计划：不许扫大表、不许临时排序。
      const db = createInMemoryDb(MIGRATIONS)
      await seed(db, 40)
      const offenders: string[] = []
      for (const stmt of large.filter((s) => /^\s*select/i.test(s.sql))) {
        let plan: string
        try {
          plan = planOf(db, stmt)
        } catch {
          continue // EXPLAIN 解释不了的（CTE 里的临时构造等）跳过，不假装审计过
        }
        for (const table of UNBOUNDED_TABLES) {
          // SQLite 把**有序索引扫描**也叫 SCAN（`SCAN t USING COVERING INDEX ix`），
          // 那正是 keyset 首页该有的形态（顺着索引走、到 LIMIT 就停），不是缺陷。
          // 真正要拦的是**没有 USING** 的裸表扫描。
          if (new RegExp(`SCAN ${table}(?! USING)\\b`).test(plan))
            offenders.push(
              `SCAN ${table}（裸表扫描）\n  SQL: ${stmt.sql.replace(/\s+/g, ' ').slice(0, 160)}`,
            )
        }
        if (/USE TEMP B-TREE/.test(plan))
          offenders.push(
            `TEMP B-TREE\n  SQL: ${stmt.sql.replace(/\s+/g, ' ').slice(0, 160)}\n  PLAN: ${plan}`,
          )
      }
      expect(offenders, `这些语句会随数据量线性变慢：\n${offenders.join('\n')}`).toEqual([])
    },
    30_000,
  )
})

// 枚举型守卫必须先断言自己的枚举面（本仓已有的定式：不然「没找到违规」和「没扫到
// 东西」同形）。
describe('RFC-311 性能防护 —— 防护面本身不许缩水', () => {
  test('guarded read paths stay registered', () => {
    expect(GUARDED.length).toBeGreaterThanOrEqual(5)
    expect(new Set(GUARDED.map((p) => p.name)).size).toBe(GUARDED.length)
    expect(UNBOUNDED_TABLES.length).toBeGreaterThanOrEqual(6)
  })
})
