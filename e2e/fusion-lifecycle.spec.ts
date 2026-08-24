// RFC-319 B28/B29 —— 融合的完整生命周期：发起 → 审阅 → 批准 → 记忆转终态。
// INTENT-48 / INTENT-53 / INTENT-54 / MEM-50 / MEM-X1，五条 P1。
//
// 一次融合**改写一个托管技能的正文并递增它的版本**，而技能正文是往后每一次任务
// 都会读到的东西。这条链路的每一环失效都不会报错，只会安静地跑偏：
//
//   * 审阅面漏了「已跳过」那一栏 ⇒ 审批的人以为选中的记忆全被吸收了，实际有一条
//     被悄悄丢掉，而那条记忆在库里仍是 approved、看着一切正常；
//   * 批准之后版本没递增 ⇒ 技能被就地改写、没有可回滚的版本，改动无从追溯；
//   * 记忆没转 fused ⇒ 同一条知识既在技能正文里、又继续被注入进每一次任务的
//     prompt，两份内容此后各自演化，冲突时模型看到自相矛盾的上下文。
//
// 最后一条**必须端到端量**，不能只看行上的状态字段：判据是同一个探针任务在批准前后
// 各跑一次，比较它 node run 的 `injectedMemories` 快照（RFC-046 的落库列）——
// 被吸收的那条必须从注入里消失，而没被吸收的那条必须还在。只断言 `status==='fused'`
// 的话，一个「状态改了但注入查询没跟着改」的实现照样全绿。
//
// **这条 spec 建起来的过程中挖出并修掉了一个真实缺陷**（B29）：merger 节点跑在
// 逐节点隔离工作树里，产品契约要它把结果清单写进 `.agent-workflow/fusion/result.json`，
// 而平台自己的排除档把整个 `.agent-workflow/` 写进了工作树 git ignore，逐节点
// merge-back 又是 git 驱动的——清单永远回不到 `task.worktreePath`，于是**任何一次由
// 真实 agent 执行的融合都必然失败**。既有的 `fusion-engine.test.ts` 照不出它：那条
// 用例把清单直接写进 `task.worktreePath` 并把任务强制置 done，从不跨越隔离边界。
// 修法是把清单路径登记进 launch-frozen 的 force-include 名册（
// `services/fusion.ts` 两处 `startTask` + `taskPlatformInputPaths.ts` 的根白名单），
// 快判据在 `packages/backend/tests/rfc319-fusion-manifest-merge-back.test.ts`。
//
// 判据取自源码单一事实源：
//   services/fusion.ts:222-232   MERGER_PROMPT_TEMPLATE / 结果清单契约
//   services/fusion.ts:1411-1475 approveFusion：commitSkillVersion + fuseMemoriesTx
//   services/memoryInject.ts:206 全局 scope 的注入只取 status='approved'
//   routes/fusions.ts:161        POST /api/fusions/:id/approve

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let daemon: DaemonHandle
let skillId: string
let keptMemoryId: string
let skippedMemoryId: string
let fusionId: string
let workflowId: string
let repoDir: string
let probeSequence = 0

