// RFC-359 W8 —— code-capability 上下文两对成对适配器的双引擎对拍。
//
// 被两本既有账本同时漏掉的两对
// ============================
//   · `CapabilityMatrixReadPort`
//       SQLite     —— `modules/code-capability/infrastructure/sqliteCapabilityMatrix.ts`
//       PostgreSQL —— `modules/code-capability/infrastructure/postgresqlCapabilityMatrixRead.ts`
//   · `CodeMetricsReadPort`
//       SQLite     —— `modules/code-capability/infrastructure/sqliteCodeMetricsRead.ts`
//       PostgreSQL —— `modules/code-capability/infrastructure/postgresqlCodeMetricsQuery.ts`
//
// W5 的成对账本按「去掉引擎前缀后**词干相同**且同目录」配对，而这两对的词干本来就不同
// （`CapabilityMatrix` vs `CapabilityMatrixRead`、`CodeMetricsRead` vs `CodeMetricsQuery`），
// 所以按名字配对的判据结构上抓不到它们。W8 的能力级账本
// （`architecture/rfc359-w8-capability-pair-conformance.test.ts`）靠**端口类型**把它们登记了下来，
// 但登记不是对拍——本文件才是。
//
// 此前的覆盖是**单引擎倒挂 + 假库**
// --------------------------------
//   · `rfc304-code-queries.test.ts` / `rfc304-code-metrics.test.ts` 只跑 SQLite 那一份；
//   · `rfc349-code-matrix-postgresql-adapter.test.ts` / `rfc349-code-metrics-postgresql-adapter.test.ts`
//     跑的是**手喂行元组的假连接池**——它们断言的是「适配器把我塞进去的元组原样转出来」，
//     真库返回什么类型、两侧对同一份数据是否给出同一个答案，一条都没问过。
//
// 判据落在**用户可见契约**上，不是实现层
// --------------------------------------
//   · 能力矩阵 = 「仓库设置页的能力矩阵这张表显示了什么」：每个能力的 readiness 徽标、
//     缺什么（issues）、点哪儿去修（repairActions）。
//   · 代码度量 = 「/code 指标面板返回了什么」：采纳四桶与运行计数。
//
// 形状：`describeEachProvider` 在 SQLite 内存库与真 PostgreSQL 上各跑一遍同一段 body，
// 而 body 里把**两份实现都构造在同一个库上**（两侧都是 provider-中立的 drizzle query
// builder，跑得起来），于是每个用例同时锁住两件事：
//   ① 跨实现——同一个库、同一份数据，两份实现给出同一张表；
//   ② 跨引擎——同一段期望值在两个引擎上都要成立（harness 强制，写不出「PG 上不一样也算过」）。
//
// **正向对照是必需的**：只断言「两侧相等」的用例，被一对「永远返回空」的实现也能满足。
// 所以每条对拍都先逐字钉住期望内容（ready / 缺哪一项 / 四桶各是多少），再拿它去比两侧。

import { expect, test } from 'bun:test'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  agents,
  cachedRepos,
  capabilityTemplates,
  codeFindings,
  codeHostConnections,
  codeWorkItems,
  codeWorkRounds,
  repoCapabilityConfig,
  webhookEndpoints,
  webhookTriggers,
} from '@/db/schema'
import { createCodeMatrixQuery } from '@/modules/code-capability/application/codeMatrixQuery'
import {
  createCodeMetricsQuery,
  DEFAULT_METRICS_WINDOW_MS,
} from '@/modules/code-capability/application/codeMetricsQuery'
import { createPostgresqlCapabilityMatrixRead } from '@/modules/code-capability/infrastructure/postgresqlCapabilityMatrixRead'
import { createPostgresqlCodeMetricsRead } from '@/modules/code-capability/infrastructure/postgresqlCodeMetricsQuery'
import { createSqliteCapabilityMatrixRead } from '@/modules/code-capability/infrastructure/sqliteCapabilityMatrix'
import { createSqliteCodeMetricsRead } from '@/modules/code-capability/infrastructure/sqliteCodeMetricsRead'
import type { CodeMatrixRow, CodeMetricsSummary } from '@/modules/code-capability/public/queries'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_700_000_000_000
const REPO = 'group/app'
const GITLAB_ENDPOINT = 'ep-gitlab'
const GITHUB_ENDPOINT = 'ep-github'

