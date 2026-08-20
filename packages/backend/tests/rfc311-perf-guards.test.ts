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
//   1. **语句条数不随行数增长**：同一路径在两种规模的库上执行的语句数必须**完全
//      相等**。这是 N+1 的充要形态，且不需要写死任何魔数。
//   2. **不许扫大表、不许临时排序**：每条 SELECT 的 EXPLAIN QUERY PLAN 里不得出现
//      `SCAN <大表>` 或 `USE TEMP B-TREE`。EXPLAIN 用**绑定参数**跑——字面量下
//      SQLite 会选出生产里根本不存在的计划（RFC-311 实测：展开式断点用字面量看不出
//      MULTI-INDEX OR + TEMP B-TREE 全排序）。
//   3. **绑定参数有界**：任何一条语句的参数个数不得超过 900，离 32766 的悬崖足够远。
//   4. **取回的行数不随行数增长**：形状对了不代表体量对了。一条走索引、只发一次的
//      SELECT 照样能把整张表搬进内存——旧的 `listMissionSummaries` 正是如此，它在
//      只看计划的前三条判据下**完全干净**（实测过：塞进注册表 7 pass 0 fail）。这条
//      是 RFC-311 立项动机（/tasks 2000 行、/repos 280 行就卡）的直接判据。
//
// 两种规模**都要大到连被过滤后的子集也超过页上限**（200 / 500，各路径上限最大 50，
// 而过滤视图只有 1/3 的行命中）：分页路径两次都只取回一页，无界路径才会跟着库长。
// 规模取小了会把「返回 min(limit, N)」这种正确行为误判成增长——前两版判据先后栽在
// 这两处（4/40 太小、80/200 对过滤视图仍太小）。
//
//   5. **列表查询不碰重列**：行数有界、走索引，仍可能每行搬回 10KB——RFC-311 审计
//      的 L2「窄投影」正是这一类（node_runs 平均每行 10.5KB，其中 prompt_text 占
//      57%，而它只在详情页被读）。重列**按命名派生**而非人工枚举（`*_json` /
//      `*_snapshot` / `*_text` / stdout / inputs / outputs…），所以新加的列自动纳入，
//      判据不会因为有人忘了登记而失效。
//
// 另：计划审计**不只看 SELECT**。历史上最恶劣的一次是归档器的 DELETE（无界 IN 撞
// 32766 上限死循环），写语句的计划同样要审。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

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
import { archiveEvents } from '../src/services/eventsArchive'
import { listCachedReposPage } from '../src/services/gitRepoCache'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'
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
/** 单条语句一次最多取回多少行——分块的证据。超过它说明这一拍把表整片搬了。 */
const MAX_CHUNK_ROWS = 5_000

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
  /**
   * - `list`：分页/计数读面，受全部五条约束。
   * - `sweep`：周期维护（归档器、巡检…）。它**天生就是 O(全表)**——那正是它的职责，
   *   所以豁免「取回行数不随库增长」；但**每一拍必须分块**，因此仍受「单条语句取回
   *   行数有上界」「绑定参数有界」「计划不许裸扫」约束。历史上最恶劣的一次事故正是
   *   归档器把无界 id 列表塞进 `IN (…)` 撞 32766 上限死循环。
   * - `detail`：详情读面，按定义要读重列，豁免第五条。
   */
  readonly kind?: 'list' | 'sweep' | 'detail'
  /**
   * 仅 sweep 可用：**每行允许发多少条语句**的上界。写在这里等于公开承认「这条路径
   * 还是 O(行数) 条语句」，并把它钉成只许降不许升的棘轮——比让它豁免诚实，也比假装
   * 它是 O(1) 有用。填这个字段必须同时写清为什么还没消。
   */
  readonly maxStatementsPerRow?: number
  run(db: DbClient): Promise<unknown>
}

/**
 * 重列：按**命名约定**派生，不是人工清单——新加的 `*_json` 自动是重列，判据不会
 * 因为有人忘了登记而悄悄失效。
 */
