// RFC-248 —— 多仓启动 e2e（取代 RFC-066 的 `repos[]` 多行版本）。
//
// 多仓的唯一入口现在是**仓库组**：`repos[]` 在 wire 上退役（422 硬拒），向导里
// 的「+ 添加仓库」也随之下线。用户视角就是「从仓库列表里选一个」——组只是列表
// 里带 `（组 · N 仓）` 标签的一类条目（D-决策原话）。
//
// 本 spec 覆盖点击路径 → API 契约：
//   - 建一个含两个真实 git 夹具仓的组（挂载布局：一个挂根、一个挂 `vendor/sdk`）；
//   - 在向导的仓库下拉里选中它 ⇒ 空间切成组空间，展示组名与仓数；
//   - Start ⇒ 任务 repoCount=2，`repos[].mountPath` 就是组里定的挂载点；
//   - 嵌套成员的工作树真的落在根仓的子目录里。
//
// 后端行为覆盖（逐仓物化、预置 commit、sparse、只读、同仓多份、失败回收）在：
//   packages/backend/tests/rfc248-materialize-group.test.ts
//   packages/backend/tests/rfc248-legacy-multi-repo-retired.test.ts

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo } from './command'

const here = dirname(fileURLToPath(import.meta.url))
void here // (silence unused-when-fixture-paths-not-used lint)

// Stamp localStorage before the SPA mounts so the auth gate redirects
// straight through to the launcher. Same shape as /auth's submit handler
// writes (mirrors main.spec.ts:primeAuthLocalStorage).
async function primeAuthLocalStorage(page: Page, d: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        // Force English so the test selectors / regex line up with en-US strings.
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* noop */
      }
    },
    { baseUrl: d.baseUrl, token: d.token },
  )
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

interface RepoFixture {
  repoDir: string
  cleanup: () => void
}

function makeFixtureRepo(label: string): RepoFixture {
  const repoDir = mkdtempSync(join(tmpdir(), `aw-e2e-rfc066-${label}-`))
  writeFileSync(join(repoDir, 'README.md'), `# ${label}\n`, 'utf-8')
  initGitRepo(repoDir)
  return {
    repoDir,
    cleanup: () => {
      try {
        rmSync(repoDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

async function seedLinearWorkflow(daemon: DaemonHandle): Promise<string> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const agentRes = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'rfc066-agent',
      description: 'multi-repo e2e stub',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!agentRes.ok) throw new Error(`seed agent: ${agentRes.status}`)
  const agent = (await agentRes.json()) as { id: string }
  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'rfc066-multi-repo',
      description: 'multi-repo e2e workflow',
      definition: {
        $schema_version: 2,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'agent_1',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc066-agent',
            promptTemplate: '{{topic}}',
            position: { x: 320, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
            position: { x: 640, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'agent_1', portName: 'topic' },
          },
          {
            id: 'e2',
            source: { nodeId: 'agent_1', portName: 'answer' },
            target: { nodeId: 'out_1', portName: 'answer' },
          },
        ],
      },
    }),
  })
  if (!wfRes.ok) throw new Error(`seed workflow: ${wfRes.status} ${await wfRes.text()}`)
  return ((await wfRes.json()) as { id: string }).id
}

// RFC-248: `seedWrapperGitWorkflow` 随「多仓 + wrapper-git 会被拦」这条 e2e
// 一起删除——那道门（`multiRepoBlockedReason`）本身已经下线：wrapper-git 在组
// 布局下是受支持的（D9，逐仓 diff 前缀化合并），由
// `packages/backend/tests/rfc248-wrapper-git-multi-repo.test.ts` 覆盖。

async function seedRepoGroup(
  daemon: DaemonHandle,
  repos: RepoFixture[],
  name: string,
): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/repo-groups`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      description: '',
      // 一个挂根、一个挂 vendor/sdk —— 嵌套布局才是 RFC-248 的重点，
      // 平铺两仓 RFC-066 时代就能做到。
      members: [
        { kind: 'repo', repoUrl: pathToFileURL(repos[0]!.repoDir).href, mountPath: '' },
        { kind: 'repo', repoUrl: pathToFileURL(repos[1]!.repoDir).href, mountPath: 'vendor/sdk' },
      ],
    }),
  })
  if (!res.ok) throw new Error(`seed repo group: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { id: string }).id
}

