// RFC-372 production UI, original HTTP routes and real TaskEngine with native mock runtime.
import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let daemon: DaemonHandle
let repoDir: string
let stubState: string
let taskId: string
let nodeRunId: string
let roundIteration: number

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

interface ClarifyRow {
  intermediaryNodeRunId: string
  askingShardKey: string | null
  iteration: number
  status?: string
}

async function openClarify(page: Page, nodeRunId: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/clarify/${encodeURIComponent(nodeRunId)}`)
}

function seedAuth(page: Page): Promise<void> {
  return page.addInitScript(
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
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc372-mindmap-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 b62 fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc372-mindmap-state-'))
  daemon = await startDaemon({
    stubMode: 'clarify',
    extraEnv: { CLARIFY_STUB_STATE: stubState, CLARIFY_STUB_MINDMAP: '1' },
  })

  const agentName = 'rfc372-mindmap-designer'
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: agentName,
      description: 'RFC-319 B62 fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc372-mindmap-clarify',
      description: 'RFC-319 B62 clarify detail states',
      definition: {
        $schema_version: 7,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName,
            promptTemplate: 'Design for {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'clarify_1',
            kind: 'clarify',
            title: 'Clarify design',
            interactionMode: 'mindmap',
            mindmap: { categories: ['Architecture'], instructions: '' },
            position: { x: 560, y: 160 },
          },
        ],
        edges: [
          {
            id: 'e_in_designer',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'designer', portName: 'topic' },
          },
          {
            id: 'e_clarify_ask',
            source: { nodeId: 'designer', portName: '__clarify__' },
            target: { nodeId: 'clarify_1', portName: 'questions' },
          },
          {
            id: 'e_clarify_ans',
            source: { nodeId: 'clarify_1', portName: 'answers' },
            target: { nodeId: 'designer', portName: '__clarify_response__' },
          },
        ],
      },
    }),
  })
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc372-mindmap-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  let row: ClarifyRow | undefined
  await expect
    .poll(
      async () => {
        const rows = await api<ClarifyRow[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        )
        row = rows[0]
        return row !== undefined
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  nodeRunId = row!.intermediaryNodeRunId
  roundIteration = row!.iteration
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('one workspace: classify, follow up, refresh, confirm and submit through the original route', async ({
  page,
}, testInfo) => {
  await seedAuth(page)
  await openClarify(page, nodeRunId)
  const workspace = page.getByRole('region', { name: 'Clarify workspace' })
  await expect(workspace).toBeVisible()
  await page.getByRole('treeitem', { name: /Which database should we use/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Open in focused answers' }).click()
  await page.getByLabel('Postgres', { exact: false }).first().check()
  await page.getByRole('button', { name: 'Confirm this answer', exact: true }).click()
  await page.getByRole('button', { name: 'Deepen this question', exact: true }).click()
  await page.getByRole('button', { name: 'Ask follow-up', exact: true }).click()
  await expect(page.getByRole('treeitem', { name: /Which consistency guarantee/ })).toBeVisible({
    timeout: 180_000,
  })
  const fresh = await api<{
    questions: { id: string; title: string; mindmap: { parentQuestionId?: string } }[]
    iteration: number
  }>(`/api/clarify/${nodeRunId}`)
  expect(fresh.iteration).toBe(roundIteration)
  expect(fresh.questions).toHaveLength(3)
  expect(fresh.questions[2]!.mindmap.parentQuestionId).toBe('q-db')
  await page.reload()
  await page.getByRole('treeitem', { name: /Which database should we use/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Open in focused answers' }).click()
  await expect(page.getByRole('button', { name: 'Confirmed', exact: true })).toBeDisabled()
  await page
    .getByRole('radiogroup', { name: 'View', exact: true })
    .getByRole('radio', { name: 'Focused answers' })
    .click()
  await expect(page.getByRole('button', { name: 'Confirmed', exact: true })).toBeDisabled()
  await page
    .getByRole('radiogroup', { name: 'View', exact: true })
    .getByRole('radio', { name: 'Panorama' })
    .click()
  const surface = page.getByRole('img', { name: 'Clarification mindmap' })
  await surface.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('0')
  const zoom = page.getByLabel('Zoom level')
  // The worker layout must have fitted the graph before capturing a baseline.
  // A placeholder captured here would misattribute initialization to dblclick.
  await expect(zoom).toHaveText(/^\d+(?:\.\d+)?%$/)
  const oldZoom = await zoom.textContent()
  await surface.dblclick({ position: { x: 50, y: 90 } })
  await expect(zoom).toHaveText(oldZoom!)
  // The harness explicitly uses light mode. Exercise the real config contract
  // rather than changing the OS preference underneath that explicit choice.
  await api('/api/config', { method: 'PUT', body: JSON.stringify({ theme: 'dark' }) })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: testInfo.outputPath('mindmap-dark.png'), fullPage: true })
  await api('/api/config', { method: 'PUT', body: JSON.stringify({ theme: 'light' }) })
  await page.reload()
  await expect(workspace).toBeVisible()
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    if (width < 700)
      await page
        .getByRole('radiogroup', { name: 'Clarify workspace', exact: true })
        .getByRole('radio', { name: 'Panorama', exact: true })
        .click()
    expect(await workspace.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`mindmap-${width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page
    .getByRole('radiogroup', { name: 'View', exact: true })
    .getByRole('radio', { name: 'Focused answers' })
    .click()
  for (const [title, option] of [
    ['Pick languages', 'TypeScript'],
    ['Which consistency guarantee?', 'Strong'],
  ]) {
    await page
      .getByRole('treeitem', { name: new RegExp(title!.replace('?', '\\?')) })
      .first()
      .click()
    await page.getByLabel(option!, { exact: false }).first().check()
    await page.getByRole('button', { name: 'Confirm this answer', exact: true }).click()
  }
  await expect(page.getByText('This round is reviewed and ready to submit.')).toBeVisible()
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith(`/api/clarify/${nodeRunId}/answers`),
  )
  await page.getByTestId('clarify-submit-stop').click()
  await page.getByTestId('clarify-stop-confirm').click()
  expect((await submitted).postDataJSON().questionSetKey).toMatch(/^v2:/)
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 180_000,
    })
    .toBe('done')
})

