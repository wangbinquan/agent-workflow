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

import { test, expect, type Page, type Route as PlaywrightRoute } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo, repoRemoteUrl } from './command'

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

// RFC-248: 名字必须**每次调用唯一**——这个 describe 是 serial 且共用一个
// daemon，两条测试各建一次；固定名字的第二次会撞 409（agent 名唯一）。
let seedSeq = 0

async function seedLinearWorkflow(daemon: DaemonHandle): Promise<string> {
  const suffix = `${(seedSeq += 1)}`
  const agentName = `rfc248-agent-${suffix}`
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const agentRes = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: agentName,
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
      name: `rfc248-multi-repo-${suffix}`,
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
            agentName,
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
      // RFC-249：root / 纯目录 / 仓库挂载都由同一棵显式树表达。
      nodes: [
        {
          path: '',
          attachment: { kind: 'repo', repoUrl: repoRemoteUrl(repos[0]!.repoDir) },
        },
        { path: 'vendor', attachment: null },
        {
          path: 'vendor/sdk',
          attachment: { kind: 'repo', repoUrl: repoRemoteUrl(repos[1]!.repoDir) },
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`seed repo group: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { id: string }).id
}

async function importCachedRepos(daemon: DaemonHandle, fixtures: readonly RepoFixture[]) {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const started = await fetch(`${daemon.baseUrl}/api/cached-repos/batch-import`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ urls: fixtures.map((fixture) => repoRemoteUrl(fixture.repoDir)) }),
  })
  if (!started.ok) throw new Error(`batch import: ${started.status} ${await started.text()}`)
  let snapshot = (await started.json()) as {
    batchId: string
    state: 'running' | 'completed'
    rows: Array<{ status: string; message: string | null }>
  }
  const deadline = Date.now() + 20_000
  while (snapshot.state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const response = await fetch(`${daemon.baseUrl}/api/cached-repos/imports/${snapshot.batchId}`, {
      headers,
    })
    if (!response.ok) throw new Error(`batch status: ${response.status}`)
    snapshot = (await response.json()) as typeof snapshot
  }
  if (snapshot.state !== 'completed' || snapshot.rows.some((row) => row.status !== 'done')) {
    throw new Error(`batch import did not finish successfully: ${JSON.stringify(snapshot.rows)}`)
  }
}

async function waitTaskTerminal(daemon: DaemonHandle, taskId: string): Promise<void> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const response = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    if (!response.ok) throw new Error(`task status: ${response.status}`)
    const task = (await response.json()) as { status: string }
    if (['done', 'failed', 'canceled'].includes(task.status)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`task ${taskId} did not reach a terminal state`)
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
    await expect(page.getByTestId('repo-source-url-0')).toHaveCount(0)
    await expect(page.getByTestId('repo-source-ref-0')).toHaveCount(0)

    // RFC-248: 多仓不再靠加行——「+ 添加仓库」在向导里已下线。
    await expect(page.getByTestId('repo-source-add')).toHaveCount(0)

    // 仓库与组同列在同一个下拉里；组条目带 `(group · N repos)` 标签。
    await page.getByTestId('repo-source-recent-urls-0').click()
    await page.getByRole('option', { name: new RegExp(`${groupName}.*group`, 'i') }).click()

    // 选中组后同一选择行保持挂载，只在行内展开目录布局。
    await expect(page.getByTestId('repo-source-row-0')).toBeVisible()
    await expect(page.getByTestId('repo-source-recent-urls-0')).toContainText(groupName)
    const groupCard = page.getByTestId('wizard-space-group')
    await expect(groupCard).toBeVisible()
    await expect(groupCard).toContainText('2')

    // Step 3 — 任务名 + 输入。
    await page.getByTestId('stepper-next').click()
    await page.fill('[data-testid="wizard-task-name"]', 'rfc248-e2e-task')
    await page
      .locator('label.form-field', { hasText: 'Topic' })
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

  test('在同一选择器里从仓库组切回仓库输入', async ({ page }) => {
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

    // 同一个下拉里选回占位项：布局收起，回到只有一个选择器的紧凑初始态。
    await page.getByTestId('repo-source-recent-urls-0').click()
    await page
      .getByRole('option', { name: '— select a repository or repo group —', exact: true })
      .click()
    await expect(page.getByTestId('wizard-space-group')).toHaveCount(0)
    await expect(page.getByTestId('repo-source-row-0')).toBeVisible()
    await expect(page.getByTestId('repo-source-url-0')).toHaveCount(0)
    await expect(page.getByTestId('repo-source-ref-0')).toHaveCount(0)

    // 只有明确选择手工 URL 入口，第二个输入框才按需展开；仓库有效后再显示分支。
    await page.getByTestId('repo-source-recent-urls-0').click()
    await page.getByRole('option', { name: 'Enter a new Git URL…', exact: true }).click()
    await expect(page.getByTestId('repo-source-url-0')).toBeVisible()
    await expect(page.getByTestId('repo-source-ref-0')).toHaveCount(0)
    await page.getByTestId('repo-source-url-0').fill(repoRemoteUrl(repoA.repoDir))
    await expect(page.getByTestId('repo-source-ref-0')).toBeVisible()
  })

  test('/repos tab 由 strict URL 驱动，并支持刷新与 Back/Forward', async ({ page }) => {
    const d = daemon!
    await primeAuthLocalStorage(page, d)
    await page.goto(`${d.baseUrl}/repos?q=sdk&tab=groups#inventory`)
    await expect(page.getByTestId('repos-tab-groups')).toHaveAttribute('aria-selected', 'true')

    await page.getByTestId('repos-tab-repos').click()
    await expect(page).toHaveURL(/\/repos\?q=sdk&tab=repos#inventory$/)
    await page.reload()
    await expect(page.getByTestId('repos-tab-repos')).toHaveAttribute('aria-selected', 'true')

    await page.getByTestId('repos-tab-groups').click()
    await expect(page).toHaveURL(/tab=groups/)
    await page.goBack()
    await expect(page.getByTestId('repos-tab-repos')).toHaveAttribute('aria-selected', 'true')
    await page.goForward()
    await expect(page.getByTestId('repos-tab-groups')).toHaveAttribute('aria-selected', 'true')

    await page.goto(`${d.baseUrl}/repos?q=sdk&tab=GROUPS#inventory`)
    await expect(page).toHaveURL(/\/repos\?q=sdk&tab=repos#inventory$/)
    await expect(page.getByTestId('repos-tab-repos')).toHaveAttribute('aria-selected', 'true')
  })

  test('仓库组编辑草稿覆盖 dismiss、Back、URL 草稿、保存 pending 与失败保留', async ({ page }) => {
    const d = daemon!
    const repoA = makeFixtureRepo('dirty-A')
    const repoB = makeFixtureRepo('dirty-B')
    repos.push(repoA, repoB)
    const groupName = `rfc249-dirty-${Date.now() % 100000}`
    const groupId = await seedRepoGroup(d, [repoA, repoB], groupName)

    await primeAuthLocalStorage(page, d)
    await page.goto(`${d.baseUrl}/repos?tab=repos`)
    await page.getByTestId('repos-tab-groups').click()
    await page.getByTestId(`repo-group-edit-${groupId}`).click()

    const editor = page.getByTestId('repo-group-editor-dialog')
    const nameInput = page.getByTestId('repo-group-name')
    await nameInput.fill(`${groupName}-draft`)

    // × / Esc / overlay all stay inside the editor until the user explicitly
    // discards. "Stay" must preserve the exact draft every time.
    for (const dismiss of [
      async () => editor.getByRole('button', { name: 'Close' }).click(),
      async () => page.keyboard.press('Escape'),
      async () => editor.dispatchEvent('mousedown'),
    ]) {
      await dismiss()
      await expect(page.getByRole('heading', { name: 'Unsaved changes' })).toBeVisible()
      await page.getByRole('button', { name: 'Stay on page' }).click()
      await expect(nameInput).toHaveValue(`${groupName}-draft`)
    }

    // Restore the material field, then prove the residual new-directory draft
    // alone blocks browser Back and disables Save.
    await nameInput.fill(groupName)
    const pendingDirectory = page.getByTestId('repo-group-new-directory')
    await pendingDirectory.fill('not-applied-yet')
    await expect(page.getByTestId('repo-group-save')).toBeDisabled()
    await expect(editor).toContainText('Finish or clear the pending edit before saving.')
    await page.evaluate(() => window.history.back())
    await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()
    await page.getByTestId('unsaved-stay').click()
    await expect(pendingDirectory).toHaveValue('not-applied-yet')
    await pendingDirectory.fill('')

    // An unblurred rename draft is guarded too. Escape first cancels that one
    // field instead of bubbling through and closing the whole editor.
    await page.getByTestId('repo-group-node-select-vendor').click()
    const directoryName = page.getByTestId('repo-group-directory-name')
    await directoryName.fill('vendor-escape')
    await directoryName.press('Escape')
    await expect(directoryName).toHaveValue('vendor')
    await expect(editor).toBeVisible()

    await directoryName.fill('vendor-draft')
    await page.evaluate(() => window.history.back())
    await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()
    await page.getByTestId('unsaved-stay').click()
    // Moving focus into the guard commits the valid rename draft via the
    // editor's normal blur path; importantly it is preserved, not discarded.
    await expect(directoryName).toHaveValue('vendor-draft')
    await directoryName.fill('vendor')
    await directoryName.press('Enter')
    await expect(page.getByTestId('repo-group-node-vendor')).toBeVisible()

    // Nested URL entry has its own discard boundary and also feeds the route
    // guard so Back cannot silently erase pasted lines.
    await page.getByTestId('repo-group-paste-urls').click()
    const urlDraft = page.getByTestId('repo-group-bulk-urls')
    await urlDraft.fill('https://git.example/acme/not-applied.git')
    await page.evaluate(() => window.history.back())
    await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()
    await page.getByTestId('unsaved-stay').click()
    await expect(urlDraft).toHaveValue('https://git.example/acme/not-applied.git')
    await page.getByTestId('repo-group-bulk-dialog').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('heading', { name: 'Unsaved changes' })).toBeVisible()
    await page.getByRole('button', { name: 'Discard changes' }).click()
    await expect(page.getByTestId('repo-group-bulk-dialog')).toBeHidden()

    // While PUT is in flight every dismiss path and every material control is
    // frozen. Let the real request continue afterwards so the success close is
    // still covered end to end.
    let releaseSave!: () => void
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const delayedSave = async (route: PlaywrightRoute) => {
      const requestUrl = new URL(route.request().url())
      if (
        route.request().method() === 'PUT' &&
        requestUrl.pathname === `/api/repo-groups/${groupId}`
      ) {
        await saveReleased
      }
      await route.continue()
    }
    await page.route('**/api/repo-groups/**', delayedSave)
    const savedName = `${groupName}-saved`
    await nameInput.fill(savedName)
    await expect(page.getByTestId('repo-group-save')).toBeEnabled()
    await page.getByTestId('repo-group-save').click()
    await expect(page.getByTestId('repo-group-cancel')).toBeDisabled()
    await expect(nameInput).toBeDisabled()
    await expect(editor.getByRole('button', { name: 'Close' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(editor).toBeVisible()
    releaseSave()
    await expect(editor).toBeHidden()
    await page.unroute('**/api/repo-groups/**', delayedSave)

    // A definitive failure unlocks the editor without replacing the draft.
    await page.getByTestId(`repo-group-edit-${groupId}`).click()
    await page.getByTestId('repo-group-name').fill(`${savedName}-failure-draft`)
    const failSave = async (route: PlaywrightRoute) => {
      const requestUrl = new URL(route.request().url())
      if (
        route.request().method() === 'PUT' &&
        requestUrl.pathname === `/api/repo-groups/${groupId}`
      ) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'test-save-failed', message: 'save failed on purpose' }),
        })
        return
      }
      await route.continue()
    }
    await page.route('**/api/repo-groups/**', failSave)
    await page.getByTestId('repo-group-save').click()
    await expect(editor).toContainText('save failed on purpose')
    await expect(page.getByTestId('repo-group-name')).toHaveValue(`${savedName}-failure-draft`)
    await expect(page.getByTestId('repo-group-cancel')).toBeEnabled()
    await page.getByTestId('repo-group-cancel').click()
    await page.getByRole('button', { name: 'Discard changes' }).click()
    await expect(editor).toBeHidden()
    await page.unroute('**/api/repo-groups/**', failSave)
  })

  test('UI 新建平铺组→整理层级→保存重开→启动→详情→sourceTask 重跑', async ({ page }) => {
    const d = daemon!
    const repoA = makeFixtureRepo('tree-A')
    const repoB = makeFixtureRepo('tree-B')
    repos.push(repoA, repoB)
    await importCachedRepos(d, [repoA, repoB])
    const wfId = await seedLinearWorkflow(d)
    const groupName = `rfc249-ui-${Date.now() % 100000}`
    const repoAName = basename(repoA.repoDir)
    const repoBName = basename(repoB.repoDir)

    await primeAuthLocalStorage(page, d)
    await page.goto(`${d.baseUrl}/repos?tab=groups`)
    await page.getByTestId('repo-groups-new').click()
    await page.getByTestId('repo-group-name').fill(groupName)

    await page.getByTestId('repo-group-bulk-repos').click()
    const search = page.getByTestId('repo-group-bulk-search')
    const repoList = page.getByTestId('repo-group-bulk-repo-list')
    await search.fill(repoAName)
    await repoList.locator('label', { hasText: repoAName }).click()
    await search.fill(repoBName)
    await repoList.locator('label', { hasText: repoBName }).click()
    await page.getByTestId('repo-group-bulk-submit').click()

    await page.getByTestId('repo-group-new-directory').fill('vendor')
    await page.getByTestId('repo-group-add-directory').click()
    await page.getByTestId(`repo-group-node-select-${repoBName}`).click()
    await page.getByTestId('repo-group-parent-directory').click()
    await page.getByRole('option', { name: 'vendor', exact: true }).click()
    await expect(page.getByTestId(`repo-group-node-vendor/${repoBName}`)).toBeVisible()

    await expect(page.getByTestId('repo-group-save')).toBeEnabled()
    await page.getByTestId('repo-group-save').click()
    const groupRow = page.getByRole('row', { name: new RegExp(groupName) })
    await expect(groupRow).toBeVisible()
    await groupRow.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByTestId(`repo-group-node-${repoAName}`)).toBeVisible()
    await expect(page.getByTestId(`repo-group-node-vendor/${repoBName}`)).toBeVisible()
    await page.getByTestId('repo-group-cancel').click()

    await page.goto(`${d.baseUrl}/workflows/${wfId}/launch`)
    await page.getByTestId('wizard-space-remote').click()
    await page.getByTestId('repo-source-recent-urls-0').click()
    await page.getByRole('option', { name: new RegExp(`${groupName}.*group`, 'i') }).click()
    await page.getByTestId('stepper-next').click()
    await page.getByTestId('wizard-task-name').fill('rfc249-full-chain')
    await page
      .locator('label.form-field', { hasText: 'Topic' })
      .locator('input.form-input')
      .fill('directory-tree')
    await page.getByTestId('stepper-next').click()
    await page.getByRole('button', { name: 'Start task', exact: true }).click()
    await page.waitForURL(/\/tasks\/[A-Z0-9]{26}/i)
    const firstTaskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!

    await page.locator('[data-task-detail-section-link="details"]').click()
    await page.getByTestId('task-detail-multi-repo').locator('summary').click()
    await expect(page.getByTestId(`task-detail-repo-layout-row-vendor/${repoBName}`)).toBeVisible()
    await waitTaskTerminal(d, firstTaskId)
    await page.reload()
    await page.getByTestId('task-detail-relaunch').click()
    await page.waitForURL(new RegExp(`/tasks/new\\?relaunchFrom=${firstTaskId}`))

    let sawReplaySpace = false
    for (let step = 0; step < 4; step += 1) {
      if (
        await page
          .getByTestId('wizard-space-replay')
          .isVisible()
          .catch(() => false)
      ) {
        sawReplaySpace = true
      }
      const start = page.getByRole('button', { name: 'Start task', exact: true })
      if (await start.isVisible().catch(() => false)) break
      const next = page.getByTestId('stepper-next')
      await expect(next).toBeEnabled()
      await next.click()
    }
    expect(sawReplaySpace).toBe(true)
    await page.getByRole('button', { name: 'Start task', exact: true }).click()
    await page.waitForURL(/\/tasks\/[A-Z0-9]{26}/i)
    const secondTaskId = page.url().match(/\/tasks\/([A-Z0-9]{26})/i)![1]!
    expect(secondTaskId).not.toBe(firstTaskId)

    const replayResponse = await fetch(`${d.baseUrl}/api/tasks/${secondTaskId}`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    expect(replayResponse.ok).toBe(true)
    const replay = (await replayResponse.json()) as {
      repos: Array<{ mountPath: string }>
      spaceNodes: Array<{ path: string }>
    }
    expect(replay.repos.map((item) => item.mountPath).sort()).toEqual([
      repoAName,
      `vendor/${repoBName}`,
    ])
    expect(replay.spaceNodes.map((item) => item.path)).toContain('vendor')
  })
})