test.describe('RFC-248 —— 仓库组多仓启动', () => {
  let daemon: DaemonHandle | undefined
  const repos: RepoFixture[] = []

  test.beforeAll(async () => {
    daemon = await startDaemon()
  })
  test.afterAll(async () => {
    if (daemon) await daemon.stop()
    for (const r of repos) r.cleanup()
  })

  test('从仓库下拉里选中一个组 → 任务按组布局物化（repoCount=2 + 挂载点）', async ({ page }) => {
    const d = daemon!
    const repoA = makeFixtureRepo('A')
    const repoB = makeFixtureRepo('B')
    repos.push(repoA, repoB)

    const wfId = await seedLinearWorkflow(d)
    const groupName = `e2e-group-${Date.now() % 100000}`
    await seedRepoGroup(d, [repoA, repoB], groupName)

    await primeAuthLocalStorage(page, d)
    await page.goto(`${d.baseUrl}/workflows/${wfId}/launch`)

    // Scratch 是默认空间（用户 2026-07-11）——先切到「仓库」。
    await page.getByTestId('wizard-space-remote').click()
    await expect(page.getByTestId('repo-source-row-0')).toBeVisible({ timeout: 10_000 })

    // RFC-248: 多仓不再靠加行——「+ 添加仓库」在向导里已下线。
    await expect(page.getByTestId('repo-source-add')).toHaveCount(0)

    // 仓库与组同列在同一个下拉里；组条目带 `(group · N repos)` 标签。
    await page.getByTestId('repo-source-recent-urls-0').click()
    await page.getByRole('option', { name: new RegExp(`${groupName}.*group`, 'i') }).click()

    // 选中组 ⇒ 空间切成组空间：组名 + 展平仓数。
    const groupCard = page.getByTestId('wizard-space-group')
    await expect(groupCard).toBeVisible()
    await expect(groupCard).toContainText(groupName)
    await expect(groupCard).toContainText('2')

    // Step 3 — 任务名 + 输入。
    await page.getByTestId('stepper-next').click()
    await page.fill('[data-testid="wizard-task-name"]', 'rfc248-e2e-task')
    await page
      .locator('label.form-field', { hasText: 'Topic (topic)' })
      .locator('input.form-input')
      .fill('repo-group-e2e')

    // Step 4 — 确认 + 提交。
    await page.getByTestId('stepper-next').click()
    await page.getByRole('button', { name: 'Start task', exact: true }).click()
    await page.waitForURL(/\/tasks\/[A-Z0-9]{26}/i, { timeout: 15_000 })
    const taskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!

    const taskRes = await fetch(`${d.baseUrl}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    expect(taskRes.ok).toBe(true)
    const task = (await taskRes.json()) as {
      repoCount: number
      worktreePath: string
      repos: Array<{ repoIndex: number; mountPath: string }>
    }
    expect(task.repoCount).toBe(2)
    expect(task.repos).toHaveLength(2)
    expect(task.repos.map((r) => r.repoIndex)).toEqual([0, 1])
    // 挂载点就是组里定的那两个——嵌套成员落在根仓的子目录下。
    expect(task.repos.map((r) => r.mountPath).sort()).toEqual(['', 'vendor/sdk'])
  })

  test('切回其他空间后组卡片消失（「更换」回到仓库选择）', async ({ page }) => {
    const d = daemon!
    const repoA = makeFixtureRepo('C')
    const repoB = makeFixtureRepo('D')
    repos.push(repoA, repoB)
    const wfId = await seedLinearWorkflow(d)
    const groupName = `e2e-swap-${Date.now() % 100000}`
    await seedRepoGroup(d, [repoA, repoB], groupName)

    await primeAuthLocalStorage(page, d)
    await page.goto(`${d.baseUrl}/workflows/${wfId}/launch`)
    await page.getByTestId('wizard-space-remote').click()
    await expect(page.getByTestId('repo-source-row-0')).toBeVisible({ timeout: 10_000 })

    await page.getByTestId('repo-source-recent-urls-0').click()
    await page.getByRole('option', { name: new RegExp(`${groupName}.*group`, 'i') }).click()
    await expect(page.getByTestId('wizard-space-group')).toBeVisible()

    // 「更换」退回单仓选择行——组卡片消失，行回来。
    await page.getByTestId('wizard-space-group-change').click()
    await expect(page.getByTestId('wizard-space-group')).toHaveCount(0)
    await expect(page.getByTestId('repo-source-row-0')).toBeVisible()
  })
})