test('large projection keeps the canvas and virtual outline bounded at depth 100 and 300 siblings', async ({
  page,
}, testInfo) => {
  await seedAuth(page)
  const source = await api<Record<string, unknown>>(`/api/clarify/${nodeRunId}`)
  const questions = Array.from({ length: 5000 }, (_, i) => ({
    id: `load-${i}`,
    title: `${i >= 400 && i < 700 ? 'Parent' : 'Load'} question ${i}`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
    mindmap: {
      categoryPath: ['Large tree'],
      ...(i > 0 && i < 100
        ? { parentQuestionId: `load-${i - 1}` }
        : i >= 100 && i < 400
          ? { parentQuestionId: 'load-0' }
          : i >= 700 && i < 1000
            ? { parentQuestionId: `load-${i - 300}` }
            : {}),
    },
  }))
  // Scale fixture affects only the response payload; UI layout/Worker/events are production code.
  await page.route(`**/api/clarify/${nodeRunId}`, (route) =>
    route.fulfill({ json: { ...source, questions } }),
  )
  await openClarify(page, nodeRunId)
  const workspace = page.getByRole('region', { name: 'Clarify workspace' })
  await expect(page.getByRole('img', { name: 'Clarification mindmap' })).toBeVisible()
  expect(await workspace.getByRole('treeitem').count()).toBeLessThan(60)
  await page
    .getByRole('radiogroup', { name: 'View', exact: true })
    .getByRole('radio', { name: 'Focused answers' })
    .click()
  await page
    .getByRole('textbox', { name: 'Search categories or questions' })
    .fill('Load question 4999')
  await page.getByRole('option', { name: /Load question 4999/ }).click()
  await expect(
    workspace.getByRole('heading', { name: 'Load question 4999', exact: true }),
  ).toBeVisible()
  const search = page.getByRole('textbox', { name: 'Search categories or questions' })
  // A query change may leave the selected result at the same distant index.
  // The actual Tab stop must still be mounted after the virtual list resets.
  await search.fill('Load')
  await search.press('Tab')
  await expect(page.getByRole('option', { name: /Load question 4999/ })).toBeFocused()
  await search.fill('Load question 999')
  await page.getByRole('option', { name: /Load question 999/ }).click()
  await search.fill('Parent question')
  await search.press('Tab')
  await expect(page.getByRole('option', { name: /Parent question 400/ })).toBeFocused()
  await expect(
    workspace.getByRole('heading', { name: 'Load question 999', exact: true }),
  ).toBeVisible()
  expect(await workspace.getByRole('option').count()).toBeLessThan(60)
  await page.screenshot({ path: testInfo.outputPath('mindmap-5000.png'), fullPage: true })
  await page.unrouteAll({ behavior: 'wait' })
})
