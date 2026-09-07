// RFC-359 W8-T26 —— 「聚合 CASE 里的相关子查询」两处改写的**结果等价**锁。
//
// # 为什么这条测试存在
//
// W6-T26 的计划账本（`rfc359-w6-t26-postgresql-plan-audit.test.ts`）量出三条
// 「每行再查一次」的 PostgreSQL 计划缺陷，共同的根因是**写在聚合的 `CASE` 里的相关
// 子查询无法被上提成 semi join**——WHERE 里的 `EXISTS` 两个 planner 都会上提，
// `SUM(CASE WHEN … EXISTS(…) …)` 里的只能对每一行重跑一遍。W8 各按自己那张表的形状
// 改写（两处的解**不一样**，理由见各自源码注释）：
//
//   · **任务目录 `facet_attention`**（T26-G1）——被 join 的 `lifecycle_alerts` 是小表、
//     外层 `tasks` 本来就要全扫，所以预聚合成
//     `LEFT JOIN (SELECT DISTINCT task_id … WHERE resolved_at IS NULL)`。
//     50000 行语料实测 84.1ms → 21.1ms、107,042 → 2,107 个 shared buffer。
//   · **仓库 facets `referenced`**（T26-G3 / G4）——预聚合会把代价从 O(仓库数) 换成
//     O(**任务数**)，而生产里任务表比仓库表大几个数量级（SQLite 上实测因此 0.2ms → 16ms）。
//     所以改成把 `exists` 送回 **WHERE 子句**、`referenced` 拆成三格**互斥**标量子查询
//     （`E / ¬E∧L / ¬E∧¬L∧S`）相加。PostgreSQL 实测 322ms → 59ms、250,319 → 2,021 buffer。
//
// 两条语句被虚高估算代价触发的 JIT 编译也一并消失。
//
// 这类改写**最容易在三个地方悄悄改变结果**，而且改变的是一个「数字」，不会报错：
//
//   ① **重复计数**——`LEFT JOIN` 到一个每键多行的集合会按重复份数放大 `COUNT(*)` 与每个
//      `SUM`（G1 靠 `SELECT DISTINCT` 防它）；把一个 `OR` 拆成几格相加时，任何一格漏掉
//      `not …` 前缀就会把同时命中两条来源的行数两次（G3/G4 的互斥切分靠它）。两种错在
//      「每个键至多一条匹配、每行至多命中一条来源」的语料上完全看不出来。
//   ② **空集**——被 join / 被计数的那一侧一行都没有时，原来的 `EXISTS` 恒 false；改写后
//      仍必须产出全部左行、`all` 那格仍必须是全表行数（写成 INNER JOIN 就会清空分母）。
//   ③ **NULL**——`task_repos.cached_repo_id` / `tasks.cached_repo_id` 都可空，也可以指向
//      一个根本不存在的仓库。判定「有没有匹配上」的谓词必须与原来的 `EXISTS` 逐行同真值。
//
// 所以下面每条断言都在**同一份语料**上跑「改写前的相关子查询形状」与「改写后的形状」，
// 断言两者逐字节相同，并且两个引擎上各跑一遍（`describeEachProvider`）。改写前的形状
// 就写在这个文件里当 oracle——它是被替换掉的那段 SQL 的逐字副本，不是重新推导的等价物。
// 另外用 JS 侧手算的期望值对一遍账，防的是「两个 SQL 形状一起错」。

import { expect, test } from 'bun:test'
import { sql, type SQL } from 'drizzle-orm'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  lifecycleAlerts,
  scheduledTasks,
  taskRepos,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { DrizzleRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import { invalidateRepositoryWorkspaceFacetCaches } from '@/modules/source-control/public/operations'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { listTaskOperationsPage } from './helpers/taskListPage'

const T0 = 1_700_000_000_000

function admin(): Actor {
  return buildActor({
    user: { id: 'admin', username: 'admin', displayName: 'admin', role: 'admin', status: 'active' },
    source: 'session',
  })
}

/** PostgreSQL 把 `count(*)` / `sum(…)` 交回字符串（int8 / numeric），SQLite 交回 number。 */
function numbers(rows: readonly unknown[]): Record<string, number> {
  const row = (rows[0] ?? {}) as Record<string, unknown>
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))
}