function heavyColumns(): string[] {
  const schema = readFileSync(resolve(import.meta.dir, '..', 'src', 'db', 'schema.ts'), 'utf-8')
  const cols = new Set(Array.from(schema.matchAll(/text\('([a-z0-9_]+)'\)/g), (m) => m[1]!))
  return [...cols].filter(
    (c) =>
      /(_json|_snapshot|_text|_body|_md|_yaml)$/.test(c) ||
      ['stdout', 'stderr', 'inputs', 'outputs', 'definition'].includes(c),
  )
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
  // 周期任务：历史事故密度最高的地方（归档器无界 IN 撞 32766 死循环、备份 VACUUM
  // 全站冻结 30-90 秒），而它们此前一条都没被防护网跑到。
  {
    name: '事件归档器（小时级 sweep）',
    kind: 'sweep',
    run: async (db) => {
      const logsDir = mkdtempSync(join(tmpdir(), 'aw-perf-guard-logs-'))
      try {
        return await archiveEvents(
          db,
          {
            eventsArchiveThresholds: {
              perNodeRunRows: 5,
              globalRows: 10,
              perNodeRunBytes: 0,
              globalBytes: 0,
            },
          },
          logsDir,
        )
      } finally {
        rmSync(logsDir, { recursive: true, force: true })
      }
    },
  },
  {
    name: '生命周期不变量巡检（sweep）',
    kind: 'sweep',
    // 实测 500 行发 1503 条 ≈ 3.0 条/行——这是 RFC-311 T14 明确**延后**的那笔债
    // （「invariants 七规则集合化延后；分块 + 让出已消掉坏死与长冻结」）。分块已经
    // 让它不再冻结主连接，但每条规则仍逐任务查一次。集合化之前，先把比率钉住。
    maxStatementsPerRow: 3.1,
    run: (db) => runLifecycleInvariants({ db, scope: { all: true } }),
  },
]

const SMALL = 200
const LARGE = 500

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

