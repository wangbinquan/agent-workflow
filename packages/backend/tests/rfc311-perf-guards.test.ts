// RFC-311 —— 数据库性能的**结构性**防护网。**RFC-359 W6-T27 起两个引擎各跑一遍。**
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
// 这里换一条路：让被测代码正常跑，用 `harness.recordStatements()` 把它**实际执行**的
// 每条语句连同绑定参数抓下来，再对**每一条**做统一审计。新增查询自动进入审计面。
//
// 四条不变量，全部**确定性**（不看墙钟，因此可以进每次 PR 的门禁而不 flaky）：
//   1. **语句条数不随行数增长**：同一路径在两种规模的库上执行的语句数必须**完全
//      相等**。这是 N+1 的充要形态，且不需要写死任何魔数。
//   3. **绑定参数有界**：任何一条语句的参数个数不得超过 900，离 SQLite 32766 的悬崖
//      足够远（PostgreSQL 的上限是 65535，同一个数对两个引擎都安全）。
//   4. **取回的行数不随行数增长**：形状对了不代表体量对了。一条走索引、只发一次的
//      SELECT 照样能把整张表搬进内存——旧的 `listMissionSummaries` 正是如此，它在
//      只看计划的前三条判据下**完全干净**（实测过：塞进注册表 7 pass 0 fail）。这条
//      是 RFC-311 立项动机（/tasks 2000 行、/repos 280 行就卡）的直接判据。
//   5. **列表查询不碰重列**：行数有界、走索引，仍可能每行搬回 10KB——RFC-311 审计
//      的 L2「窄投影」正是这一类（node_runs 平均每行 10.5KB，其中 prompt_text 占
//      57%，而它只在详情页被读）。重列**按命名派生**而非人工枚举（`*_json` /
//      `*_snapshot` / `*_text` / stdout / inputs / outputs…），所以新加的列自动纳入，
//      判据不会因为有人忘了登记而失效。
//
// 第②条（计划审计：不许扫大表、不许临时排序）**只在 SQLite 上跑**，见下面
// `assertPlans` 的注释——PostgreSQL 侧的计划审计由
// `rfc359-w6-t26-postgresql-plan-audit.test.ts` 在一万行语料上用真 `EXPLAIN (ANALYZE,
// BUFFERS)` 承担。在这里 500 行的语料上断言 PostgreSQL 的计划，断的是「表小」不是「缺索引」。
//
// 两种规模**都要大到连被过滤后的子集也超过页上限**（200 / 500，各路径上限最大 50，
// 而过滤视图只有 1/3 的行命中）：分页路径两次都只取回一页，无界路径才会跟着库长。
// 规模取小了会把「返回 min(limit, N)」这种正确行为误判成增长——前两版判据先后栽在
// 这两处（4/40 太小、80/200 对过滤视图仍太小）。
//
// 另：计划审计**不只看 SELECT**。历史上最恶劣的一次是归档器的 DELETE（无界 IN 撞
// 32766 上限死循环），写语句的计划同样要审。
//
// # AC-11 的诊断支撑；不替代原 P95 验收
//
// 以下跨引擎结构比较锁语句条数、取回行数和单条语句最大绑定参数，防止重复往返、
// 无界物化等回归。它们不衡量端点时延，不能证明 proposal AC-11 要求的
// 「PostgreSQL 各端点 P95 不劣于 SQLite」已经成立；原条款仍未闭合。
//
// 两引擎在本文件 500 行语料上的 P95 继续采集打印，作为定位线索；九次采样的 P95
// 实为最大样本，不能冒充完整 RFC-311 基准库上的端点验收。唯一带毫秒的断言只是
// 离噪声极远的塌方阈值（见 CATASTROPHE_RATIO），通过也不代表原时延条款通过。
// 各路径实际调用的函数见 GUARDED，生产装配覆盖与结构成本必须分别核验。

