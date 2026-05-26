// RFC-066 PR-C — multi-repo launch e2e. Drives the /workflows/:id/launch UI
// with two real git fixture repos and asserts:
//   - default 1 row, `+ Add` visible, no `−` button.
//   - `+ Add` appends a second row; `−` buttons appear on both.
//   - Filling both rows + clicking Start produces a 2-repo task via
//     POST /api/tasks (v2 `repos: [...]` body shape).
//   - GET /api/tasks/:id returns repoCount=2 and a length-2 `repos` array.
//   - Multi-repo + wrapper-git workflow → banner visible + Start disabled
//     (scenario 2).
//
// Backend behavioural coverage (per-repo materialize, basename collision,
// failure paths) lives in:
//   packages/backend/tests/start-task-multi-repo-materialize.test.ts
//   packages/backend/tests/start-task-multi-repo-gates.test.ts
// This spec only exercises the click path → API contract.

import { test, expect, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'

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
  execSync('git init -b main -q', { cwd: repoDir })
  execSync('git config user.email e2e@example.com', { cwd: repoDir })
  execSync('git config user.name e2e', { cwd: repoDir })
  execSync('git add .', { cwd: repoDir })
  execSync('git commit -qm initial', { cwd: repoDir })
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
  await fetch(`${daemon.baseUrl}/api/agents`, {
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

async function seedWrapperGitWorkflow(daemon: DaemonHandle): Promise<string> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'rfc066-agent-wg',
      description: 'multi-repo gate e2e stub',
      outputs: ['answer'],
      readonly: false,
      bodyMd: '',
    }),
  })
  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'rfc066-wrapper-git',
      description: 'multi-repo wrapper-git gate e2e',
      definition: {
        $schema_version: 2,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'wg_1',
            kind: 'wrapper-git',
            title: 'wrap',
            nodeIds: ['agent_1'],
            position: { x: 200, y: 0 },
          },
          {
            id: 'agent_1',
            kind: 'agent-single',
            agentName: 'rfc066-agent-wg',
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
  if (!wfRes.ok) throw new Error(`seed wf: ${wfRes.status} ${await wfRes.text()}`)
  return ((await wfRes.json()) as { id: string }).id
}

test.describe('RFC-066 PR-C — multi-repo launch', () => {
  let daemon: DaemonHandle | undefined
  const repos: RepoFixture[] = []

  test.beforeAll(async () => {
    daemon = await startDaemon()
  })
  test.afterAll(async () => {
    if (daemon) await daemon.stop()
    for (const r of repos) r.cleanup()
  })

  test('happy path: 2 path-mode repos → task launched with repoCount=2', async ({ page }) => {
    const d = daemon!
    const repoA = makeFixtureRepo('A')
    const repoB = makeFixtureRepo('B')
    repos.push(repoA, repoB)

    // Pre-register the two repos via /api/repos/recent so the launcher
    // dropdown is populated. NOTE: recent_repos auto-fills row 0 only; the
    // user types row 1's path manually below.
    await fetch(`${d.baseUrl}/api/repos/recent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoA.repoDir }),
    })
    const wfId = await seedLinearWorkflow(d)

    await primeAuthLocalStorage(page, d)
    await page.goto(`${d.baseUrl}/workflows/${wfId}/launch`)

    // Default: 1 row, no `−` button.
    await expect(page.getByTestId('repo-source-row-0')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('repo-source-remove-0')).toHaveCount(0)

    // Fill task name.
    await page.fill('[data-testid="launch-task-name"]', 'rfc066-e2e-task')

    // Click `+ Add` → row 1 appears, both rows show `−`.
    await page.getByTestId('repo-source-add').click()
    await expect(page.getByTestId('repo-source-row-1')).toBeVisible()
    await expect(page.getByTestId('repo-source-remove-0')).toBeVisible()
    await expect(page.getByTestId('repo-source-remove-1')).toBeVisible()

    // Fill row 1 path manually (recent-repo auto-fill only seeds row 0).
    // The path TextInput sits as the second child of the row's Repo Field;
    // we target it by index.
    const row1 = page.getByTestId('repo-source-row-1')
    await row1.locator('input.form-input[placeholder*="paste"], input.form-input').first().fill(repoB.repoDir)
    await row1.locator('input.form-input').nth(1).fill('main')

    // Topic input.
    await page
      .locator('label.form-field', { hasText: 'Topic (topic)' })
      .locator('input.form-input')
      .fill('multi-repo-e2e')

    // Submit.
    await page.getByRole('button', { name: 'Start task', exact: true }).click()
    await page.waitForURL(/\/tasks\/[A-Z0-9]+/i, { timeout: 15_000 })
    const taskId = page.url().match(/\/tasks\/([A-Z0-9]+)/i)![1]!

    // Backend verifies the multi-repo shape.
    const taskRes = await fetch(`${d.baseUrl}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    expect(taskRes.ok).toBe(true)
    const task = (await taskRes.json()) as {
      repoCount: number
      repos: Array<{ repoIndex: number; worktreeDirName: string }>
    }
    expect(task.repoCount).toBe(2)
    expect(task.repos).toHaveLength(2)
    expect(task.repos.map((r) => r.repoIndex)).toEqual([0, 1])
    for (const r of task.repos) expect(r.worktreeDirName.length).toBeGreaterThan(0)
  })

  test('multi-repo + wrapper-git workflow → Start disabled + banner visible', async ({ page }) => {
    const d = daemon!
    const repoA = makeFixtureRepo('wg-A')
    const repoB = makeFixtureRepo('wg-B')
    repos.push(repoA, repoB)
    await fetch(`${d.baseUrl}/api/repos/recent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoA.repoDir }),
    })
    const wfId = await seedWrapperGitWorkflow(d)

    await primeAuthLocalStorage(page, d)
    await page.goto(`${d.baseUrl}/workflows/${wfId}/launch`)

    await expect(page.getByTestId('repo-source-row-0')).toBeVisible({ timeout: 10_000 })
    await page.fill('[data-testid="launch-task-name"]', 'rfc066-gate-task')

    // Add a second repo → banner should fire + Start disabled.
    await page.getByTestId('repo-source-add').click()
    await expect(page.getByTestId('repo-source-row-1')).toBeVisible()
    const row1 = page.getByTestId('repo-source-row-1')
    await row1.locator('input.form-input').first().fill(repoB.repoDir)
    await row1.locator('input.form-input').nth(1).fill('main')

    // Banner is visible.
    const banner = page.getByTestId('repo-source-multi-banner')
    await expect(banner).toBeVisible({ timeout: 5_000 })
    expect((await banner.textContent()) ?? '').toMatch(/wrapper-git/i)

    // Start button disabled.
    const startBtn = page.getByRole('button', { name: 'Start task', exact: true })
    await expect(startBtn).toBeDisabled()
  })
})