// ---------------------------------------------------------------------------
// 两份实现，同一个库
// ---------------------------------------------------------------------------

/** 能力矩阵：`<实现名> → 该实现渲染出的矩阵行`。 */
async function matrixByImplementation(
  harness: ProviderHarness,
  repoId: string,
): Promise<Record<'sqliteCapabilityMatrix' | 'postgresqlCapabilityMatrixRead', CodeMatrixRow[]>> {
  const db = harness.db
  return {
    sqliteCapabilityMatrix: [
      ...(await createCodeMatrixQuery(
        createSqliteCapabilityMatrixRead(db as unknown as DbClient),
      ).forRepo(repoId)),
    ],
    postgresqlCapabilityMatrixRead: [
      ...(await createCodeMatrixQuery(
        createPostgresqlCapabilityMatrixRead(db as unknown as PostgresqlDatabaseClient),
      ).forRepo(repoId)),
    ],
  }
}

/** 代码度量：`<实现名> → 该实现算出的指标面板`。 */
async function metricsByImplementation(
  harness: ProviderHarness,
): Promise<Record<'sqliteCodeMetricsRead' | 'postgresqlCodeMetricsQuery', CodeMetricsSummary>> {
  const db = harness.db
  return {
    sqliteCodeMetricsRead: await createCodeMetricsQuery(
      createSqliteCodeMetricsRead(db as unknown as DbClient),
    ).summary({ now: NOW }),
    postgresqlCodeMetricsQuery: await createCodeMetricsQuery(
      createPostgresqlCodeMetricsRead(db as unknown as PostgresqlDatabaseClient),
    ).summary({ now: NOW }),
  }
}

/** 页面按能力名读这张表；比较前按能力名排定，免得「顺序」把「内容」的红盖住。 */
function byCapability(rows: readonly CodeMatrixRow[]): CodeMatrixRow[] {
  return [...rows].sort((a, b) => (a.capability < b.capability ? -1 : 1))
}

// ---------------------------------------------------------------------------
// 种子
// ---------------------------------------------------------------------------

/** 一个能配得通的部署：一个启用的 gitlab endpoint + 一个 gitlab 连接 + 一个仓库。 */
async function seedGitlabDeployment(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(webhookEndpoints).values({
    id: GITLAB_ENDPOINT,
    name: 'gl',
    provider: 'gitlab',
    urlToken: 'aw_whk_w8_gitlab',
    secretEnc: 'sealed',
    enabled: true,
  })
  await db.insert(codeHostConnections).values({
    provider: 'gitlab',
    baseUrl: 'https://gitlab.example.com/api/v4',
    repositoryUrlPrefixesJson: JSON.stringify(['https://gitlab.example.com/']),
    tokenEnc: 'sealed',
    tokenHint: 'abcd',
    connectionGeneration: 'gen-gitlab',
    updatedAt: NOW,
  })
  await db.insert(cachedRepos).values({
    id: REPO,
    urlHash: 'aabbccdd',
    urlRedacted: 'https://gitlab.example.com/group/app.git',
    localPath: '/tmp/repos/app',
    lastFetchedAt: NOW,
    createdAt: NOW,
  })
}

async function seedAgent(db: ProviderNeutralDatabase, id: string): Promise<void> {
  await db.insert(agents).values({ id, name: id, bodyMd: 'x', createdAt: NOW, updatedAt: NOW })
}

