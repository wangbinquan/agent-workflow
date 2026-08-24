// RFC-319 B28 —— 融合的发起：从技能详情页选记忆 + 写意图，落到这次融合自己的详情页。
// INTENT-48（P1）。
//
// **本批只到「发起」为止，原因写在明处**：为了覆盖后面三环（审阅 / 批准 / 记忆转
// 终态），这里给 e2e stub 加了一个能真正跑完融合的 `fusion` 模式——它按产品自己的
// 契约编辑技能文件并写下结果清单。用它跑真链路时暴露出一个**产品缺陷**：merger 节点
// 跑在隔离工作树里（`<home>/iso/<taskId>/<nodeRunId>`），而结果清单要写进
// `.agent-workflow/fusion/result.json`；该目录被平台自己的排除档写进了工作树的
// git ignore（`workspaceExcludeProfile.ts:28`），逐节点 merge-back 又是 git 驱动的，
// 于是清单永远回不到 `task.worktreePath`，`reconcileFusion` 每次都判
// `agent did not write the fusion result manifest`。实测证据：同一次运行里
// SKILL.md 的改动**merge 回来了**、同目录下的清单**没有**；`git check-ignore` 指向
// `.git/agent-workflow/excludes/v1:3:/.agent-workflow/`。
//
// 既有的 `packages/backend/tests/fusion-engine.test.ts` 照不出它：那条用例把清单
// **直接写进 task.worktreePath** 并把任务强制置为 done，从不跨越隔离边界——
// 正是本 RFC 要找的那种「缝隙上没有防护」。缺陷详情见 `docs/audit-backlog.md`。
//
// 因此 INTENT-53 / INTENT-54 / MEM-50 / MEM-X1 仍留在 gap，等缺陷处置定了再补。
//
// 判据取自源码单一事实源：
//   components/fusion/FuseDialog.tsx:198,227   记忆多选 + 意图
//   routes/fusions.ts:84                       POST /api/fusions
//   services/memoryInject.ts:143               注入只取 status='approved'

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