// ---------------------------------------------------------------------------
// 语料 —— 三类边界一次铺齐，每条都注明它锁哪一条
// ---------------------------------------------------------------------------

interface TaskSeed {
  readonly id: string
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'awaiting_review' | 'awaiting_human'
  /** 未闭合告警条数（>1 就是「一对多」那条边界）。 */
  readonly openAlerts: number
  /** 已闭合告警条数——它们**不该**让任务落进 attention。 */
  readonly resolvedAlerts: number
  readonly cachedRepoId?: string
  /** 给它落一行 task_repos（遗留直挂判据 `NOT EXISTS (task_repos …)` 的支点）。 */
  readonly taskRepoCachedRepoId?: string | null
}

const TASK_SEEDS: readonly TaskSeed[] = [
  // 空集侧：既无告警、也不引用任何仓库，status 也不在 attention 里。
  { id: 'k-plain', status: 'done', openAlerts: 0, resolvedAlerts: 0 },
  // 一对多：3 条未闭合告警只能让它进 attention **一次**。
  { id: 'k-many-alerts', status: 'done', openAlerts: 3, resolvedAlerts: 1 },
  // 只有已闭合告警 ⇒ 不进 attention（`resolved_at IS NULL` 放错层就会翻）。
  { id: 'k-resolved-only', status: 'done', openAlerts: 0, resolvedAlerts: 2 },
  // status 本身在 attention 里、又带未闭合告警 ⇒ 仍只算一次（OR 不许变成加法）。
  { id: 'k-both', status: 'failed', openAlerts: 2, resolvedAlerts: 0 },
  // 只靠 status 进 attention。
  { id: 'k-status-only', status: 'awaiting_review', openAlerts: 0, resolvedAlerts: 0 },
  // 仓库侧一对多：同一个 repo-many 被三行 task_repos 指着，referenced 只能 +1。
  {
    id: 'k-ref-a',
    status: 'running',
    openAlerts: 1,
    resolvedAlerts: 0,
    taskRepoCachedRepoId: 'repo-many',
  },
  {
    id: 'k-ref-b',
    status: 'running',
    openAlerts: 0,
    resolvedAlerts: 0,
    taskRepoCachedRepoId: 'repo-many',
  },
  {
    id: 'k-ref-c',
    status: 'running',
    openAlerts: 0,
    resolvedAlerts: 0,
    taskRepoCachedRepoId: 'repo-many',
  },
  // 遗留直挂：tasks.cached_repo_id 指向 repo-legacy 且**没有** task_repos 行 ⇒ 算引用。
  { id: 'k-legacy', status: 'done', openAlerts: 0, resolvedAlerts: 0, cachedRepoId: 'repo-legacy' },
  // 遗留直挂被 task_repos 行遮蔽：有 task_repos 行（其 cached_repo_id 为 NULL）⇒
  // `NOT EXISTS (task_repos …)` 不成立，repo-shadowed 不算被引用。那个 NULL 同时锁住
  // 「join 键为 NULL 不许配上任何左行」。
  {
    id: 'k-shadowed',
    status: 'done',
    openAlerts: 0,
    resolvedAlerts: 0,
    cachedRepoId: 'repo-shadowed',
    taskRepoCachedRepoId: null,
  },
  // 悬空引用：指向一个根本不存在的仓库 id ⇒ 它在两种形状里都不该改变任何一格计数。
  {
    id: 'k-dangling',
    status: 'done',
    openAlerts: 0,
    resolvedAlerts: 0,
    cachedRepoId: 'repo-ghost',
  },
  // repo-many 同时又被**遗留直挂**指着（这个任务没有 task_repos 行）⇒ 它落进 explicit
  // 与 legacy 两条来源。互斥切分里 `¬E ∧ L` 必须把它排掉，否则 referenced 数两次。
  {
    id: 'k-legacy-dup',
    status: 'done',
    openAlerts: 0,
    resolvedAlerts: 0,
    cachedRepoId: 'repo-many',
  },
]

