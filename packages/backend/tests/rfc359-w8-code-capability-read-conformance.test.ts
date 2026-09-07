// RFC-359 W8 / W12 —— 能力矩阵与代码度量的双引擎行为对拍。
// W8 钉住的页面内容在 W12 合一后仍须成立：两个真实数据库通过同一个
// code-history 组合层返回相同的 readiness、issues、repairActions 和度量计数。
// 矩阵还保留批读上界：增加格子数量不能退回逐格查询；空仓库只读取配置表。

import { expect, test } from 'bun:test'

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
import { DEFAULT_METRICS_WINDOW_MS } from '@/modules/code-capability/application/codeMetricsQuery'
import { composeCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import type { CodeMatrixRow, CodeMetricsSummary } from '@/modules/code-capability/public/queries'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_700_000_000_000
const REPO = 'group/app'
const GITLAB_ENDPOINT = 'ep-gitlab'
const GITHUB_ENDPOINT = 'ep-github'

// ---------------------------------------------------------------------------
// 两个真实数据库使用同一个生产组合层
// ---------------------------------------------------------------------------

async function renderMatrix(
  harness: ProviderHarness,
  repoId: string,
): Promise<readonly CodeMatrixRow[]> {
  return composeCodeHistoryQueries(harness.db).matrix.forRepo(repoId)
}

async function renderMetrics(harness: ProviderHarness): Promise<CodeMetricsSummary> {
  return composeCodeHistoryQueries(harness.db).metrics.summary({ now: NOW })
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
  test('能力矩阵：两引擎的统一读面渲染出相同的 readiness 和修复入口', async () => {
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

    const rendered = await renderMatrix(harness, REPO)
    expect(byCapability(rendered)).toEqual(expected)
  })

  test('能力矩阵：增加格子仍保持五次批量读取', async () => {
    const db = harness.db
    await seedGitlabDeployment(db)
    await seedAgent(db, 'agent-reviewer')
    await seedTemplate(db, {
      id: 'tpl-review',
      capability: 'mr-review',
      agentBySlot: { reviewer: 'agent-reviewer' },
    })
    await seedCell(db, { capability: 'mr-review', templateId: 'tpl-review', enabled: true })

    const singleRecording = harness.recordStatements()
    try {
      const rows = await renderMatrix(harness, REPO)
      expect(rows.map((row) => row.capability)).toEqual(['mr-review'])
      expect(singleRecording.selects()).toHaveLength(5)
    } finally {
      singleRecording.stop()
    }

    for (const capability of ['ci-fix', 'mr-comment-fix', 'requirement', 'mr-monitor']) {
      await seedCell(db, { capability, templateId: 'tpl-review', enabled: true })
    }

    const multipleRecording = harness.recordStatements()
    try {
      const rows = await renderMatrix(harness, REPO)
      expect(byCapability(rows).map((row) => row.capability)).toEqual([
        'ci-fix',
        'mr-comment-fix',
        'mr-monitor',
        'mr-review',
        'requirement',
      ])
      expect(multipleRecording.selects()).toHaveLength(5)
    } finally {
      multipleRecording.stop()
    }
  })

  test('能力矩阵：仓库 URL 认不出归属哪个代码托管时返回 code-host 缺口', async () => {
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

    const rendered = await renderMatrix(harness, REPO)
    // 归属判不出来 = 「结果发不出去」，页面必须显示 code-host-unconfigured 并给出去哪儿修。
    const [row] = rendered
    expect(row?.readiness).toBe('misconfigured')
    expect(row?.issues.map((issue) => issue.code)).toEqual(['no-trigger', 'code-host-unconfigured'])
  })

  test('能力矩阵：一个格子都没有的仓库只读配置后返回空表', async () => {
    const recording = harness.recordStatements()
    try {
      expect(await renderMatrix(harness, 'group/never-configured')).toEqual([])
      expect(recording.selects()).toHaveLength(1)
    } finally {
      recording.stop()
    }
  })

  test('代码度量：两引擎的统一读面保留四桶、分组计数、顺序与窗口', async () => {
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

    expect(await renderMetrics(harness)).toEqual(expected)
  })

  test('代码度量：一行都没有时返回空面板', async () => {
    const rendered = await renderMetrics(harness)
    const empty: CodeMetricsSummary = {
      windowMs: DEFAULT_METRICS_WINDOW_MS,
      adoption: [],
      runs: [],
    }
    expect(rendered).toEqual(empty)
  })
})
