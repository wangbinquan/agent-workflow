// RFC-359 W6-T26 —— PostgreSQL 执行计划审计：一本**只降不升**的缺口账。
//
// # 为什么需要它
//
// RFC-311 立起来的那张性能防护网（`rfc311-perf-guards.test.ts`）只在 SQLite 上跑过，
// 它的第②条判据「不许扫大表、不许临时排序」读的是 `EXPLAIN QUERY PLAN`——一条 SQLite
// 方言。也就是说：**本仓此前没有任何东西量过 PostgreSQL 的执行计划**，而 RFC-359 的
// 验收里写着「PostgreSQL 要做到最高性能表现」（AC-11 / design §10）。
//
// 这个文件补的就是那一半：在真 PostgreSQL 上把 RFC-311 的基准语料铺开，让每条热路径
// 正常跑，把它**实际执行**的语句连同绑定参数抓下来，逐条 `EXPLAIN (ANALYZE, BUFFERS)`，
// 再把发现的计划缺陷钉成账本。
//
// **W8-T26 起账本已空**——采集到的三条缺口全部销账（改写见 `PLAN_GAPS` 上方的表）。
// 账本空掉**不**意味着这个文件退役：它此刻的主职从「记账」翻转成「防复辟」——下面第①条
// 断言会把任何**新**长出来的逐行子计划连同完整计划文本报出来，而两条正向守卫
// （SQLite 上的具名索引 PG 一条不少 / 默认视图翻页确实走 keyset 索引）本来就与账本无关。
//
// # 判据用什么量：buffers 与 loops，**不用墙钟毫秒**
//
// `docs/audit-backlog.md` §「O(k²) 守卫用墙钟毫秒当判据，在共享 runner 上会假红」记着
// 一次实撞：同一份代码本机 0.6ms、CI 上量到 182ms 而红——墙钟把「算法复杂度」和「这台
// 机器此刻有多忙」混成了一个数。这里换成 PostgreSQL 自己报的两个**与负载无关**的量：
//
//   · `Buffers: shared hit=<n>`——这一条语句碰了多少个 8KB 缓冲页。它由计划形状与数据量
//     共同决定，与 CPU 忙不忙无关；同一份计划在任何机器上读同一个数。
//   · `loops=<n>`——某个子计划被执行了多少次。`loops ≈ 表行数` 就是「每行再查一次」的
//     签名，也与负载无关。
//
// 两者都按语料行数归一（`buffersPerRow` / `loopsPerRow`），所以调整语料规模不会让账本失真。
//
// # 账本语义
//
//   1. **观察到的缺陷必须已在账上**——冒出新的一条就红，附完整计划文本；
//   2. **账上的缺陷必须仍观察得到**——补完索引 / 改完查询后它会消失，此时**必须删掉那一行**，
//      否则红。这条方向反过来的断言才是「可销的账」：下一刀改完就得来销，不会留着烂账；
//   3. **每条的实测代价只许降**——`buffersPerRow` 超过账上记的天花板（含 25% 余量）就红。
//
// # 本次实测的 schema 状态（重要）
//
// 采集于 2026-09-07，PostgreSQL 17.11，`db/schema.ts` 已含 `idx_tasks_root_started` /
// `idx_tasks_status_parent_finished` / `idx_tasks_status_workgroup` / `idx_tasks_workgroup` /
// `idx_tasks_root_missing` 五条（W6 的另一刀刚补上；此前它们只写在迁移 SQL 里、PG 上完全
// 不存在）。索引补齐后 PG 的计划会变，所以下面每条结论都只对**这个 schema 状态**成立；
// 下面第一个 describe 用「SQLite 有的具名索引 PG 必须也有」把这个状态本身钉住。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildActor, type Actor } from '@/auth/actor'
import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  developmentMissions,
  lifecycleAlerts,
  taskRepos,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import {
  listMissionSummariesPage,
  listMissionTerminalOutcomeGroups,
} from '@/modules/development-automation/infrastructure/missionReadModels'
import type { WorkgroupOperationContext } from '@/modules/resource-catalog/public/participants'
import { composeSqliteRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { RFC349_ARCHIVE_THEN_OMIT_TABLES } from '@/platform/persistence/schemaContract'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { migratePostgresqlSchema } from '@/platform/persistence/postgresqlMigrator'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
} from '@/platform/persistence/postgresqlRuntime'
import { archiveEvents } from '@/services/eventsArchive'
import { listCachedReposPage } from '@/services/gitRepoCache'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'
import { runProductionOverview } from './helpers/productionOverview'
import { listTaskOperationsPage } from './helpers/taskListPage'
import { composeTestWorkgroupTaskRoom } from './helpers/workgroupTaskRoom'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const T0 = 1_700_000_000_000
const GENERATION_ID = 'dbg_rfc359_w6_t26'
const OPERATION_ID = 'lcop_rfc359_w6_t26'

/**
 * 语料行数。取值权衡：太小 PostgreSQL 会（正确地）偏好顺序扫描，量到的是「表小」不是
 * 「缺索引」；太大则整条 lane 在 CI 上放不下（ubuntu 后端分片 15 分钟跑四分之一个仓）。
 *
 * 10000 是实测下界：3000 行时 PostgreSQL 还不肯为 facet_values 那个相关 EXISTS 选索引
 * 扫描，账上四条里有两条量不出来（计划翻转点在 3000–4000 之间）。10000 行离翻转点足够远，
 * 整个文件仍然只跑 4 秒。改这个数就要重新采一遍 `buffersPerRow`。
 *
 * W8-T26 把那三条缺口改写掉之后，这个下界的意义换成了「防复辟网的分辨率」：语料太小时
 * 新长出来的逐行子计划同样会被 planner 藏在顺序扫描里而量不出来。**只许加不许减。**
 */
const AUDIT_ROWS = 10_000

/** `loops` 达到语料的这个比例即判为「每行再查一次」。 */
const PER_ROW_LOOPS_RATIO = 0.5

/**
 * 只有**扫描**节点算「每行再查一次」的签名。包住它的 join / aggregate 节点 `loops` 一样大，
 * 但它们是同一件事的外层，登记进账本只会让每条缺口重复三行。
 */
const SCAN_NODE =
  /^(Seq Scan|Index Scan|Index Only Scan|Index Scan Backward|Bitmap Heap Scan|Bitmap Index Scan|CTE Scan|Subquery Scan|Function Scan|WorkTable Scan)\b/

/** 账上代价的容差：计划稳定但 buffer 数会随 PostgreSQL 小版本微调。 */
const BUFFER_CEILING_SLACK = 1.25