const REPO_SEEDS = [
  // 被三行 task_repos 指着（一对多）；同时是 attention 那一格。
  { id: 'repo-many', hasSubmodules: true, lastSubmoduleSyncOk: false },
  // 只被遗留直挂引用。
  { id: 'repo-legacy', hasSubmodules: false, lastSubmoduleSyncOk: true },
  // 被 task_repos 行遮蔽 ⇒ 不算引用。
  { id: 'repo-shadowed', hasSubmodules: true, lastSubmoduleSyncOk: true },
  // 空集侧：谁都没引用它。attention 三态里取 NULL 那一格。
  { id: 'repo-orphan', hasSubmodules: null, lastSubmoduleSyncOk: null },
  // 只被定时任务 payload 引用（referenced 的第三个 OR 臂，改写后仍是字面量 id 列表）。
  { id: 'repo-scheduled', hasSubmodules: true, lastSubmoduleSyncOk: false },
] as const

async function seedBase(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values({
    id: 'admin',
    username: 'admin',
    displayName: 'admin',
    role: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({ id: 'wf1', name: 'nightly', definition: '{}' })
}

async function seedTasks(db: ProviderNeutralDatabase, seeds: readonly TaskSeed[]): Promise<void> {
  let index = 0
  for (const seed of seeds) {
    index += 1
    await db.insert(tasks).values({
      id: seed.id,
      name: `task ${seed.id}`,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/repos/r',
      repoUrl: 'git@github.com:acme/r.git',
      worktreePath: `/tmp/wt-${seed.id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${seed.id}`,
      status: seed.status,
      inputs: '{}',
      startedAt: T0 + index * 1_000,
      finishedAt: null,
      runningMs: 0,
      ownerUserId: 'admin',
      parentTaskId: null,
      invocationDepth: 0,
      launchOrigin: 'manual',
      branchStartedAt: T0 + index * 1_000,
      rootTaskId: seed.id,
      ...(seed.cachedRepoId === undefined ? {} : { cachedRepoId: seed.cachedRepoId }),
    })
    if (seed.taskRepoCachedRepoId !== undefined) {
      await db.insert(taskRepos).values({
        taskId: seed.id,
        repoIndex: 0,
        repoPath: '/repos/r',
        repoUrl: 'git@github.com:acme/r.git',
        worktreePath: `/tmp/wt-${seed.id}`,
        branch: `agent-workflow/${seed.id}`,
        baseBranch: 'main',
        cachedRepoId: seed.taskRepoCachedRepoId,
      })
    }
    for (let n = 0; n < seed.openAlerts; n += 1) {
      await db.insert(lifecycleAlerts).values({
        id: `al-open-${seed.id}-${n}`,
        taskId: seed.id,
        rule: `R${n}`,
        severity: 'warn',
        detail: '{}',
        detectedAt: T0 + n,
        resolvedAt: null,
      })
    }
    for (let n = 0; n < seed.resolvedAlerts; n += 1) {
      await db.insert(lifecycleAlerts).values({
        id: `al-done-${seed.id}-${n}`,
        taskId: seed.id,
        rule: `C${n}`,
        severity: 'warn',
        detail: '{}',
        detectedAt: T0 + n,
        resolvedAt: T0 + n + 1,
      })
    }
  }
}

async function seedRepos(db: ProviderNeutralDatabase): Promise<void> {
  let index = 0
  for (const repo of REPO_SEEDS) {
    index += 1
    await db.insert(cachedRepos).values({
      id: repo.id,
      urlHash: `hash-${repo.id}`,
      urlRedacted: `git@github.com:acme/${repo.id}.git`,
      localPath: `/cache/${repo.id}`,
      defaultBranch: 'main',
      lastFetchedAt: T0 + index * 1_000,
      createdAt: T0,
      hasSubmodules: repo.hasSubmodules,
      lastSubmoduleSyncOk: repo.lastSubmoduleSyncOk,
    })
  }
  await db.insert(scheduledTasks).values({
    id: 'sched-1',
    name: 'nightly',
    ownerUserId: 'admin',
    launchKind: 'workflow',
    launchPayload: JSON.stringify({ repos: [{ cachedRepoId: 'repo-scheduled' }] }),
    scheduleSpec: JSON.stringify({ kind: 'cron', cron: '0 0 * * *', tz: 'UTC' }),
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  })
}

// ---------------------------------------------------------------------------
// 改写前的形状（oracle）——被替换掉的那段 SQL 的逐字副本
// ---------------------------------------------------------------------------

/** `taskListPage/query.ts` 的 `facet_values` 改写前：`SUM(CASE … OR EXISTS(…) …)`。 */
const legacyAttentionFacets = sql`
  SELECT
    COUNT(*) AS facet_all,
    COALESCE(SUM(CASE
      WHEN t.status IN ('failed', 'awaiting_review', 'awaiting_human')
        OR EXISTS (
          SELECT 1 FROM ${lifecycleAlerts} la
          WHERE la.task_id = t.id AND la.resolved_at IS NULL
        )
      THEN 1 ELSE 0 END), 0) AS facet_attention
  FROM ${tasks} t
`

/** 同一格，改写后的形状：预聚合 + LEFT JOIN。 */
const reshapedAttentionFacets = sql`
  SELECT
    COUNT(*) AS facet_all,
    COALESCE(SUM(CASE
      WHEN t.status IN ('failed', 'awaiting_review', 'awaiting_human')
        OR open_alerts.task_id IS NOT NULL
      THEN 1 ELSE 0 END), 0) AS facet_attention
  FROM ${tasks} t
  LEFT JOIN (
    SELECT DISTINCT la.task_id AS task_id
    FROM ${lifecycleAlerts} la
    WHERE la.resolved_at IS NULL
  ) open_alerts ON open_alerts.task_id = t.id
`

/**
 * 定时臂的两种形态：空集（生产在无 payload 引用时渲染 `false`），以及命中两个 id——
 * 其中 `repo-many` 同时又是 explicit，用来锁住 `¬E ∧ ¬L ∧ S` 那一格不许重复计数。
 */
const NO_SCHEDULE: SQL = sql`false`
const ONE_SCHEDULE: SQL = sql`${cachedRepos.id} in (${'repo-scheduled'}, ${'repo-many'})`

/** `repositoryWorkspaceSqlStore` 的 facets 改写前：两个相关 EXISTS 打在 CASE 里。 */
function legacyRepoFacets(scheduled: SQL): SQL {
  return sql`
    SELECT
      count(*) AS all_count,
      sum(case when (
        exists (select 1 from ${taskRepos} where ${taskRepos.cachedRepoId} = ${cachedRepos.id})
        or exists (
          select 1 from ${tasks} where ${tasks.cachedRepoId} = ${cachedRepos.id}
            and not exists (select 1 from ${taskRepos} where ${taskRepos.taskId} = ${tasks.id})
        )
        or ${scheduled}
      ) then 1 else 0 end) AS referenced_count,
      sum(case when (
        ${cachedRepos.hasSubmodules} = ${true} and ${cachedRepos.lastSubmoduleSyncOk} = ${false}
      ) then 1 else 0 end) AS attention_count
    FROM ${cachedRepos}
  `
}

/**
 * 同一格，改写后的形状：`exists` 回到 WHERE 里，`referenced` 拆成三格**互斥**计数
 * （E / ¬E∧L / ¬E∧¬L∧S），相加即原来那个 OR 的并集势。
 *
 * 互斥性是这里的第二个等价支点（第一个是 LEFT JOIN 的去重）：任何一格漏掉自己的
 * `not …` 前缀，同一个仓库就会被数两次——`repo-many` 既有 task_repos 引用又有遗留直挂
 * 时正好命中这个坑，语料里 `k-legacy` / `k-ref-*` 就是为它铺的。
 */
function reshapedRepoFacets(scheduled: SQL): SQL {
  const explicit = sql`exists (
    select 1 from ${taskRepos} where ${taskRepos.cachedRepoId} = ${cachedRepos.id}
  )`
  const legacy = sql`exists (
    select 1 from ${tasks} where ${tasks.cachedRepoId} = ${cachedRepos.id}
      and not exists (select 1 from ${taskRepos} where ${taskRepos.taskId} = ${tasks.id})
  )`
  return sql`
    SELECT
      (SELECT count(*) FROM ${cachedRepos}) AS all_count,
      (SELECT count(*) FROM ${cachedRepos} WHERE ${explicit})
        + (SELECT count(*) FROM ${cachedRepos} WHERE not ${explicit} and ${legacy})
        + (SELECT count(*) FROM ${cachedRepos}
             WHERE ${scheduled} and not ${explicit} and not ${legacy}) AS referenced_count,
      (SELECT count(*) FROM ${cachedRepos}
         WHERE ${cachedRepos.hasSubmodules} = ${true}
           and ${cachedRepos.lastSubmoduleSyncOk} = ${false}) AS attention_count
  `
}

// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W8-T26 —— 计划改写的结果等价', (harness: ProviderHarness) => {
  test('任务 attention facet：改写前后逐字节相同（一对多 / 已闭合 / status 与告警同时命中 / 悬空）', async () => {
    const { db } = harness
    await seedBase(db)
    await seedTasks(db, TASK_SEEDS)

    const legacy = numbers(await db.all(legacyAttentionFacets))
    const reshaped = numbers(await db.all(reshapedAttentionFacets))
    expect(
      reshaped,
      '预聚合 LEFT JOIN 与相关 EXISTS 的结果分叉了。最可能的原因：\n' +
        '① 派生表漏了 DISTINCT ⇒ 一个任务的 3 条未闭合告警把它数了 3 次（facet_all 也一起放大）；\n' +
        '② `resolved_at IS NULL` 放错层 ⇒ 只有已闭合告警的任务被算进了 attention。',
    ).toEqual(legacy)

    // 手算的第三方期望：两个 SQL 形状一起错时，上面那条对不出来。
    // attention = {k-many-alerts, k-both, k-status-only, k-ref-a}，k-both 只算一次。
    expect(reshaped).toEqual({ facet_all: TASK_SEEDS.length, facet_attention: 4 })
  })

  test('任务 attention facet：lifecycle_alerts 整张表为空时 LEFT JOIN 不许吃掉分母', async () => {
    const { db } = harness
    await seedBase(db)
    await seedTasks(
      db,
      TASK_SEEDS.map((seed) => ({ ...seed, openAlerts: 0, resolvedAlerts: 0 })),
    )

    const legacy = numbers(await db.all(legacyAttentionFacets))
    const reshaped = numbers(await db.all(reshapedAttentionFacets))
    expect(reshaped, 'LEFT JOIN 被写成 INNER JOIN 时这里会掉到 0').toEqual(legacy)
    // 只剩 status 那条臂：{k-both, k-status-only}。
    expect(reshaped).toEqual({ facet_all: TASK_SEEDS.length, facet_attention: 2 })
  })

  test('仓库 referenced facet：改写前后逐字节相同（一对多 / 遗留直挂 / 被遮蔽 / NULL / 悬空 / 定时）', async () => {
    const { db } = harness
    await seedBase(db)
    await seedRepos(db)
    await seedTasks(db, TASK_SEEDS)

    for (const [label, scheduled] of [
      ['空定时集合', NO_SCHEDULE],
      ['定时集合命中两个仓库（其中一个同时是 explicit）', ONE_SCHEDULE],
    ] as const) {
      const legacy = numbers(await db.all(legacyRepoFacets(scheduled)))
      const reshaped = numbers(await db.all(reshapedRepoFacets(scheduled)))
      expect(
        reshaped,
        `${label}时互斥三格与原来的 OR 分叉了。最可能的原因：\n` +
          '① 某一格漏了 `not …` 前缀 ⇒ repo-many（既是 explicit、又是遗留直挂、还在定时集合里）\n' +
          '   被数了两次甚至三次；\n' +
          '② 遗留直挂的 `NOT EXISTS (task_repos …)` 判据变了 ⇒ k-shadowed 那行 cached_repo_id\n' +
          '   为 NULL 的 task_repos 不再遮蔽它。',
      ).toEqual(legacy)
    }

    // referenced = {repo-many（三行 task_repos + 一条遗留直挂，只算一次）,
    //               repo-legacy（遗留直挂）}；repo-shadowed 被 task_repos 行遮蔽、
    // repo-orphan 无人引用、repo-ghost 根本不在 cached_repos 里。
    // attention = {repo-many, repo-scheduled}（has_submodules 且 sync_ok = false）。
    expect(numbers(await db.all(reshapedRepoFacets(NO_SCHEDULE)))).toEqual({
      all_count: REPO_SEEDS.length,
      referenced_count: 2,
      attention_count: 2,
    })
    expect(numbers(await db.all(reshapedRepoFacets(ONE_SCHEDULE)))).toEqual({
      all_count: REPO_SEEDS.length,
      referenced_count: 3,
      attention_count: 2,
    })
  })

  test('仓库 referenced facet：task_repos / tasks 都为空时不许吃掉分母', async () => {
    const { db } = harness
    await seedBase(db)
    await seedRepos(db)

    const legacy = numbers(await db.all(legacyRepoFacets(NO_SCHEDULE)))
    const reshaped = numbers(await db.all(reshapedRepoFacets(NO_SCHEDULE)))
    expect(reshaped, 'all_count 那格若跟着谓词走，空引用集会把分母清零').toEqual(legacy)
    expect(reshaped).toEqual({
      all_count: REPO_SEEDS.length,
      referenced_count: 0,
      attention_count: 2,
    })
  })

  test('端到端：两条真实读路径产出的 facets 与手算期望一致', async () => {
    const { db } = harness
    await seedBase(db)
    await seedRepos(db)
    await seedTasks(db, TASK_SEEDS)

    const page = await listTaskOperationsPage(db as never, admin(), {})
    // 无 parentId 的默认视图必然是 root 页（facets 只挂在这一支上）。
    expect(page.kind).toBe('root')
    expect(page.kind === 'root' ? page.facets : undefined).toEqual({
      all: TASK_SEEDS.length,
      active: 4, // k-status-only(awaiting_review) + k-ref-{a,b,c}(running)
      attention: 4,
      finished: 8, // 其余全是 done，外加 k-both 的 failed
    })

    invalidateRepositoryWorkspaceFacetCaches()
    const store = new DrizzleRepositoryWorkspaceStore(db)
    store.invalidateCachedRepoFacets()
    const repoPage = await store.listCachedRepoPage({ limit: 20 })
    expect(repoPage.facets).toEqual({
      all: REPO_SEEDS.length,
      referenced: 3, // repo-many + repo-legacy + repo-scheduled（定时 payload）
      unused: 2,
      attention: 2,
    })
  })
})