describe('RFC-311 性能防护 —— 每条受防护读路径的四条结构性不变量', () => {
  test.each(GUARDED.map((p) => [p.name, p] as const))(
    '%s',
    async (_name, path) => {
      const small = await capture(SMALL, path)
      const large = await capture(LARGE, path)

      // ① N+1：语句条数必须与行数无关。
      const summarize = (s: RecordedStatement[]): string[] =>
        s.map((x) => x.sql.replace(/\s+/g, ' ').slice(0, 90))
      if (path.maxStatementsPerRow === undefined) {
        expect(
          large.length,
          `语句条数随行数增长（${SMALL} 行 ${small.length} 条 → ${LARGE} 行 ${large.length} 条）= N+1。\n` +
            `${LARGE} 行时执行的语句：\n${summarize(large).join('\n')}`,
        ).toBe(small.length)
      } else {
        // 已知仍是 O(行数) 条的 sweep：钉住比率，只许降不许升。
        const perRow = large.length / LARGE
        expect(
          perRow,
          `每行语句数从记录的 ${path.maxStatementsPerRow} 涨到了 ${perRow.toFixed(2)}` +
            `（${LARGE} 行发了 ${large.length} 条）。这条路径本就欠着集合化，别让它更差。`,
        ).toBeLessThanOrEqual(path.maxStatementsPerRow)
      }

      // ④a 分块：任何**单条**语句一次取回的行数有上界。对 sweep 这是唯一可查的
      //     「有没有分块」信号；对 list 它是④的兜底。
      const widest = large.reduce((m, x) => Math.max(m, x.rows), 0)
      expect(
        widest,
        `有语句一次取回 ${widest} 行——这一拍把表整片搬进了内存，没有分块。`,
      ).toBeLessThanOrEqual(MAX_CHUNK_ROWS)

      // ④b 体量：取回的**总**行数不随库里行数增长。这是「无界结果集」唯一的可靠
      //     信号，与①正交（①数**发了几条**，④数**搬回来多少行**）。
      //     sweep 豁免——它的职责就是遍历全表，见 GuardedPath.kind 的注释。
      const rowsOf = (s: RecordedStatement[]): number => s.reduce((n, x) => n + x.rows, 0)
      if ((path.kind ?? 'list') !== 'sweep')
        expect(
          rowsOf(large),
          `取回行数随库增长（${SMALL} 行库取回 ${rowsOf(small)} 行 → ${LARGE} 行库取回 ${rowsOf(large)} 行）：\n` +
            `这条路径没有上界，库长大就会把整张表搬进内存（RFC-311 的立项动机）。\n` +
            large
              .filter((x) => x.rows > 0)
              .map((x) => `  ${x.rows} 行 ← ${x.sql.replace(/\s+/g, ' ').slice(0, 110)}`)
              .join('\n'),
        ).toBe(rowsOf(small))

      // ⑤ 列表查询不碰重列（详情路径豁免——它本来就是去读正文的）。
      if ((path.kind ?? 'list') === 'list') {
        const heavy = heavyColumns()
        const touched = new Set<string>()
        for (const stmt of large) {
          for (const col of heavy) {
            if (new RegExp(`"${col}"`).test(stmt.sql)) touched.add(col)
          }
        }
        expect(
          [...touched].sort(),
          `列表路径读了重列：这些字段只在详情页用，却让每一行都跟着读溢出页\n` +
            `（RFC-311 审计的 L2「窄投影」类）。把投影收窄到列表 DTO 真正用到的列。`,
        ).toEqual([])
      }

      // ③ 绑定参数有界（SQLite 硬上限 32766，无界 IN(…) 会在生产上直接抛）。
      const worst = large.reduce((m, s) => Math.max(m, s.params), 0)
      expect(
        worst,
        `某条语句绑定了 ${worst} 个参数，逼近 SQLite 的 32766 上限`,
      ).toBeLessThanOrEqual(MAX_BOUND_PARAMS)

      // ② 计划：不许扫大表、不许临时排序。
      const db = createInMemoryDb(MIGRATIONS)
      await seed(db, LARGE)
      const offenders: string[] = []
      // 读写都审：归档器那次死循环就在 DELETE 上。
      for (const stmt of large.filter((s) => /^\s*(select|delete|update)/i.test(s.sql))) {
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

// 注册表是**主动登记**的：它只保护有人记得加进来的路径。新写一个 `.all()` 全表读
// 不会被它看见——这就是这套防护最大的结构性洞（本仓已有定式：枚举型守卫必须先断言
// 自己的枚举面）。补法不是把几十处存量一次修完（那是另一个 RFC 的工作量），而是给
// 暴露面上一条**棘轮**：只许减、不许增，并把清单打出来，让新增者当场看见自己踩到
// 了什么。
//
// 判据是文本启发式，**会漏也会误**：漏掉裸 SQL、`.get()`、动态拼接的构建器；也可能
// 把确实有界（上游已按主键取过）的链算进来。它的价值不在精确，而在**单调**——同一
// 把尺子量出来的数只要不涨，就没有新的无界读进来。
const UNBOUNDED_READ_RATCHET = 38

describe('RFC-311 性能防护 —— 未受保护的无界读只许减不许增', () => {
  test('no new unbounded .all() reads on growing tables', () => {
    const src = resolve(import.meta.dir, '..', 'src')
    const names = ['tasks', 'taskRepos', 'nodeRuns', 'events', 'cachedRepos', 'developmentMissions']
    const pattern = new RegExp(
      `\\.from\\((${names.join('|')})\\)([\\s\\S]{0,400}?)\\.all\\(\\)`,
      'g',
    )
    const hits: string[] = []
    let scanned = 0
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        scanned += 1
        const norm = readFileSync(full, 'utf-8').replace(/\s+/g, ' ')
        for (const m of norm.matchAll(pattern)) {
          if (!m[2]!.includes('.limit(')) hits.push(`${relative(src, full)}  ←  ${m[1]}`)
        }
      }
    }
    walk(src)

    // 失败关闭：扫描面本身要有下界，否则「没找到」与「没扫到」同形。
    expect(scanned).toBeGreaterThan(200)
    expect(
      hits.length,
      `未受保护的无界读从 ${UNBOUNDED_READ_RATCHET} 涨到了 ${hits.length}。\n` +
        `新增的读点要么接分页、要么加进上面的 GUARDED 注册表；确实无界且可接受的，\n` +
        `连同理由一起调低/说明这条棘轮。当前清单：\n${[...new Set(hits)].sort().join('\n')}`,
    ).toBeLessThanOrEqual(UNBOUNDED_READ_RATCHET)
  })
})