async function seedTemplate(
  db: ProviderNeutralDatabase,
  input: { id: string; capability: string; agentBySlot: Readonly<Record<string, string>> },
): Promise<void> {
  await db.insert(capabilityTemplates).values({
    id: input.id,
    name: input.id,
    capability: input.capability,
    agentBySlotJson: JSON.stringify(input.agentBySlot),
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function seedTrigger(
  db: ProviderNeutralDatabase,
  input: { id: string; endpointId: string; capability: string; events: readonly string[] },
): Promise<void> {
  await db.insert(webhookTriggers).values({
    id: input.id,
    name: input.id,
    endpointId: input.endpointId,
    ownerUserId: 'u1',
    repoScope: JSON.stringify({ kind: 'paths', paths: [REPO] }),
    eventTypes: JSON.stringify(input.events),
    launchKind: 'code-round',
    launchRefId: input.capability,
    launchPayload: JSON.stringify({ capability: input.capability }),
    autoRegisterRepos: false,
  })
}

async function seedCell(
  db: ProviderNeutralDatabase,
  input: { repoId?: string; capability: string; templateId: string | null; enabled: boolean },
): Promise<void> {
  const repoId = input.repoId ?? REPO
  await db.insert(repoCapabilityConfig).values({
    id: `cell-${repoId}-${input.capability}`,
    repoId,
    capability: input.capability,
    templateId: input.templateId,
    enabled: input.enabled,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function seedFinding(
  db: ProviderNeutralDatabase,
  input: {
    id: string
    capability: string
    published: boolean
    resolvedAt: number | null
    codeChangedAt: number | null
    createdAt: number
  },
): Promise<void> {
  await db.insert(codeFindings).values({
    id: input.id,
    codeHostEndpointId: GITLAB_ENDPOINT,
    stableProjectId: 'proj-1',
    anchorKind: 'mr',
    anchorId: 'mr-1',
    capability: input.capability,
    fingerprint: input.id,
    externalId: input.published ? `thread-${input.id}` : null,
    resolvedAt: input.resolvedAt,
    codeChangedAt: input.codeChangedAt,
    createdAt: input.createdAt,
    lastSeenAt: input.createdAt,
  })
}

async function seedRound(
  db: ProviderNeutralDatabase,
  input: {
    id: string
    workItemId: string
    roundSeq: number
    outcome: 'published' | 'awaiting' | 'failed' | 'canceled' | 'superseded' | null
    startedAt: number
    endedAt: number | null
  },
): Promise<void> {
  await db.insert(codeWorkRounds).values({
    id: input.id,
    workItemId: input.workItemId,
    roundSeq: input.roundSeq,
    epoch: 1,
    outcome: input.outcome,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  })
}

async function seedWorkItem(
  db: ProviderNeutralDatabase,
  input: { id: string; capability: string },
): Promise<void> {
  await db.insert(codeWorkItems).values({
    id: input.id,
    codeHostEndpointId: GITLAB_ENDPOINT,
    stableProjectId: 'proj-1',
    capability: input.capability,
    anchorKind: 'mr',
    anchorId: input.id,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W8 —— 能力矩阵 / 代码度量的双引擎对拍', (harness) => {
  test('能力矩阵：同一个库上两份实现渲染出同一张表', async () => {
    const db = harness.db
    await seedGitlabDeployment(db)
    await seedAgent(db, 'agent-reviewer')
    await seedAgent(db, 'agent-cifixer')
    await seedTemplate(db, {
      id: 'tpl-review',
      capability: 'mr-review',
      agentBySlot: { reviewer: 'agent-reviewer' },
    })
    await seedTemplate(db, {
      id: 'tpl-cifix',
      capability: 'ci-fix',
      agentBySlot: { 'ci-fixer': 'agent-cifixer' },
    })
    await seedTrigger(db, {
      id: 'tr-review',
      endpointId: GITLAB_ENDPOINT,
      capability: 'mr-review',
      events: ['mr_opened'],
    })
    // ci-fix 的 trigger 只订阅了 MR 事件 —— 没有 pipeline_* 就没有唤醒源（AC-14d）。
    await seedTrigger(db, {
      id: 'tr-cifix',
      endpointId: GITLAB_ENDPOINT,
      capability: 'ci-fix',
      events: ['mr_opened'],
    })

    // 五种在页面上长得完全不同的格子。
    await seedCell(db, { capability: 'mr-review', templateId: 'tpl-review', enabled: true })
    await seedCell(db, { capability: 'ci-fix', templateId: 'tpl-cifix', enabled: true })
    await seedCell(db, { capability: 'mr-comment-fix', templateId: null, enabled: true })
    await seedCell(db, { capability: 'requirement', templateId: 'tpl-deleted', enabled: true })
    await seedCell(db, { capability: 'mr-monitor', templateId: 'tpl-review', enabled: false })

    // 用户在页面上看到的那一列 —— 逐字钉死，`toEqual` 两侧才不是「空 == 空」。
    const NO_TRIGGER = {
      code: 'no-trigger' as const,
      detail: 'no webhook trigger is wired for this repo',
    }
    const FIX_TRIGGER = {
      code: 'no-trigger' as const,
      label: 'Connect a webhook so events can reach this repository',
      route: '/webhooks',
    }
    const FIX_AGENT = {
      code: 'agent-not-visible' as const,
      label: 'Point the reviewer slot at an agent this repository can see',
      route: '/code/bindings',
    }
    const expected: CodeMatrixRow[] = [
      {
        repoId: REPO,
        capability: 'ci-fix',
        enabled: true,
        readiness: 'misconfigured',
        issues: [
          {
            code: 'no-wake-source',
            detail:
              'this capability has no pipeline event or wake entry point, so nothing can start it',
          },
        ],
        repairActions: [
          {
            code: 'no-wake-source',
            label: 'Give this capability something that can start it',
            route: '/webhooks',
          },
        ],
        templateId: 'tpl-cifix',
      },
      {
        repoId: REPO,
        capability: 'mr-comment-fix',
        enabled: true,
        readiness: 'misconfigured',
        issues: [
          { code: 'no-binding', detail: 'no capability binding is selected for this repo' },
          NO_TRIGGER,
          {
            code: 'agent-not-visible',
            detail: "the agent bound to slot 'fixer' is missing or not visible here",
          },
        ],
        repairActions: [
          {
            code: 'no-binding',
            label: 'Choose which review configuration this repository uses',
            route: '/code?tab=templates',
          },
          FIX_TRIGGER,
          FIX_AGENT,
        ],
        templateId: null,
      },
      {
        repoId: REPO,
        capability: 'mr-monitor',
        enabled: false,
        readiness: 'disabled',
        issues: [],
        repairActions: [],
        templateId: 'tpl-review',
      },
      {
        repoId: REPO,
        capability: 'mr-review',
        enabled: true,
        readiness: 'ready',
        issues: [],
        repairActions: [],
        templateId: 'tpl-review',
      },
      {
        repoId: REPO,
        capability: 'requirement',
        enabled: true,
        readiness: 'misconfigured',
        issues: [
          {
            code: 'framework-missing',
            detail: 'the selected binding references a framework that no longer exists',
          },
          NO_TRIGGER,
          {
            code: 'agent-not-visible',
            detail: "the agent bound to slot 'analyst' is missing or not visible here",
          },
          {
            code: 'agent-not-visible',
            detail: "the agent bound to slot 'implementer' is missing or not visible here",
          },
        ],
        repairActions: [
          {
            code: 'framework-missing',
            label: 'Restore or replace the framework this binding was built on',
            route: '/code/frameworks',
          },
          FIX_TRIGGER,
          FIX_AGENT,
          FIX_AGENT,
        ],
        templateId: 'tpl-deleted',
      },
    ]

    const rendered = await matrixByImplementation(harness, REPO)
    expect(byCapability(rendered.sqliteCapabilityMatrix)).toEqual(expected)
    expect(byCapability(rendered.postgresqlCapabilityMatrixRead)).toEqual(expected)
    // 顺序也是用户可见的：页面按读回来的顺序渲染这张表。
    expect(rendered.postgresqlCapabilityMatrixRead).toEqual(rendered.sqliteCapabilityMatrix)
  })

  test('能力矩阵：仓库 URL 认不出归属哪个代码托管时，两份实现给出同一个 code-host 结论', async () => {
    const db = harness.db
    // 两个 provider 都配了 endpoint（真实部署：一边 GitLab 一边 GitHub），
    // 而这个仓库的 URL 哪个连接的前缀都不匹配 —— `resolveRepoEndpoint` 无法判定归属。
    await seedGitlabDeployment(db)
    await db.insert(webhookEndpoints).values({
      id: GITHUB_ENDPOINT,
      name: 'gh',
      provider: 'github',
      urlToken: 'aw_whk_w8_github',
      secretEnc: 'sealed',
      enabled: true,
    })
    await db.insert(codeHostConnections).values({
      provider: 'github',
      baseUrl: 'https://api.github.com',
      repositoryUrlPrefixesJson: JSON.stringify([]),
      tokenEnc: 'sealed',
      tokenHint: 'wxyz',
      connectionGeneration: 'gen-github',
      updatedAt: NOW,
    })
    // 覆盖掉 gitlab 部署种下的仓库 URL：换成谁都不认的自建域名。
    await db.delete(cachedRepos)
    await db.insert(cachedRepos).values({
      id: REPO,
      urlHash: 'ddccbbaa',
      urlRedacted: 'https://git.internal.example/group/app.git',
      localPath: '/tmp/repos/app',
      lastFetchedAt: NOW,
      createdAt: NOW,
    })
    await seedAgent(db, 'agent-reviewer')
    await seedTemplate(db, {
      id: 'tpl-review',
      capability: 'mr-review',
      agentBySlot: { reviewer: 'agent-reviewer' },
    })
    await seedTrigger(db, {
      id: 'tr-review',
      endpointId: GITLAB_ENDPOINT,
      capability: 'mr-review',
      events: ['mr_opened'],
    })
    await seedCell(db, { capability: 'mr-review', templateId: 'tpl-review', enabled: true })

    const rendered = await matrixByImplementation(harness, REPO)
    // 归属判不出来 = 「结果发不出去」，页面必须显示 code-host-unconfigured 并给出去哪儿修。
    // 同一个部署、同一个仓库，两份实现不能一个说通一个说不通。
    expect(rendered.postgresqlCapabilityMatrixRead).toEqual(rendered.sqliteCapabilityMatrix)
    const [row] = rendered.sqliteCapabilityMatrix
    expect(row?.readiness).toBe('misconfigured')
    expect(row?.issues.map((issue) => issue.code)).toEqual(['no-trigger', 'code-host-unconfigured'])
  })

  test('能力矩阵：一个格子都没有的仓库两侧都是空表', async () => {
    // 正向对照的反面：空输入两侧都得是空 —— 但它单独证明不了任何事，
    // 所以只作为上面两条**有内容**的对拍的边界补充。
    const rendered = await matrixByImplementation(harness, 'group/never-configured')
    expect(rendered.sqliteCapabilityMatrix).toEqual([])
    expect(rendered.postgresqlCapabilityMatrixRead).toEqual([])
  })

  test('代码度量：同一个库上两份实现算出同一块指标面板', async () => {
    const db = harness.db
    const inWindow = NOW - 1_000

    // 采纳四桶：published/adopted/quietFix/disagreed/outstanding 各自可分辨。
    await seedFinding(db, {
      id: 'f-adopted',
      capability: 'mr-review',
      published: true,
      resolvedAt: NOW,
      codeChangedAt: NOW,
      createdAt: inWindow,
    })
    await seedFinding(db, {
      id: 'f-quiet',
      capability: 'mr-review',
      published: true,
      resolvedAt: null,
      codeChangedAt: NOW,
      createdAt: inWindow,
    })
    await seedFinding(db, {
      id: 'f-disagreed',
      capability: 'ci-fix',
      published: true,
      resolvedAt: NOW,
      codeChangedAt: null,
      createdAt: inWindow,
    })
    await seedFinding(db, {
      id: 'f-outstanding',
      capability: 'ci-fix',
      published: true,
      resolvedAt: null,
      codeChangedAt: null,
      createdAt: inWindow,
    })
    // 没发布过的（externalId 为空）从来没出现在任何人面前，不算未采纳。
    await seedFinding(db, {
      id: 'f-unpublished',
      capability: 'mr-review',
      published: false,
      resolvedAt: null,
      codeChangedAt: null,
      createdAt: inWindow,
    })
    // 窗口之外的不该被算进来。
    await seedFinding(db, {
      id: 'f-too-old',
      capability: 'mr-review',
      published: true,
      resolvedAt: null,
      codeChangedAt: null,
      createdAt: NOW - DEFAULT_METRICS_WINDOW_MS - 1,
    })

    await seedWorkItem(db, { id: 'wi-review', capability: 'mr-review' })
    await seedWorkItem(db, { id: 'wi-cifix', capability: 'ci-fix' })
    // 同一个 (capability, outcome, endedAt) 上放两轮 —— 分组计数必须是 2，
    // 而不是把两行各记一次、也不是把数字当字符串拼成 "011"。
    await seedRound(db, {
      id: 'r-pub-1',
      workItemId: 'wi-review',
      roundSeq: 1,
      outcome: 'published',
      startedAt: inWindow,
      endedAt: NOW,
    })
    await seedRound(db, {
      id: 'r-pub-2',
      workItemId: 'wi-review',
      roundSeq: 2,
      outcome: 'published',
      startedAt: inWindow,
      endedAt: NOW,
    })
    await seedRound(db, {
      id: 'r-failed',
      workItemId: 'wi-review',
      roundSeq: 3,
      outcome: 'failed',
      startedAt: inWindow,
      endedAt: NOW,
    })
    // outcome 为空但已结束 = incomplete；outcome 为空且没结束 = 只计入 rounds。
    await seedRound(db, {
      id: 'r-incomplete',
      workItemId: 'wi-cifix',
      roundSeq: 1,
      outcome: null,
      startedAt: inWindow,
      endedAt: NOW,
    })
    await seedRound(db, {
      id: 'r-running',
      workItemId: 'wi-cifix',
      roundSeq: 2,
      outcome: null,
      startedAt: inWindow,
      endedAt: null,
    })
    // 窗口之外的一轮不该被算进来。
    await seedRound(db, {
      id: 'r-too-old',
      workItemId: 'wi-cifix',
      roundSeq: 3,
      outcome: 'published',
      startedAt: NOW - DEFAULT_METRICS_WINDOW_MS - 1,
      endedAt: NOW,
    })

    const expected: CodeMetricsSummary = {
      windowMs: DEFAULT_METRICS_WINDOW_MS,
      adoption: [
        {
          capability: 'ci-fix',
          published: 2,
          adopted: 0,
          quietFix: 0,
          disagreed: 1,
          outstanding: 1,
        },
        {
          capability: 'mr-review',
          published: 2,
          adopted: 1,
          quietFix: 1,
          disagreed: 0,
          outstanding: 0,
        },
      ],
      runs: [
        { capability: 'ci-fix', rounds: 2, published: 0, failed: 0, awaiting: 0, incomplete: 1 },
        { capability: 'mr-review', rounds: 3, published: 2, failed: 1, awaiting: 0, incomplete: 0 },
      ],
    }

    const rendered = await metricsByImplementation(harness)
    expect(rendered.sqliteCodeMetricsRead).toEqual(expected)
    expect(rendered.postgresqlCodeMetricsQuery).toEqual(expected)
  })

  test('代码度量：一行都没有时两侧都是空面板', async () => {
    const rendered = await metricsByImplementation(harness)
    const empty: CodeMetricsSummary = {
      windowMs: DEFAULT_METRICS_WINDOW_MS,
      adoption: [],
      runs: [],
    }
    expect(rendered.sqliteCodeMetricsRead).toEqual(empty)
    expect(rendered.postgresqlCodeMetricsQuery).toEqual(empty)
  })
})