const SKILL_NAME = 'rfc319-fusion-skill'
const KEPT_TITLE = 'rfc319-fusion-kept'
const SKIPPED_TITLE = 'rfc319-fusion-skipped'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function seedMemory(title: string, bodyMd: string): Promise<string> {
  const created = await api<{ memory: { id: string } }>('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ scopeType: 'global', scopeId: null, title, bodyMd }),
  })
  // 手工建的记忆初始是 candidate；融合与注入都只吃 approved。
  await api(`/api/memories/${created.memory.id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
  })
  return created.memory.id
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'fusion' })
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-fusion-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 fusion fixture\n', 'utf-8')
  initGitRepo(repoDir)

  skillId = (
    await api<{ id: string }>('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name: SKILL_NAME,
        description: 'RFC-319 fusion lifecycle fixture',
        bodyMd: '# fixture\n\nOriginal skill body.\n',
      }),
    })
  ).id
  keptMemoryId = await seedMemory(KEPT_TITLE, 'Always use two spaces for indentation.')
  skippedMemoryId = await seedMemory(
    SKIPPED_TITLE,
    'SKIP-ME this memory is redundant with the skill body.',
  )

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-fusion-probe-agent',
      description: 'RFC-319 injection probe',
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '# probe\n',
    }),
  })
  workflowId = (
    await api<{ id: string }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-fusion-probe-workflow',
        description: 'RFC-319 injection probe',
        definition: {
          $schema_version: 3,
          inputs: [],
          nodes: [
            {
              id: 'probe',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'rfc319-fusion-probe-agent',
              promptTemplate: 'Answer briefly.',
            },
          ],
          edges: [],
        },
      }),
    })
  ).id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/** 跑一次探针任务，回传那次 agent run 注入了哪些记忆标题。 */
async function injectedTitles(): Promise<string[]> {
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-fusion-probe-${++probeSequence}`,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: {},
    }),
  })
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${task.id}`)).status, {
      timeout: 90_000,
    })
    .toBe('done')
  const nodeRuns = await api<{
    runs: Array<{ nodeId: string; injectedMemories?: Array<{ title: string }> | null }>
  }>(`/api/tasks/${task.id}/node-runs`)
  const probe = nodeRuns.runs.find((run) => run.nodeId === 'probe')
  expect(probe, '探针任务没有 agent node run ⇒ 下面的注入判据无从谈起').toBeTruthy()
  return (probe?.injectedMemories ?? []).map((memory) => memory.title).sort()
}

async function openApp(page: Page, path: string): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.goto(`${daemon.baseUrl}${path}`)
}

test('INTENT-48: 从技能详情页选记忆 + 写融合意图，落到这次融合自己的详情页', async ({ page }) => {
  // 前置量一次注入基线：两条记忆此刻都该被注入进任务 prompt。
  expect(
    await injectedTitles(),
    '融合前两条 approved 记忆都该进注入——没有这条基线，后面「被吸收的那条消失了」' +
      '可能只是「注入功能从来就没生效过」',
  ).toEqual([KEPT_TITLE, SKIPPED_TITLE].sort())

  await openApp(page, `/skills/${skillId}`)
  await page.getByRole('button', { name: 'Fuse memories', exact: true }).click()

  const picker = page.getByTestId('fusion-memory-picker')
  await expect(picker).toBeVisible()
  await picker.locator('li', { hasText: KEPT_TITLE }).getByRole('checkbox').check()
  await picker.locator('li', { hasText: SKIPPED_TITLE }).getByRole('checkbox').check()
  await page
    .getByTestId('fusion-intent')
    .fill('RFC-319 lifecycle: consolidate the lint preferences')
  await page.getByRole('button', { name: 'Start fusion', exact: true }).click()

  await page.waitForURL(/\/fusions\/[^/]+$/)
  fusionId = page.url().split('/').pop() ?? ''
  expect(fusionId).toBeTruthy()
  const launched = await api<{ skillId: string; memoryIds: string[] }>(`/api/fusions/${fusionId}`)
  expect(launched.skillId, '发起的融合指向的不是我打开的那个技能').toBe(skillId)
  expect([...launched.memoryIds].sort()).toEqual([keptMemoryId, skippedMemoryId].sort())
})

/**
 * 回答融合的强制反问。
 *
 * 反问不是这条 spec 要覆盖的能力（`e2e/clarify.spec.ts` 已经锁住它），但它是
 * **产品的硬契约**：merger 节点跑在强制 ask-back 模式下，第一轮直接出
 * `<workflow-output>` 会被以 `clarify-required-output-emitted` 当场判失败。
 * 所以这里必须真的答一轮，融合才能走到待审批——`directive: 'stop'` 是把节点
 * 从强制反问里放出来的那个开关。
 */
async function answerFusionClarify(): Promise<void> {
  const taskId = await pollFor(async () => {
    const row = await api<{ currentTaskId: string | null }>(`/api/fusions/${fusionId}`)
    return row.currentTaskId
  }, '融合没有关联任务')

  const session = await pollFor(async () => {
    const rows = await api<Array<{ intermediaryNodeRunId: string; iteration: number }>>(
      `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
    )
    return rows[0] ?? null
  }, '融合任务没有停在反问上')

  await api(`/api/clarify/${session.intermediaryNodeRunId}/answers`, {
    method: 'POST',
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-merge',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
      directive: 'stop',
      ifMatchIteration: session.iteration,
    }),
  })
}