import { afterAll, describe, expect, test } from 'bun:test'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { buildActor, type Actor } from '../src/auth/actor'
import type { ProviderNeutralDatabase } from '../src/db/query'
import {
  cachedRepos,
  developmentMissions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRuns,
  taskRepos,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import {
  listMissionSummariesPage,
  listMissionTerminalOutcomeGroups,
} from '../src/modules/development-automation/infrastructure/missionReadModels'
import {
  composeRepositoryWorkspaceOperations,
  composeSqliteRepositoryWorkspaceStore,
} from '../src/modules/source-control/composition'
import { archiveEvents } from '../src/services/eventsArchive'
import { listCachedReposPage } from '../src/services/gitRepoCache'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'
import { buildOverview } from '../src/services/overview'
import {
  describeEachProvider,
  resolveTestProviders,
  type ProviderHarness,
} from './helpers/eachProvider'
import { memoryCatalogOf } from './helpers/memoryCatalog'
import { resourceScopeAuthority } from './helpers/resourceScopeAuthority'
import { listTaskOperationsPage } from './helpers/taskListPage'
import type { RecordedStatement } from './helpers/statementRecorder'

const T0 = 1_700_000_000_000
const LEGACY_TERMINAL_STATUSES = [
  'merged',
  'completed-no-change',
  'closed-unmerged',
  'canceled',
  'failed',
] as const

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

async function seed(db: ProviderNeutralDatabase, n: number): Promise<void> {
  await db.insert(users).values({
    id: 'admin',
    username: 'admin',
    displayName: 'admin',
    role: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({ id: 'wf1', name: 'nightly', definition: '{}' })
  const taskRows: (typeof tasks.$inferInsert)[] = []
  const repoRows: (typeof taskRepos.$inferInsert)[] = []
  const cacheRows: (typeof cachedRepos.$inferInsert)[] = []
  const missionRows: (typeof developmentMissions.$inferInsert)[] = []
  for (let i = 0; i < n; i += 1) {
    const id = `t${String(i).padStart(4, '0')}`
    taskRows.push({
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
    repoRows.push({
      taskId: id,
      repoIndex: 0,
      repoPath: `/repos/r${i % 7}`,
      repoUrl: `git@github.com:acme/r${i % 7}.git`,
      worktreePath: `/tmp/wt-${id}`,
      branch: `agent-workflow/${id}`,
      baseBranch: 'main',
    })
    cacheRows.push({
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
    missionRows.push({
      id: `m${String(i).padStart(4, '0')}`,
      revision: 1,
      status: LEGACY_TERMINAL_STATUSES[i % LEGACY_TERMINAL_STATUSES.length]!,
      automationMode: 'auto',
      transitionFence: 'none',
      repositoryId: `repo${String(i).padStart(4, '0')}`,
      sourceKind: 'direct-input',
      deliveryKind: 'merge-request',
      employeeId: `employee-${i % 10}`,
      terminalAt: T0 + i * 1_000,
      createdAt: T0 + i * 1_000,
      updatedAt: T0 + i * 1_000,
    })
  }
  // 分批插：PostgreSQL 的绑定参数上限是 65535，逐行插又会把整条 lane 拖成分钟级。
  const batch = 200
  for (let offset = 0; offset < taskRows.length; offset += batch) {
    await db.insert(tasks).values(taskRows.slice(offset, offset + batch))
    await db.insert(taskRepos).values(repoRows.slice(offset, offset + batch))
    await db.insert(cachedRepos).values(cacheRows.slice(offset, offset + batch))
    await db.insert(developmentMissions).values(missionRows.slice(offset, offset + batch))
  }
}

/**
 * 两种规模要在**同一个库**上先后铺开（harness 每个用例只给一个库），所以两次之间要
 * 清空。顺序按外键依赖从叶到根；受防护路径自己写的表（归档器碰 events、巡检可能落
 * lifecycle_alerts）也要清，否则第二次测量会带上第一次的残留。
 */
async function clearCorpus(db: ProviderNeutralDatabase): Promise<void> {
  await db.delete(lifecycleAlerts)
  await db.delete(nodeRunEvents)
  await db.delete(nodeRuns)
  await db.delete(developmentMissions)
  await db.delete(taskRepos)
  await db.delete(tasks)
  await db.delete(cachedRepos)
  await db.delete(workflows)
  await db.delete(users)
}

interface GuardedPath {
  readonly name: string
  /**
   * - `list`：分页/计数读面，受全部四条约束。
   * - `sweep`：周期维护（归档器、巡检…）。它**天生就是 O(全表)**——那正是它的职责，
   *   所以豁免「取回行数不随库增长」；但**每一拍必须分块**，因此仍受「单条语句取回
   *   行数有上界」「绑定参数有界」约束。历史上最恶劣的一次事故正是归档器把无界 id
   *   列表塞进 `IN (…)` 撞 32766 上限死循环。
   * - `detail`：详情读面，按定义要读重列，豁免第五条。
   */
  readonly kind?: 'list' | 'sweep' | 'detail'
  /**
   * 仅 sweep 可用：**每行允许发多少条语句**的上界。写在这里等于公开承认「这条路径
   * 还是 O(行数) 条语句」，并把它钉成只许降不许升的棘轮——比让它豁免诚实，也比假装
   * 它是 O(1) 有用。填这个字段必须同时写清为什么还没消。
   */
  readonly maxStatementsPerRow?: number
  run(db: ProviderNeutralDatabase): Promise<unknown>
}

/**
 * 重列：按**命名约定**派生，不是人工清单——新加的 `*_json` 自动是重列，判据不会
 * 因为有人忘了登记而悄悄失效。
 */
/**
 * 从一份 schema 源码里挑出「重列」。**纯函数**——扫描与 RFC-317 T14 的
 * 「matcher 自证」共用它，避免判据长出第二份实现。
 */
function heavyColumnsIn(schema: string): string[] {
  const cols = new Set(Array.from(schema.matchAll(/text\('([a-z0-9_]+)'\)/g), (m) => m[1]!))
  return [...cols].filter(
    (c) =>
      /(_json|_snapshot|_text|_body|_md|_yaml)$/.test(c) ||
      ['stdout', 'stderr', 'inputs', 'outputs', 'definition'].includes(c),
  )
}

function heavyColumns(): string[] {
  return heavyColumnsIn(
    readFileSync(resolve(import.meta.dir, '..', 'src', 'db', 'schema.ts'), 'utf-8'),
  )
}

/**
 * 受防护的读路径。**新增列表 / 计数端点请加进来**——加一行的成本远低于再来一次
 * 「生产上所有操作都慢」的审计。
 */
const GUARDED: GuardedPath[] = [
  {
    name: 'task-operations catalog — 默认视图首页',
    run: (db) => listTaskOperationsPage(db as never, actorOf('admin'), {}),
  },
  {
    name: 'task-operations catalog — 过滤视图（G1 快路径）',
    run: (db) => listTaskOperationsPage(db as never, actorOf('admin'), { statuses: 'running' }),
  },
  {
    name: '/api/cached-repos — keyset 首页',
    run: (db) =>
      listCachedReposPage(composeSqliteRepositoryWorkspaceStore(db as never), { limit: 20 }),
  },
  {
    name: '/api/code/missions — keyset 首页',
    run: async (db) => listMissionSummariesPage(db as never, { limit: 20 }),
  },
  {
    name: '/api/code/missions/outcome-summaries — 员工终态分组',
    run: async (db) => listMissionTerminalOutcomeGroups(db as never),
  },
  {
    // 这里只量现有 legacy overview 算法在两个引擎上的执行。PG daemon 实际使用
    // composeSystemOverviewQuery 的 owner ports，不能据此宣称已测真实 PG 端点。
    name: '/api/overview — 计数面板',
    run: (db) => {
      const actor = actorOf('admin')
      const store = composeSqliteRepositoryWorkspaceStore(db as never)
      return buildOverview(
        db as never,
        resourceScopeAuthority(db as never, actor),
        composeRepositoryWorkspaceOperations(store, undefined).overviewQueries,
        memoryCatalogOf(db as never),
      )
    },
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
          db as never,
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
    run: (db) =>
      runLifecycleInvariants({
        operations: taskRecoveryOperations(db as never),
        scope: { all: true },
      }),
  },
]

const SMALL = 200
const LARGE = 500

/** P95 采样次数。取奇数，`sorted[ceil(0.95*n)-1]` 落在最后一个样本上。 */
const P95_SAMPLES = 9

/**
 * 唯一带毫秒的断言：PostgreSQL 的 P95 不得超过 SQLite 的这个倍数。
 *
 * 它**不是**性能 SLA，是塌方探测器——离噪声极远，只有「某条页查询在 PG 上退化成
 * 全表扫描 / 每行再查一次」这种量级的回归才够得着。50 倍这个数怎么来的：500 行语料上
 * PG 的每条语句都要付一次本机网络往返（约 0.3–1ms），而 SQLite 是同进程函数调用，
 * 便宜路径上 PG 天然就慢一个量级；实测比值 1.4–30 倍（`/api/overview` 13 条语句最差）。
 * 结构对比只防护查询成本；原 AC-11 的端点 P95 要求仍须单独取得证据。
 */
const CATASTROPHE_RATIO = 50
/**
 * 倍数之外还有一条**绝对下限**：最便宜的路径 SQLite 侧只要 0.2ms，50 倍也才 10ms，
 * 而满载 runner 上 PostgreSQL 光是几次本机往返就能吃掉那个预算——判据会在没有任何回归时红。
 * 250ms 在 500 行语料上是够不着的（实测最贵的一条也只有 31ms），而真塌方是秒级。
 */
const CATASTROPHE_FLOOR_MS = 250

interface Measurement {
  readonly statements: number
  readonly rows: number
  readonly maxParams: number
  readonly p95Ms: number
}

/** 两条 lane 共用的跨引擎测量表：`路径 → 引擎 → 测量`。 */
const MEASURED = new Map<string, Map<string, Measurement>>()
let comparisons = 0

function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))
  return sorted[index] ?? 0
}

async function capture(
  harness: ProviderHarness,
  n: number,
  path: GuardedPath,
): Promise<RecordedStatement[]> {
  await clearCorpus(harness.db)
  await seed(harness.db, n)
  const recording = harness.recordStatements()
  try {
    await path.run(harness.db)
  } finally {
    recording.stop()
  }
  return recording.statements
}

/**
 * 计划审计（不变量②：不许扫大表、不许临时排序）——**只在 SQLite 上有意义**。
 *
 * `EXPLAIN QUERY PLAN` 是 SQLite 方言，PostgreSQL 的 `EXPLAIN` 是另一套词汇；更要紧的是
 * 语料规模：这里是 500 行，PostgreSQL 在这个体量上会（完全正确地）偏好顺序扫描，
 * 断言「不许 Seq Scan」断的是「表小」而不是「缺索引」。PostgreSQL 侧的计划审计因此
 * 独立成 `rfc359-w6-t26-postgresql-plan-audit.test.ts`：一万行语料 + 真
 * `EXPLAIN (ANALYZE, BUFFERS)` + 一本只降不升的缺口账。
 */
async function assertPlans(
  harness: ProviderHarness,
  statements: readonly RecordedStatement[],
): Promise<void> {
  const offenders: string[] = []
  // 读写都审：归档器那次死循环就在 DELETE 上。
  for (const stmt of statements.filter((s) => /^\s*(select|delete|update)/i.test(s.sql))) {
    const plan = await harness.explain(stmt)
    if (plan.length === 0) continue // EXPLAIN 解释不了的（CTE 里的临时构造等）跳过
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
}

describeEachProvider('RFC-311 性能防护 —— 每条受防护读路径的结构性不变量', (harness) => {
  test.each(GUARDED.map((p) => [p.name, p] as const))(
    '%s',
    async (name, path) => {
      const small = await capture(harness, SMALL, path)
      const large = await capture(harness, LARGE, path)

      // ① N+1：语句条数必须与行数无关。
      const summarize = (s: readonly RecordedStatement[]): string[] =>
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
      const rowsOf = (s: readonly RecordedStatement[]): number => s.reduce((n, x) => n + x.rows, 0)
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

      // ③ 绑定参数有界（SQLite 硬上限 32766 / PostgreSQL 65535，无界 IN(…) 会在生产上直接抛）。
      const worst = large.reduce((m, s) => Math.max(m, s.params), 0)
      expect(
        worst,
        `某条语句绑定了 ${worst} 个参数，逼近 SQLite 的 32766 上限`,
      ).toBeLessThanOrEqual(MAX_BOUND_PARAMS)

      // ② 计划审计——见 assertPlans 的注释，PostgreSQL 侧另有专门的一份。
      if (harness.capabilities.provider === 'sqlite') await assertPlans(harness, large)

      // —— AC-11 的采集面 ——
      // P95 墙钟：两个引擎各取各的基线（RFC-359 AC-11）。只打印、不作判据。
      const samples: number[] = []
      for (let i = 0; i < P95_SAMPLES; i += 1) {
        const startedAt = performance.now()
        await path.run(harness.db)
        samples.push(performance.now() - startedAt)
      }
      const engine = harness.capabilities.provider
      const measurement: Measurement = {
        statements: large.length,
        rows: rowsOf(large),
        maxParams: worst,
        p95Ms: percentile95(samples),
      }
      const byEngine = MEASURED.get(name) ?? new Map<string, Measurement>()
      byEngine.set(engine, measurement)
      MEASURED.set(name, byEngine)
      console.info(
        `[rfc311-perf ${engine}] ${name}: ${measurement.statements} 条语句 / ` +
          `${measurement.rows} 行 / 最大 ${measurement.maxParams} 参数 / ` +
          `P95 ${measurement.p95Ms.toFixed(2)}ms（${LARGE} 行语料）`,
      )

      // 结构成本对照。两条 lane 在同一个进程里跑，**后跑到的那一条**做比较——
      // 这样断言与 describe / test 的执行顺序无关（CI 用 `bun test --randomize`）。
      const sqlite = byEngine.get('sqlite')
      const postgresql = byEngine.get('postgresql')
      if (sqlite !== undefined && postgresql !== undefined) {
        comparisons += 1
        expect(
          postgresql.statements,
          `AC-11：同一条路径在 PostgreSQL 上发了 ${postgresql.statements} 条语句，` +
            `SQLite 只发 ${sqlite.statements} 条。多发的每一条在 PG 上都是一次网络往返——` +
            `这是「PG 更慢」最直接的因，而且与机器负载无关。`,
        ).toBeLessThanOrEqual(sqlite.statements)
        expect(
          postgresql.rows,
          `AC-11：同一条路径在 PostgreSQL 上取回 ${postgresql.rows} 行，SQLite 只取回 ${sqlite.rows} 行。`,
        ).toBeLessThanOrEqual(sqlite.rows)
        expect(
          postgresql.maxParams,
          `AC-11：同一条路径在 PostgreSQL 上单条语句最多绑定 ${postgresql.maxParams} 个参数，` +
            `SQLite 是 ${sqlite.maxParams} 个。`,
        ).toBeLessThanOrEqual(sqlite.maxParams)
        console.info(
          `[rfc311-perf AC-11] ${name}: P95 sqlite ${sqlite.p95Ms.toFixed(2)}ms / ` +
            `postgresql ${postgresql.p95Ms.toFixed(2)}ms（比值 ` +
            `${(postgresql.p95Ms / Math.max(sqlite.p95Ms, 0.001)).toFixed(1)}×，只作诊断）`,
        )
        // 塌方探测器，不是 SLA。见 CATASTROPHE_RATIO 的注释。
        expect(
          postgresql.p95Ms,
          `AC-11 塌方探测：PostgreSQL 的 P95 ${postgresql.p95Ms.toFixed(2)}ms 是 SQLite ` +
            `${sqlite.p95Ms.toFixed(2)}ms 的 ${(postgresql.p95Ms / Math.max(sqlite.p95Ms, 0.001)).toFixed(1)} 倍。\n` +
            `这个倍数远超「每条语句多一次本机网络往返」能解释的范围，多半是某条查询在 PG 上\n` +
            `退化成了全表扫描 / 每行再查一次。去看 rfc359-w6-t26-postgresql-plan-audit 的账本。`,
        ).toBeLessThanOrEqual(Math.max(sqlite.p95Ms * CATASTROPHE_RATIO, CATASTROPHE_FLOOR_MS))
      }
    },
    180_000,
  )
})

// 两条 lane 都跑过之后：AC-11 到底比没比。放 afterAll 而不是最后一个 test，
// 是因为 CI 用 `bun test --randomize`——写成 test 会被排到前面去，counter 恒 0 而空洞绿。
afterAll(() => {
  if (!resolveTestProviders(process.env).includes('postgresql')) return
  if (comparisons < GUARDED.length) {
    throw new Error(
      `AC-11 只完成了 ${comparisons} / ${GUARDED.length} 条路径的跨引擎对比——` +
        '说明有 lane 没跑到，「PG 不劣于 SQLite」这句话此刻没有证据。',
    )
  }
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
// 39：+1 来自 `missionReadModels.missionFacets` 的分组聚合
// （`select(status, count(*)).from(developmentMissions).groupBy(status)`）。它**不是**
// 无界读——返回行数被状态枚举封顶（≤13 行），而且它位于已注册路径
// `/api/code/missions` 之内，受不变量④a（单条语句取回行数有上界）实际保护。这是文本
// 启发式的过度计数：它看得见 `.all()`，看不见 `group by` 把结果收敛成了枚举基数，也
// 看不见这条路径已经在注册表里。按本条自己写的处置口径「连同理由调整棘轮值」处理。
// 40：再 +1，同因——`missionCounts`（过滤集上按状态分组的计数，服务端聚合下推之后
// 新增）。它同样被状态枚举封顶，同样在已注册路径内。
// 注意 group by 并不天然安全——按高基数列分组（如 cached_repo_id）仍是无界的，所以
// 没有把 `groupBy` 一刀切地从判据里豁免；每次上调都必须像这样写明**为什么这一处是
// 有界的**，而不是简单地把数字改大。
const UNBOUNDED_READ_RATCHET = 40

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
          // The bounded window may cross from a completed point lookup into the
          // next query. `.get()` terminates the first builder just as `.limit()`
          // bounds it; neither is evidence that the later `.all()` belongs to
          // the table captured at the start of this match.
          if (!m[2]!.includes('.limit(') && !m[2]!.includes('.get()')) {
            hits.push(`${relative(src, full)}  ←  ${m[1]}`)
          }
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
        `连同理由一起调低/说明这条棘轮。当前清单（重复项代表同文件多处）：\n${[...hits]
          .sort()
          .join('\n')}`,
    ).toBeLessThanOrEqual(UNBOUNDED_READ_RATCHET)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的 schema 源码喂给**扫描用的同一份判据**。
//
// 「重列不得出现在列表读路径」这条守卫的强度完全取决于 `heavyColumnsIn` 认得出
// 哪些列。正则或后缀表一旦漏掉一类（新加的 `_yaml`、或 drizzle 换了列声明写法），
// 重列就不在集合里，「读路径没选重列」于是永远成立——与「真的没选」同形。
describe('RFC-317 T14 —— matcher 自证：重列识别必须还认得出重列', () => {
  test('六种后缀 + 五个具名列都识别得出', () => {
    const fabricated = [
      "  configurationJson: text('configuration_json')",
      "  preSnapshot: text('pre_snapshot')",
      "  promptText: text('prompt_text')",
      "  bodyMd: text('body_md')",
      "  noteBody: text('note_body')",
      "  policyYaml: text('policy_yaml')",
      "  stdout: text('stdout')",
      "  stderr: text('stderr')",
      "  inputs: text('inputs')",
      "  outputs: text('outputs')",
      "  definition: text('definition')",
    ].join('\n')
    expect(heavyColumnsIn(fabricated).sort()).toEqual(
      [
        'body_md',
        'configuration_json',
        'definition',
        'inputs',
        'note_body',
        'outputs',
        'policy_yaml',
        'pre_snapshot',
        'prompt_text',
        'stderr',
        'stdout',
      ].sort(),
    )
  })

  test('轻列不被误判成重列（否则守卫会把正常读路径也拦下）', () => {
    const fabricated = [
      "  id: text('id')",
      "  taskId: text('task_id')",
      "  status: text('status')",
      "  ownerUserId: text('owner_user_id')",
    ].join('\n')
    expect(heavyColumnsIn(fabricated)).toEqual([])
  })
})