// ---------------------------------------------------------------------------
// 缺口账本
// ---------------------------------------------------------------------------

interface PlanGap {
  /** 稳定标识，供报告与销账时引用。 */
  readonly id: string
  /** 哪条热路径。 */
  readonly path: string
  /**
   * 计划里出问题的那个节点，别名已剥掉（`… on lifecycle_alerts la` → `… on lifecycle_alerts`）。
   * 它同时是账本的键：补上索引后 PostgreSQL 会换一个节点，这一条就自然销掉。
   */
  readonly node: string
  /**
   * 缺陷种类。账本只收**断言级**的一种：`per-row-subplan`。
   * `jit-compilation` 只报告不断言——一台 PostgreSQL 有没有编进 llvmjit 是部署差异，
   * 拿它当判据就把「查询变贵了」和「这台机器装没装 JIT」混成一个数（同墙钟毫秒的教训）。
   */
  readonly defect: 'per-row-subplan'
  /** 当前计划一句话。 */
  readonly plan: string
  /** 缺哪条索引 / 该怎么改。**只出清单，本文件不动 schema。** */
  readonly missing: string
  /** 实测代价天花板（按语料行数归一，与机器负载无关）。 */
  readonly buffersPerRow: number
  /** SQLite 侧对照：同一条路径在 SQLite 上是什么形状。 */
  readonly sqlite: string
}

/**
 * **账本当前为空——三条缺口已于 W8-T26 全部销账。**
 *
 * 2026-09-07 采集的三条（T26-G1 任务目录 `facet_attention`、T26-G3 / T26-G4 仓库
 * facets 的两个相关 EXISTS）根因同一个：**写在聚合的 `CASE` 里的相关子查询无法被上提成
 * semi join**——WHERE 里的 `EXISTS` 两个 planner 都会上提，`SUM(CASE WHEN … EXISTS(…) …)`
 * 里的只能对每一行重跑一遍，`loops` 因而等于表行数。三条都改掉之后 `loops` 回到 1：
 *
 *   | 缺口   | buffers/row | 50000 行语料上的单条语句                          | 改写                     |
 *   |--------|-------------|---------------------------------------------------|--------------------------|
 *   | G1     | 2.17 → 0.04 | 84.1ms / 107,042 buffers → 21.1ms / 2,107 buffers  | 预聚合 + LEFT JOIN       |
 *   | G3+G4  | 2.00 → 0.02 | 122.3ms / 200,820 buffers → 18.7ms / 824 buffers   | `exists` 回 WHERE，三格互斥 |
 *
 * 两条改写**形状不同**，因为两张被 join 的表在生产里的相对大小不同：
 *   · G1（`taskListPage/query.ts` 的 `fastDefaultRootQuery`）被聚合的 `lifecycle_alerts`
 *     是小表、外层 `tasks` 本来就要全扫 ⇒ 预聚合成
 *     `LEFT JOIN (SELECT DISTINCT task_id … WHERE resolved_at IS NULL)` 是净赚；
 *   · G3/G4（`repositoryWorkspaceSqlStore.referencedFacetCounts`）如果照搬预聚合，代价会
 *     从 O(仓库数) 换成 O(**任务数**)，而生产里任务表比仓库表大几个数量级——本刀实测
 *     200 仓库 / 50000 任务的形态上 SQLite 从 0.2ms 掉到 16ms，并触发 `rfc311-perf-guards`
 *     的「不许扫无界表」。改成把 `exists` 送回 WHERE 子句、`referenced` 拆成三格互斥标量
 *     子查询（`E / ¬E∧L / ¬E∧¬L∧S`）相加：PostgreSQL 上 200 仓库 112ms → 19ms、
 *     50000 仓库 322ms → 59ms，SQLite 两种比例下都不退化。
 *
 * 两条语句的估算代价随之掉到 `jit_above_cost=100000` 以下，**JIT 编译一并消失**
 * （改写前 G1 那条 84.1ms 里 32.4ms 是编译、G3/G4 那条 122.3ms 里 63.6ms 是编译）。
 * 结果等价由 `rfc359-w8-t26-plan-reshape-conformance.test.ts` 在两个引擎上钉住
 * （重复计数 / 空集 / NULL / 悬空键四类边界，对着改写前的 SQL 原文做 oracle）。
 *
 * 空账本**不是**这个文件可以退役的信号：下面第①条断言（观察到的缺陷必须已在账上）此刻
 * 变成一张纯粹的防复辟网——任何人往这些热路径里再写进一个逐行子计划，它就会带着完整计划
 * 文本红出来。同文件的「具名索引不许只存在于 SQLite」与「默认视图确实走 keyset 索引」两条
 * 正向守卫也照旧。
 *
 * **记账规则**：新观察到的缺陷连同「缺什么」一起加进来；补完索引 / 改完查询后对应条目会
 * 不再被观察到，此时把它删掉（留着不删会被下面第②条断言判红，账本不许留烂账）。
 */
const PLAN_GAPS: readonly PlanGap[] = []

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

const LEGACY_TERMINAL_STATUSES = [
  'merged',
  'completed-no-change',
  'closed-unmerged',
  'canceled',
  'failed',
] as const