/** 轮询到一个非空值，超时时用给定的话说明「等的是什么」。 */
async function pollFor<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  let last: T | null = null
  await expect
    .poll(
      async () => {
        last = await read()
        return last !== null
      },
      { timeout: 120_000 },
    )
    .toBe(true)
  expect(last, what).not.toBeNull()
  return last as T
}

test('INTENT-53: 待审批页把变更日志、已吸收与已跳过（含原因）三样都摆出来', async ({ page }) => {
  await answerFusionClarify()

  // 连 error 一起断言：融合失败时只报「期望 awaiting_approval、实得 failed」
  // 等于把真正的原因留在服务端，接手的人要从头复现一遍才能看到它。
  await expect
    .poll(
      async () => {
        const row = await api<{ status: string; error?: string | null }>(`/api/fusions/${fusionId}`)
        return row.status === 'awaiting_approval'
          ? 'awaiting_approval'
          : `${row.status}: ${row.error ?? '(no error recorded)'}`
      },
      { timeout: 120_000 },
    )
    .toBe('awaiting_approval')

  await openApp(page, `/fusions/${fusionId}`)
  await expect(page.getByRole('heading', { name: 'Changelog', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Incorporated memories (1)' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Skipped memories (1)' })).toBeVisible()
  await expect(page.getByText(KEPT_TITLE, { exact: false }).first()).toBeVisible()
  await expect(
    page.getByText('the e2e fixture marked this memory SKIP-ME', { exact: false }),
    '跳过必须带原因——只列出「被跳过」而不说为什么，审批的人无从判断该不该放行',
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Proposed change (current → proposed)' }),
    '没有提案 diff 就等于让人盲签',
  ).toBeVisible()
})

test('INTENT-54 / MEM-X1 / MEM-50: 批准后技能版本 +1，被吸收的记忆转 fused 且不再被注入', async ({
  page,
}) => {
  const before = await api<{ contentVersion: number }>(`/api/skills/${skillId}`)

  await openApp(page, `/fusions/${fusionId}`)
  await page.getByRole('button', { name: 'Approve & apply', exact: true }).click()

  await expect
    .poll(async () => (await api<{ status: string }>(`/api/fusions/${fusionId}`)).status, {
      timeout: 120_000,
    })
    .toBe('done')
  await expect(page.getByText(/Applied as v\d+/)).toBeVisible()

  const after = await api<{ contentVersion: number }>(`/api/skills/${skillId}`)
  expect(
    after.contentVersion,
    '批准之后技能版本没递增 ⇒ 正文被就地改写、没有可回滚的版本，改动无从追溯',
  ).toBe(before.contentVersion + 1)

  const memories = await api<{ items: Array<{ id: string; status: string }> }>('/api/memories')
  expect(memories.items.find((row) => row.id === keptMemoryId)?.status).toBe('fused')
  expect(
    memories.items.find((row) => row.id === skippedMemoryId)?.status,
    '没被吸收的记忆必须留在审批池里——把它一起转终态等于悄悄丢掉一条知识',
  ).toBe('approved')

  expect(
    await injectedTitles(),
    '被吸收的记忆仍在注入 ⇒ 同一条知识既在技能正文里又在每次 prompt 里，' +
      '两份内容此后各自演化，冲突时模型看到自相矛盾的上下文',
  ).toEqual([SKIPPED_TITLE])
})