function actorOf(id: string, role: 'admin' | 'user' = 'admin'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

/**
 * RFC-311 基准语料 + **未闭合告警**。
 *
 * 原语料把 `lifecycle_alerts` 留空，于是 facet_values 里那个相关 EXISTS 打在空表上、
 * 两个引擎都是零成本——量不出任何东西。这里按 10% 的任务带告警、其中五分之一未闭合来铺，
 * 那条 CTE 才回到生产形状（实测：默认视图首页从 33ms 涨到 85ms，缺陷这才现形）。
 */
async function seedAuditCorpus(db: ProviderNeutralDatabase, n: number): Promise<void> {
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
  const alertRows: (typeof lifecycleAlerts.$inferInsert)[] = []
  for (let i = 0; i < n; i += 1) {
    const id = `t${String(i).padStart(6, '0')}`
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
      // 根任务自指：0183 的准入闸门要求全库无未落根行，否则整条退回旧管线。
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
      id: `repo${String(i).padStart(6, '0')}`,
      urlHash: `hash-${i}`,
      urlRedacted: `git@github.com:acme/c${i}.git`,
      localPath: `/cache/c${i}`,
      defaultBranch: 'main',
      lastFetchedAt: T0 + i * 1_000,
      createdAt: T0,
      hasSubmodules: i % 4 === 0,
      lastSubmoduleSyncOk: i % 8 !== 0,
    })
    missionRows.push({
      id: `m${String(i).padStart(6, '0')}`,
      revision: 1,
      status: LEGACY_TERMINAL_STATUSES[i % LEGACY_TERMINAL_STATUSES.length]!,
      automationMode: 'auto',
      transitionFence: 'none',
      repositoryId: `repo${String(i).padStart(6, '0')}`,
      sourceKind: 'direct-input',
      deliveryKind: 'merge-request',
      employeeId: `employee-${i % 10}`,
      terminalAt: T0 + i * 1_000,
      createdAt: T0 + i * 1_000,
      updatedAt: T0 + i * 1_000,
    })
    if (i % 10 === 0) {
      alertRows.push({
        id: `al${String(i).padStart(7, '0')}`,
        taskId: id,
        rule: 'stuck',
        severity: i % 40 === 0 ? 'error' : 'warn',
        detail: 'seeded for the plan audit',
        detectedAt: T0 + i * 1_000,
        resolvedAt: i % 50 === 0 ? null : T0 + i * 1_000 + 5,
      })
    }
  }
  const batch = 300
  for (let offset = 0; offset < taskRows.length; offset += batch) {
    await db.insert(tasks).values(taskRows.slice(offset, offset + batch))
    await db.insert(taskRepos).values(repoRows.slice(offset, offset + batch))
    await db.insert(cachedRepos).values(cacheRows.slice(offset, offset + batch))
    await db.insert(developmentMissions).values(missionRows.slice(offset, offset + batch))
  }
  for (let offset = 0; offset < alertRows.length; offset += batch) {
    await db.insert(lifecycleAlerts).values(alertRows.slice(offset, offset + batch))
  }
}

interface AuditedPath {
  readonly name: string
  run(db: ProviderNeutralDatabase): Promise<unknown>
}

/** 受审的热读路径——与 `rfc311-perf-guards.test.ts` 的 GUARDED 注册表同源。 */
const AUDITED: readonly AuditedPath[] = [
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
    name: '/api/overview — 计数面板',
    run: (db) => runProductionOverview(db, actorOf('admin')),
  },
  {
    // 这条路径是 generic-plan 退化的实撞现场（见 `GENERIC_PLAN_GAPS` 上方）。
    // 语料里没有任何工作组任务，正是让探针的顺序扫「一行都凑不到、只能读到底」的条件。
    name: '/api/workgroup-tasks/pending-count — 空工作组短路探针',
    run: (db) =>
      composeTestWorkgroupTaskRoom(db).queries.pendingCount(
        Object.freeze({
          ...actorOf('admin'),
          userId: 'admin',
        }) as unknown as WorkgroupOperationContext,
      ),
  },
  {
    name: '事件归档器（小时级 sweep）',
    run: async (db) => {
      const logsDir = mkdtempSync(join(tmpdir(), 'aw-t26-logs-'))
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
]

// ---------------------------------------------------------------------------
// 计划解析（纯函数，可单测）
// ---------------------------------------------------------------------------

export interface PlanObservation {
  readonly node: string
  /** 账本只收 `per-row-subplan`；`jit-compilation` 只报告不断言（见 `PlanGap.defect`）。 */
  readonly defect: 'per-row-subplan' | 'jit-compilation'
  readonly loops: number
  readonly buffers: number
}

/** 剥掉计划节点上的查询别名，让账本的键不随 SQL 里的别名改动而失效。 */
export function normalizePlanNode(detail: string): string {
  const head = detail
    .replace(/\s+\(cost=.*$/, '')
    .replace(/\s+\(never executed\)$/, '')
    .trim()
  return head.replace(/( on [a-z0-9_]+)(?: [a-z][a-z0-9_]*)?$/i, '$1')
}

/**
 * 从 `EXPLAIN (ANALYZE, BUFFERS)` 的文本里挑出「与负载无关」的缺陷信号。
 *
 * 只认两类，都是形状问题而不是速度问题：
 *   · `per-row-subplan`——某个节点的 `loops` 达到语料行数的一半以上，即「每行再查一次」；
 *   · `jit-compilation`——计划估算代价越过 `jit_above_cost`，PostgreSQL 花时间编译表达式。
 *     它在 OLTP 短查询上是净亏（实测 124ms 的语句里 64.8ms 是 JIT），属于计划缺陷。
 */
export function observePlanDefects(plan: string, corpusRows: number): PlanObservation[] {
  const out: PlanObservation[] = []
  const lines = plan.split('\n')
  const totalBuffers = lines.reduce((max, line) => {
    const match = /Buffers: shared hit=(\d+)/.exec(line)
    return match === null ? max : Math.max(max, Number(match[1]))
  }, 0)
  for (const [index, line] of lines.entries()) {
    const loopsMatch = /\bloops=(\d+)\)\s*$/.exec(line.trimEnd())
    if (loopsMatch === null) continue
    const loops = Number(loopsMatch[1])
    if (loops < corpusRows * PER_ROW_LOOPS_RATIO) continue
    const detail = line.replace(/^\s*(->\s*)?/, '')
    if (!SCAN_NODE.test(detail)) continue
    // 节点自己的 buffers 记在紧随其后的缩进行里；取不到就退回整条语句的总量。
    const own = lines
      .slice(index + 1, index + 4)
      .map((candidate) => /Buffers: shared hit=(\d+)/.exec(candidate))
      .find((candidate) => candidate !== null)
    out.push({
      node: normalizePlanNode(detail),
      defect: 'per-row-subplan',
      loops,
      buffers: own === null || own === undefined ? totalBuffers : Number(own[1]),
    })
  }
  if (/^JIT:/m.test(plan)) {
    out.push({ node: 'JIT', defect: 'jit-compilation', loops: 1, buffers: totalBuffers })
  }
  return out
}

// ---------------------------------------------------------------------------
// generic plan：production 真正跑的那份计划
// ---------------------------------------------------------------------------

/**
 * RFC-359 AC-11 —— 上面那本账审的是 **custom plan**，而生产跑的往往是 **generic plan**。
 *
 * # 这个盲点让一次 10 倍回归整整穿过了守卫
 *
 * PostgreSQL 对一条 prepared statement 的前 5 次执行用 custom plan（知道实参，按真实选择率
 * 规划），第 6 次起才可能换成 generic plan（不知道实参，按默认选择率规划）。上面的审计每条
 * 语句只 `EXPLAIN` **一次**、而且**带着实参**——量到的永远是 custom plan，也就是生产只在
 * 头 5 次请求里用的那份。
 *
 * 实撞（2026-09-14）：`/api/workgroup-tasks/pending-count` 的空工作组探针原本写成
 * `WHERE workgroup_id >= ${''}`，drizzle 把空串编成 `$1`。custom plan 走
 * `Index Only Scan`（0.03ms）；generic plan 不知道 `$1` 是什么，把 `>= $1` 按默认选择率
 * 估成命中很多行、又看见 `LIMIT 1`，于是判定「顺序扫一下马上凑够一行」——可语料里每行的
 * `workgroup_id` 都是 NULL，谁都不匹配，那一趟成了读完整表的 `Seq Scan`（4.49ms）。
 * 托管 CI 上这条端点因此**从第 5 个请求起** 2.5ms → 24.8ms 并再不回落（run `34836852462`，
 * 20 个样本的后 16 个全在 23ms 以上），而本文件当时一条红都没报。
 *
 * # 判据：差分，不是绝对形状
 *
 * 「有没有 `Seq Scan`」当不了判据——小表顺序扫是对的。这里判的是**同一条语句的两份计划之差**：
 * 某个关系在 custom plan 里走索引、在 generic plan 里退化成顺序扫，就是「参数一旦不可见
 * 计划就塌」的签名，也正是生产第 6 次请求起会踩的那一脚。这个判据自带标定，不需要谁去
 * 逐表裁定多大算大。
 *
 * `EXPLAIN (GENERIC_PLAN)` 是 PostgreSQL 16+ 的能力：**只规划不执行**，所以它不吃语料规模、
 * 不吃机器负载，与本文件「不用墙钟毫秒」的原则一致。
 *
 * # 还要再过一道「PostgreSQL 真的会换吗」
 *
 * 只判形状会**过度报警**：generic plan 更差、但 PostgreSQL 自己算出来更贵时，它压根不会换
 * （`plan_cache_mode=auto` 的规则是 generic 估算代价**不高于** custom 的平均值才采纳）。
 * 实测 `/api/overview` 的计数就是这种：generic 估 458.58、custom 估 8.62，差 53 倍，
 * 于是 PostgreSQL 一直用 custom plan——形状是退化的，但生产永远吃不到。
 *
 * 真正危险的是**两条同时成立**：generic plan 把索引扫换成顺序扫，**而且**它自己估得更便宜。
 * 那正是「估错了所以才被采纳」——workgroup 探针的 generic plan 估 8.47、custom 估 12.63，
 * 于是被采纳；而那 8.47 建立在「`LIMIT 1` 扫几行就能凑够」的假设上，实际一行都凑不到、
 * 把整张表读完。判据因此取这两条的**合取**：每一条报出来的都是 PostgreSQL 会真的换过去、
 * 且换过去更糟的。
 */
const RELATION_SCAN =
  /\b(Parallel Seq Scan|Seq Scan|Index Only Scan Backward|Index Scan Backward|Index Only Scan|Index Scan|Bitmap Heap Scan) (?:using \S+ )?on ([a-z0-9_]+)/g

/** 计划文本里每个关系被用过哪些扫描节点（别名与 schema 前缀都不进键）。 */
export function relationScans(plan: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const matched of plan.matchAll(RELATION_SCAN)) {
    const kind = matched[1]
    const relation = matched[2]
    if (kind === undefined || relation === undefined) continue
    const kinds = out.get(relation)
    if (kinds === undefined) out.set(relation, new Set([kind]))
    else kinds.add(kind)
  }
  return out
}

/** 计划根节点的估算总代价（`(cost=启动..总计 rows=…)` 里的第二个数）。取不到返回 `null`。 */
export function planTotalCost(plan: string): number | null {
  const matched = /\(cost=[\d.]+\.\.([\d.]+) rows=/.exec(plan)
  return matched === undefined || matched === null ? null : Number(matched[1])
}

/**
 * custom plan 里走索引、generic plan 里退化成顺序扫的关系名。
 *
 * 只报**退化**：两份计划都顺序扫的关系不报（那是稳定选择，与参数可见性无关），
 * 只在 generic plan 里出现的关系也不报（计划形状本来就不同，谈不上退化）。
 */
export function genericPlanRegressions(custom: string, generic: string): string[] {
  const before = relationScans(custom)
  const out: string[] = []
  for (const [relation, kinds] of relationScans(generic)) {
    if (![...kinds].some((kind) => kind.endsWith('Seq Scan'))) continue
    const customKinds = before.get(relation)
    if (customKinds === undefined) continue
    if ([...customKinds].some((kind) => kind.endsWith('Seq Scan'))) continue
    out.push(relation)
  }
  return [...new Set(out)].sort()
}

interface GenericPlanGap {
  /** 稳定标识。 */
  readonly id: string
  /** 哪条热路径。 */
  readonly path: string
  /** 在 generic plan 下塌成顺序扫的关系。 */
  readonly relation: string
  /** 哪个参数让计划塌的，以及为什么暂时留着。 */
  readonly why: string
}

/**
 * **账本为空**：本仓当前没有已知的 generic-plan 退化。
 *
 * 记账规则同 `PLAN_GAPS`：新观察到的连同「哪个参数」一起登记；改掉之后必须删行，
 * 否则下面第②条断言判红。修法通常是**把那个常量从绑定参数变回常量谓词**——
 * 见 `workgroupTaskRoomTaskParticipant.ts` 的 `listActive`（`>= $1` → `IS NOT NULL`）。
 */
const GENERIC_PLAN_GAPS: readonly GenericPlanGap[] = []

// ---------------------------------------------------------------------------
// 账本自证（两个引擎都跑，不需要真库）
// ---------------------------------------------------------------------------

/**
 * 一条账目里没填全的字段名。**纯函数**——账本空掉之后「逐条检查」一次也不跑，所以判据
 * 本身必须另外对着一条捏造的残缺条目证明它还在判（否则这条守卫就静默了）。
 */
export function incompleteGapFields(gap: PlanGap): string[] {
  const bad: string[] = []
  if (!/^T26-G\d+$/.test(gap.id)) bad.push('id')
  if (gap.path.length === 0) bad.push('path')
  if (gap.node.length === 0) bad.push('node')
  if (gap.plan.length <= 20) bad.push('plan')
  if (gap.missing.length <= 20) bad.push('missing')
  if (!(gap.buffersPerRow > 0)) bad.push('buffersPerRow')
  if (gap.sqlite.length === 0) bad.push('sqlite')
  return bad
}

describe('RFC-359 W6-T26 —— 缺口账本自身的形状', () => {
  test('每条都有 id / 路径 / 节点 / 缺什么 / 实测代价，且 id 唯一（空账本 = 缺口已全销）', () => {
    expect(new Set(PLAN_GAPS.map((gap) => gap.id)).size).toBe(PLAN_GAPS.length)
    for (const gap of PLAN_GAPS) expect(incompleteGapFields(gap), gap.id).toEqual([])

    // negative fixture：账本此刻是空的，上面那个循环一次也不跑。
    expect(
      incompleteGapFields({
        id: 'G7',
        path: '',
        node: '',
        defect: 'per-row-subplan',
        plan: '太短',
        missing: '太短',
        buffersPerRow: 0,
        sqlite: '',
      }),
      '账目完整性判据在放空枪——它连一条七个字段全缺的条目都报不出来',
    ).toEqual(['id', 'path', 'node', 'plan', 'missing', 'buffersPerRow', 'sqlite'])
  })

  test('计划解析器认得出「每行再查一次」，也不误判一次性节点', () => {
    const perRow = [
      'Aggregate  (cost=418412.50..418412.51 rows=1 width=32) (actual time=84.9..84.9 rows=1 loops=1)',
      '  Buffers: shared hit=106725',
      '  ->  Seq Scan on tasks t  (cost=0.00..2225.00 rows=50000 width=13) (actual time=0.0..5.0 rows=50000 loops=1)',
      '  SubPlan 1',
      '    ->  Index Scan using idx_lifecycle_alerts_task on lifecycle_alerts la  (cost=0.28..8.30 rows=1 width=0) (actual time=0.001..0.001 rows=0 loops=50000)',
      '          Buffers: shared hit=105000',
    ].join('\n')
    const seen = observePlanDefects(perRow, 50_000)
    expect(seen.map((item) => item.node)).toEqual([
      'Index Scan using idx_lifecycle_alerts_task on lifecycle_alerts',
    ])
    expect(seen[0]!.loops).toBe(50_000)
    expect(seen[0]!.buffers).toBe(105_000)

    // 同一份文本，语料再大一个量级 ⇒ 50000 次不再算「每行一次」，不得误报。
    expect(observePlanDefects(perRow, 500_000)).toEqual([])

    const clean = [
      'Limit  (cost=0.29..1.88 rows=21 width=276) (actual time=0.009..0.014 rows=21 loops=1)',
      '  ->  Index Scan Backward using idx_tasks_branch_started_id on tasks t_1  (cost=0.29..420892.04 rows=50000 width=430) (actual time=0.014..0.028 rows=51 loops=1)',
      '        Buffers: shared hit=5',
    ].join('\n')
    expect(observePlanDefects(clean, 4_000)).toEqual([])

    expect(
      observePlanDefects(
        [
          'Aggregate  (cost=1..2 rows=1) (actual time=1..1 rows=1 loops=1)',
          'JIT:',
          '  Functions: 16',
        ].join('\n'),
        4_000,
      ).map((item) => item.defect),
    ).toEqual(['jit-compilation'])
  })

  test('别名剥离让账本的键不随 SQL 里的别名改动而失效', () => {
    expect(normalizePlanNode('Seq Scan on tasks t  (cost=0.00..2225.00 rows=50000 width=13)')).toBe(
      'Seq Scan on tasks',
    )
    expect(normalizePlanNode('Seq Scan on tasks  (cost=0.00..1.00 rows=1 width=1)')).toBe(
      'Seq Scan on tasks',
    )
    expect(
      normalizePlanNode(
        'Index Only Scan using idx_task_repos_cached_repo_task on task_repos task_repos_1  (cost=0.29..8.31 rows=1 width=0) (never executed)',
      ),
    ).toBe('Index Only Scan using idx_task_repos_cached_repo_task on task_repos')
  })

  // generic-plan 差分判据的自证。账本为空时下面那条真库断言一次也不报，所以判据本身必须
  // 对着捏造的两份计划证明它还在判——否则守卫静默，和「没有退化」看起来一模一样。
  test('generic plan 差分认得出「参数一没了就塌成顺序扫」，也不误报稳定的顺序扫', () => {
    const indexed =
      'Nested Loop\n' +
      '  ->  Limit\n' +
      '        ->  Index Only Scan using idx_tasks_workgroup on tasks tasks_1\n' +
      "              Index Cond: (workgroup_id >= ''::text)\n" +
      '  ->  Seq Scan on workgroup_task_state\n'
    const collapsed =
      'Nested Loop\n' +
      '  ->  Limit\n' +
      '        ->  Seq Scan on tasks tasks_1\n' +
      '              Filter: (workgroup_id >= $1)\n' +
      '  ->  Seq Scan on workgroup_task_state\n'

    // ① 退化被抓到：`tasks` 从索引扫塌成顺序扫。
    expect(genericPlanRegressions(indexed, collapsed)).toEqual(['tasks'])
    // ② 两份计划都顺序扫 `workgroup_task_state`，那是稳定选择，不报。
    expect(genericPlanRegressions(indexed, collapsed)).not.toContain('workgroup_task_state')
    // ③ 计划没变就一条都不报。
    expect(genericPlanRegressions(indexed, indexed)).toEqual([])
    // ④ 方向是单向的：generic 反而变好不算退化。
    expect(genericPlanRegressions(collapsed, indexed)).toEqual([])
    // ⑤ 别名与扫描种类都解析得对。
    expect(relationScans(indexed).get('tasks')).toEqual(new Set(['Index Only Scan']))
    expect(relationScans(collapsed).get('tasks')).toEqual(new Set(['Seq Scan']))
  })

  // 采纳判据（generic 估得不比 custom 贵）的自证：取的必须是**根节点**的总计代价。
  test('计划总代价取的是根节点的 cost 上界', () => {
    expect(
      planTotalCost(
        'Nested Loop  (cost=0.29..8.47 rows=1 width=4)\n' +
          '  ->  Seq Scan on tasks  (cost=0.00..470.00 rows=3333 width=4)\n',
      ),
      // 根是 8.47；子节点那个 470.00 更大，取错就会把「更便宜所以会被采纳」判反。
    ).toBe(8.47)
    expect(planTotalCost('Aggregate  (cost=458.57..458.58 rows=1 width=8)')).toBe(458.58)
    expect(planTotalCost('Seq Scan on tasks')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 索引对账：SQLite 上有的具名索引，PostgreSQL 上必须也有
// ---------------------------------------------------------------------------
//
// 这条守卫的来由：`tasks` 曾有五条索引**只写在迁移 SQL 里**、没进 drizzle 声明，于是
// SQLite 上存在、PostgreSQL 上完全不存在（任务树 / 工作组查询在 PG 上无索引可用）。
// 这类缺口不会有任何报错，只会「慢」，所以必须由守卫盯着。
// `RFC349_ARCHIVE_THEN_OMIT_TABLES` 的六张表按契约根本不投影到 PG，它们的索引不算缺。

const providers = resolveTestProviders(process.env)
const postgresqlSelected = providers.includes('postgresql')
const urlEnv = resolvePostgresqlTestUrlEnv(process.env)

if (!postgresqlSelected) {
  describe('RFC-359 W6-T26 —— PostgreSQL 计划审计', () => {
    test.skip('AW_TEST_PROVIDERS 未选 postgresql —— 计划审计需要真库', () => {})
  })
} else {
  describe('RFC-359 W6-T26 —— PostgreSQL 计划审计', () => {
    let runtime: PostgresqlDatabaseRuntime | undefined
    let client: ProviderNeutralDatabase | undefined
    let raw:
      | ((query: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>)
      | undefined
    let restoreProvider: (() => void) | undefined
    const recorded: { sql: string; params: readonly unknown[] }[] = []
    let recording = false

    beforeAll(async () => {
      if (urlEnv === undefined) {
        // 与 `describeEachProvider` 同一条硬判据：缺库即红，不是 skip。
        throw new Error(
          '把 AW_TEST_POSTGRESQL_URL（或 RFC357_DATABASE_URL）指向一个可以被整个清空的 PostgreSQL 库；' +
            '只想跑 SQLite 时显式 AW_TEST_PROVIDERS=sqlite（CI 从不这么设）',
        )
      }
      runtime = createPostgresqlDatabaseRuntime({
        config: {
          provider: 'postgresql',
          urlEnv,
          poolMax: 4,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 120_000,
          idleTimeoutMs: 300_000,
        },
        generationId: GENERATION_ID,
      })
      const pool = runtime.providerPool()
      raw = async (query, params) =>
        (params === undefined
          ? await pool.unsafe(query)
          : await pool.unsafe(query, [...params])) as Record<string, unknown>[]
      await raw('drop schema if exists agent_workflow cascade')
      await raw('drop schema if exists agent_workflow_meta cascade')
      await migratePostgresqlSchema({ runtime })
      await raw(
        'insert into "agent_workflow_meta"."logical_copy_operations" ' +
          '(operation_id, source_generation_id, contract_digest, plan_digest, stage, created_at, updated_at) ' +
          `values ('${OPERATION_ID}', 'dbg_rfc359_w6_t26_source', 'digest', 'plan', 'prepared', 1, 1)`,
      )
      await raw(
        'insert into "agent_workflow_meta"."database_generations" ' +
          '(generation_id, operation_id, source_generation_id, contract_digest, state, activated_at, first_live_write_at) ' +
          `values ('${GENERATION_ID}', '${OPERATION_ID}', 'dbg_rfc359_w6_t26_source', 'digest', 'active', 1, 1)`,
      )
      restoreProvider = selectDatabaseSchemaProvider('postgresql')
      // 语句录制：包住连接池的 `unsafe`，drizzle 与裸 SQL 两条路都抓得到。池对象是冻结的，
      // 所以走对象字面量而不是 Proxy（Proxy 无法为不可写属性返回别的值）。
      const wrap =
        (original: (query: string, params?: readonly unknown[]) => never) =>
        (query: string, params?: readonly unknown[]) => {
          if (recording) recorded.push({ sql: query, params: params ?? [] })
          return original(query, params)
        }
      const recordingPool = {
        ...pool,
        unsafe: wrap(pool.unsafe.bind(pool) as never),
        reserve: async (options?: { readonly signal?: AbortSignal }) => {
          const connection = await pool.reserve(options)
          return {
            ...connection,
            unsafe: wrap(connection.unsafe.bind(connection) as never),
            release: () => connection.release(),
          }
        },
        close: (options?: { readonly timeout?: number }) => pool.close(options),
      }
      client = createPostgresqlDatabaseClient({
        ...runtime,
        providerPool: () => recordingPool,
      } as unknown as PostgresqlDatabaseRuntime) as unknown as ProviderNeutralDatabase
      await seedAuditCorpus(client, AUDIT_ROWS)
      // 装载后维护：**两件事都要做，缺一件量到的都不是生产里的形状**。
      //
      // · `ANALYZE` —— 没有统计信息时 PostgreSQL 用默认估算，选出的计划反映的是「不知道表
      //   有多大」而不是「缺索引」。
      // · `VACUUM` —— index-only scan 要成立得靠 **visibility map** 证明「这一页全可见」，
      //   而 VM 只由 VACUUM 维护。刚批量灌完的表 VM 是空的，planner 于是改选
      //   `Bitmap Heap Scan`。生产有 autovacuum 在跑、VM 常态是新的，所以不 VACUUM 就是
      //   拿 PG 一个**它从不持续停留**的瞬时状态在审计。实测 10 万行上 1.682ms → 0.557ms。
      //
      // 与 `scripts/perf-run.ts` 的装载后维护保持同一形状——审计与基准必须看同一个库状态，
      // 否则这里判绿的计划在那边量出来是另一个。
      await raw('vacuum analyze')
    }, 600_000)

    afterAll(async () => {
      restoreProvider?.()
      await runtime?.close()
    })

    test('SQLite 上的具名索引在 PostgreSQL 上一条都不少', async () => {
      const restore = selectDatabaseSchemaProvider('sqlite')
      const sqliteIndexes = new Map<string, string[]>()
      try {
        const sqliteDb = createInMemoryDb(MIGRATIONS)
        for (const { name } of sqliteDb.all<{ name: string }>(
          sql.raw("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"),
        )) {
          sqliteIndexes.set(
            name,
            sqliteDb
              .all<{ name: string; origin: string }>(sql.raw(`PRAGMA index_list('${name}')`))
              // origin 'c' = CREATE INDEX 显式建的；'u'/'pk' 是约束派生的，PG 上名字不同。
              .filter((row) => row.origin === 'c')
              .map((row) => row.name),
          )
        }
      } finally {
        restore()
      }
      selectDatabaseSchemaProvider('postgresql')

      const rows = await raw!(
        "select tablename, indexname from pg_indexes where schemaname = 'agent_workflow'",
      )
      const postgresqlIndexes = new Set(rows.map((row) => String(row['indexname'])))
      const omitted = new Set<string>(RFC349_ARCHIVE_THEN_OMIT_TABLES)

      const missing: string[] = []
      let scanned = 0
      for (const [table, names] of [...sqliteIndexes].sort()) {
        if (omitted.has(table)) continue
        for (const name of names) {
          scanned += 1
          if (!postgresqlIndexes.has(name)) missing.push(`${table}.${name}`)
        }
      }
      // 失败关闭：扫描面本身要有下界，否则「没找到缺口」与「没扫到东西」同形。
      expect(scanned).toBeGreaterThan(150)
      expect(
        missing,
        'SQLite 上建了、PostgreSQL 上没有的索引。这类缺口不报错、只变慢——\n' +
          '要么把索引补进 drizzle 声明（PG 的 DDL 从那里投影），要么把该表列进\n' +
          '`RFC349_ARCHIVE_THEN_OMIT_TABLES`（按契约不投影到 PG）：\n' +
          missing.join('\n'),
      ).toEqual([])
    }, 120_000)

    // RFC-311 的头号交付：默认视图翻页走 (branch_started_at, id) 的 keyset 索引，顺着索引
    // 走到 LIMIT 就停，而不是物化全部 root 再排序。SQLite 侧由
    // `rfc311-task-page-fastpath` 的 `EXPLAIN QUERY PLAN` 断言锁着；这条是它的 PostgreSQL
    // 对应物——**正向**锁，防的是「PG 上这条优化其实没生效而没人知道」。
    test('默认视图翻页在 PostgreSQL 上确实走 keyset 索引（RFC-311 的头号交付）', async () => {
      recorded.length = 0
      recording = true
      try {
        await listTaskOperationsPage(client! as never, actorOf('admin'), {})
      } finally {
        recording = false
      }
      // 页查询是这条路径里最长的那条语句（带 facet_values / paged 两个 CTE）。
      const page = [...recorded]
        .filter((statement) => /^\s*(select|with)/i.test(statement.sql))
        .sort((left, right) => right.sql.length - left.sql.length)[0]
      expect(page, '没录到默认视图的页查询').toBeDefined()
      const rows = await raw!(`EXPLAIN (ANALYZE, BUFFERS, COSTS) ${page!.sql}`, page!.params)
      const plan = rows.map((row) => String(row['QUERY PLAN'])).join('\n')
      expect(
        plan,
        'PostgreSQL 没有用 (branch_started_at, id) 的 keyset 索引倒序取这一页——\n' +
          '它多半退回了「物化全部 root 再排序」，也就是 RFC-311 立项要消灭的那个形状。\n' +
          `完整计划：\n${plan}`,
      ).toContain('Index Scan Backward using idx_tasks_branch_started_id')
    }, 120_000)

    test('装载后维护到位：热计数走 index-only scan 且 Heap Fetches 为 0', async () => {
      // RFC-359 AC-11 —— 这条锁的是**库的状态**，不是某条查询的写法。
      //
      // `/api/overview` 的计数在 CI 上连续 5 个 run 都是 PG 慢（中位数 6.0ms vs SQLite 3.2ms，
      // 稳态、无台阶、无尖峰）。原因不在 SQL 里：语料只 `ANALYZE` 过、没 `VACUUM` 过，
      // visibility map 是空的，于是 PostgreSQL 拿不到 index-only scan、退回 `Bitmap Heap Scan`。
      // 那是「刚灌完数据」的瞬时状态，生产有 autovacuum、从不持续停留在那里。
      //
      // 判据取**可见性**本身（`Heap Fetches: 0`）而不是耗时：它与机器负载无关，
      // 和这个文件其余判据同一原则。装载后维护一旦被谁删掉，这条立刻红。
      const plan = (
        await raw!(
          'EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ' +
            'select count(*) from "agent_workflow"."tasks" ' +
            'where parent_task_id is null and catalog_visibility = $1 and status = $2',
          ['public', 'running'],
        )
      )
        .map((row) => String(row['QUERY PLAN']))
        .join('\n')
      expect(
        plan,
        'PostgreSQL 没有对这条热计数用 index-only scan。最可能的原因是语料装载后没 VACUUM——\n' +
          'visibility map 空着，index-only scan 就不成立，planner 退回 Bitmap Heap Scan。\n' +
          `完整计划：\n${plan}`,
      ).toContain('Index Only Scan')
      expect(
        plan,
        '走了 index-only scan 但仍在回堆取可见性（Heap Fetches > 0），等于没省下什么。\n' +
          `完整计划：\n${plan}`,
      ).toContain('Heap Fetches: 0')
    }, 120_000)

    test('热路径的执行计划缺陷与账本逐条对齐（只降不升）', async () => {
      const observed = new Map<string, PlanObservation & { path: string; plan: string }>()
      const jitted = new Set<string>()
      let explained = 0
      const report: string[] = []

      for (const path of AUDITED) {
        recorded.length = 0
        recording = true
        try {
          await path.run(client!)
        } finally {
          recording = false
        }
        const seen = new Set<string>()
        for (const statement of recorded) {
          // ANALYZE 会真的执行语句，所以只对读语句开；写语句取纯 EXPLAIN。
          if (!/^\s*(select|with)/i.test(statement.sql)) continue
          const key = statement.sql.replace(/\s+/g, ' ')
          if (seen.has(key)) continue
          seen.add(key)
          let plan: string
          try {
            const rows = await raw!(
              `EXPLAIN (ANALYZE, BUFFERS, COSTS) ${statement.sql}`,
              statement.params,
            )
            plan = rows.map((row) => String(row['QUERY PLAN'])).join('\n')
          } catch {
            // EXPLAIN 解释不了的（临时构造等）跳过，不假装审计过。
            continue
          }
          explained += 1
          for (const defect of observePlanDefects(plan, AUDIT_ROWS)) {
            if (defect.defect === 'jit-compilation') {
              // 只报告不断言，见 PlanGap.defect 的注释。
              jitted.add(path.name)
              continue
            }
            const id = `${path.name}::${defect.node}`
            if (!observed.has(id)) observed.set(id, { ...defect, path: path.name, plan })
          }
        }
        report.push(`${path.name}: ${seen.size} 条读语句`)
      }

      // 失败关闭：扫描面下界。审不到语句时「没发现缺陷」与「没审计」同形。
      expect(explained, `实际 EXPLAIN 过的语句：\n${report.join('\n')}`).toBeGreaterThanOrEqual(12)

      const ledger = new Map(PLAN_GAPS.map((gap) => [`${gap.path}::${gap.node}`, gap]))

      // ① 新缺陷：观察到的必须已在账上。
      const unlisted = [...observed.entries()].filter(([id]) => !ledger.has(id))
      expect(
        unlisted.map(([id]) => id),
        '这些热查询在 PostgreSQL 上新长出了「每行再查一次」/ JIT 编译的计划缺陷。\n' +
          '要么修查询 / 补索引，要么连同「缺什么」一起登记进 PLAN_GAPS：\n' +
          unlisted
            .map(
              ([id, item]) =>
                `\n### ${id}  (loops=${item.loops}, buffers=${item.buffers})\n${item.plan}`,
            )
            .join('\n'),
      ).toEqual([])

      // ② 烂账：账上的必须仍观察得到。补完索引 / 改完查询后要来销账。
      const stale = [...ledger.keys()].filter((id) => !observed.has(id))
      expect(
        stale,
        '这些账目已经不再复现——多半是索引补上了或查询改写了。\n' +
          '把对应条目从 PLAN_GAPS 里删掉（这就是「可销的账」；留着不删账本就烂了）：\n' +
          stale.join('\n'),
      ).toEqual([])

      // ③ 代价只许降。buffers 与负载无关，是这里唯一的"快慢"判据。
      const worse: string[] = []
      for (const [id, item] of observed) {
        const gap = ledger.get(id)
        if (gap === undefined) continue
        const perRow = item.buffers / AUDIT_ROWS
        if (perRow > gap.buffersPerRow * BUFFER_CEILING_SLACK) {
          worse.push(
            `${gap.id} ${id}: 每行 ${perRow.toFixed(2)} 个 buffer，账上记的天花板是 ${gap.buffersPerRow}`,
          )
        }
      }
      expect(worse, `这些查询比账本记录时更贵了：\n${worse.join('\n')}`).toEqual([])

      for (const gap of PLAN_GAPS) {
        const item = observed.get(`${gap.path}::${gap.node}`)
        if (item === undefined) continue
        console.info(
          `[t26] ${gap.id} ${gap.path} — ${gap.node}: loops=${item.loops} buffers=${item.buffers} ` +
            `(${(item.buffers / AUDIT_ROWS).toFixed(2)}/row)`,
        )
      }
      for (const path of jitted) {
        console.info(
          `[t26] ${path}: PostgreSQL 为这条路径的某条语句触发了 JIT 编译（估算代价越过 jit_above_cost=100000）。` +
            'OLTP 短查询上 JIT 通常净亏——50000 行语料上实测 124.4ms 的语句里 64.8ms 是编译。' +
            '这条只报告不断言（见 PlanGap.defect）。',
        )
      }
    }, 600_000)

    test('参数化热查询的 generic plan 不得比 custom plan 更差（与账本逐条对齐）', async () => {
      const observed = new Map<
        string,
        { path: string; relation: string; sql: string; custom: string; generic: string }
      >()
      let planned = 0
      const report: string[] = []

      for (const path of AUDITED) {
        recorded.length = 0
        recording = true
        try {
          await path.run(client!)
        } finally {
          recording = false
        }
        const seen = new Set<string>()
        for (const statement of recorded) {
          if (!/^\s*(select|with)/i.test(statement.sql)) continue
          // 没有绑定参数的语句只有一份计划，generic / custom 之分不存在。
          if (statement.params.length === 0) continue
          const key = statement.sql.replace(/\s+/g, ' ')
          if (seen.has(key)) continue
          seen.add(key)
          let custom: string
          let generic: string
          try {
            const customRows = await raw!(`EXPLAIN ${statement.sql}`, statement.params)
            custom = customRows.map((row) => String(row['QUERY PLAN'])).join('\n')
            // GENERIC_PLAN 只规划不执行，且**不许带实参**——正是「参数不可见」那份计划。
            const genericRows = await raw!(`EXPLAIN (GENERIC_PLAN) ${statement.sql}`)
            generic = genericRows.map((row) => String(row['QUERY PLAN'])).join('\n')
          } catch {
            // 解释不了的（临时构造、类型推不出来的参数）跳过，不假装审计过。
            continue
          }
          planned += 1
          // PostgreSQL 只在 generic 估算代价不高于 custom 时才换过去；估得更贵的那些
          // 形状退化生产永远吃不到，报出来只会逼人往账本里塞无害条目。
          const customCost = planTotalCost(custom)
          const genericCost = planTotalCost(generic)
          if (customCost === null || genericCost === null || genericCost > customCost) continue
          for (const relation of genericPlanRegressions(custom, generic)) {
            const id = `${path.name}::${relation}`
            if (!observed.has(id))
              observed.set(id, { path: path.name, relation, sql: statement.sql, custom, generic })
          }
        }
        report.push(`${path.name}: ${seen.size} 条带参数的读语句`)
      }

      // 失败关闭：审不到语句时「没发现退化」与「没审计」同形。
      expect(planned, `实际两份计划都取到的语句：\n${report.join('\n')}`).toBeGreaterThanOrEqual(8)

      const ledger = new Map(GENERIC_PLAN_GAPS.map((gap) => [`${gap.path}::${gap.relation}`, gap]))

      // ① 新退化：观察到的必须已在账上。
      const unlisted = [...observed.entries()].filter(([id]) => !ledger.has(id))
      expect(
        unlisted.map(([id]) => id),
        '这些热查询的 generic plan 比 custom plan 差：某个关系在 custom plan 里走索引，\n' +
          '在 generic plan 里塌成顺序扫。生产从这条语句的**第 6 次执行**起就吃这份计划。\n' +
          "修法通常是把那个常量从绑定参数变回常量谓词（`>= ${''}` → `IS NOT NULL`）；\n" +
          '确实要留就连同「哪个参数」一起登记进 GENERIC_PLAN_GAPS：' +
          unlisted
            .map(
              ([id, item]) =>
                `\n\n### ${id}\n${item.sql}\n\n--- custom plan（生产头 5 次）---\n${item.custom}` +
                `\n--- generic plan（第 6 次起）---\n${item.generic}`,
            )
            .join(''),
      ).toEqual([])

      // ② 已销的账必须删掉——留着烂账就判红（方向与 PLAN_GAPS 一致）。
      const stale = GENERIC_PLAN_GAPS.filter((gap) => !observed.has(`${gap.path}::${gap.relation}`))
      expect(
        stale.map((gap) => gap.id),
        '这些 generic-plan 退化已经观察不到了，把对应条目从 GENERIC_PLAN_GAPS 里删掉：\n' +
          stale.map((gap) => `  ${gap.id} — ${gap.path} / ${gap.relation}`).join('\n'),
      ).toEqual([])
    }, 600_000)
  })
}
