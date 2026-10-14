// RFC-371 v2 (design/RFC-371-run-observability/redesign-v2-20261014.md): a real
// daemon run is recorded as one call per runtime process; the statistics page
// shows it without any projection or report build; the stub runtime reports no
// usage, so the call is "not reported" and never counted as zero cost; prices
// are saved per runtime × model and survive reopening the history.
import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type {
  ObservationOverview,
  ObservationPrice,
  ObservationPricingDirectory,
  ObservationTaskDetail,
  ObservationTaskPage,
} from '@agent-workflow/shared'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
test.setTimeout(120_000)
test.beforeAll(async () => {
  daemon = await startDaemon()
})
test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.ok, `${path}: ${response.status}`).toBe(true)
  return (await response.json()) as T
}

async function seedTask() {
  const fixtureId = randomUUID()
  const agent = await api<{ id: string; name: string }>('/api/agents', {
    name: `observation-${fixtureId}`,
    description: 'Observation browser fixture',
    outputs: ['answer'],
    readonly: true,
    bodyMd: '',
  })
  const workflow = await api<{ id: string }>('/api/workflows', {
    name: `observation-${fixtureId}`,
    description: 'One agent call',
    definition: {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'input', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'explain',
          kind: 'agent-single',
          agentId: agent.id,
          promptTemplate: 'Explain {{topic}}.',
          position: { x: 300, y: 0 },
        },
        {
          id: 'output',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'explain', portName: 'answer' } }],
          position: { x: 600, y: 0 },
        },
      ],
      edges: [
        {
          id: 'in',
          source: { nodeId: 'input', portName: 'topic' },
          target: { nodeId: 'explain', portName: 'topic' },
        },
        {
          id: 'out',
          source: { nodeId: 'explain', portName: 'answer' },
          target: { nodeId: 'output', portName: 'answer' },
        },
      ],
    },
  })
  const name = `Observed task ${fixtureId}`
  const task = await api<{ id: string }>('/api/tasks', {
    name,
    workflowId: workflow.id,
    scratch: true,
    inputs: { topic: 'observations' },
  })
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${task.id}`)).status, {
      timeout: 60_000,
      intervals: [250, 500, 1000],
    })
    .toBe('done')
  return { task, name, agent }
}

async function prime(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch()
    const config = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...config, language: 'en-US', theme } })
  })
}

const window = () => {
  const to = Date.now() + 60_000
  return new URLSearchParams({ from: String(to - 7 * 86_400_000), to: String(to), tzOffset: '0' })
}

test('a real run is one recorded call whose missing usage stays unknown', async () => {
  const { task, agent } = await seedTask()
  const detail = await api<ObservationTaskDetail>(`/api/observability/tasks/${task.id}`)
  expect(detail.task).toMatchObject({ id: task.id, status: 'done' })
  const calls = detail.calls.filter((call) => call.purpose === 'task')
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    nodeId: 'explain',
    attempt: 1,
    agentId: agent.id,
    status: 'done',
  })
  expect(calls[0]!.endedAt).not.toBeNull()
  // The stub runtime reports no usage: unreported, never a priced zero.
  if (calls[0]!.usageState === 'none') expect(calls[0]!.costState).toBe('none')
  const page = await api<ObservationTaskPage>(`/api/observability/tasks?${window()}`)
  expect(page.items.some((row) => row.taskId === task.id)).toBe(true)
  const overview = await api<ObservationOverview>(`/api/observability/overview?${window()}`)
  expect(overview.taskUsage.calls).toBeGreaterThanOrEqual(1)
  expect(overview.daily.length).toBeGreaterThanOrEqual(7)
  expect(overview.tasks.total).toBeGreaterThanOrEqual(1)
})

test('overview, task list and call detail work at desktop and phone widths in both themes', async ({
  page,
}) => {
  const { task, name } = await seedTask()
  for (const theme of ['light', 'dark'] as const) {
    await prime(page, theme)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`${daemon.baseUrl}/observability`)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.getByRole('heading', { name: 'Run observability', level: 1 })).toBeVisible()
      await expect(page.getByText('Tokens in range', { exact: true })).toBeVisible()
      await expect(page.getByRole('group', { name: 'Daily tokens' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)

      await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
      const open = page.getByRole('button', { name: `View ${name}`, exact: true })
      await expect(open).toBeVisible()
      await open.click()
      await expect(page).toHaveURL(new RegExp(`task=${task.id}`))
      await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
      const calls = page.getByRole('table', { name: 'Calls', exact: true })
      await expect(calls.getByText('explain · Attempt 1')).toBeVisible()
      await expect(page.getByText('Call swimlane', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
      await page.getByRole('button', { name: 'Back to tasks', exact: true }).click()
      await expect(open).toBeVisible()
    }
    await page.unrouteAll()
  }
})

test('a CNY price per runtime model is saved and survives reopening its history', async ({
  page,
}) => {
  const directory = await api<ObservationPricingDirectory>('/api/observability/pricing')
  const runtime = directory.runtimes.find((entry) => entry.protocol === 'opencode')
  expect(runtime).toBeDefined()
  if (!runtime) throw new Error('The real daemon did not register its OpenCode runtime')
  const model = `browser/fixture-${randomUUID().slice(0, 8)}`
  const note = 'RFC-371 v2 browser price ' + randomUUID()
  await prime(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=runtime`)
  const section = page.getByRole('region', { name: `Models of ${runtime.name}`, exact: true })
  await section.getByRole('button', { name: 'Price another model', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('Model (as the runtime reports it)', { exact: true }).fill(model)
  await editor.getByLabel('Input', { exact: true }).fill('1.25')
  await editor.getByLabel('Cache read', { exact: true }).fill('0')
  await editor.getByLabel('Output (includes reasoning)', { exact: true }).fill('4.5')
  await editor.getByLabel('Note (optional)', { exact: true }).fill(note)
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/observability/pricing/${encodeURIComponent(runtime.runtimeId)}` &&
      response.request().method() === 'POST',
  )
  await editor.getByRole('button', { name: 'Save price', exact: true }).click()
  const response = await saved
  expect(response.status()).toBe(201)
  const version = (await response.json()) as ObservationPrice
  expect(version).toMatchObject({
    runtimeId: runtime.runtimeId,
    model,
    rates: { input: '1.25', cacheRead: '0', cacheWrite: null, output: '4.5' },
    note,
  })
  await expect(editor).toHaveCount(0)
  for (const reload of [false, true]) {
    if (reload) await page.reload()
    const row = section.getByRole('row').filter({ hasText: model })
    await expect(row).toContainText('Input ¥1.25')
    const history = row.getByRole('button', { name: 'Price history', exact: true })
    await history.click()
    const dialog = page.getByRole('dialog')
    const priceRow = dialog.locator('tbody tr').filter({ hasText: note })
    await expect(priceRow).toHaveCount(1)
    await expect(priceRow.locator('td').nth(1)).toHaveText('¥1.25')
    await expect(priceRow.locator('td').nth(2)).toHaveText('¥0')
    await expect(priceRow.locator('td').nth(3)).toHaveText('Unpriced')
    await expect(priceRow.locator('td').nth(4)).toHaveText('¥4.5')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(history).toBeFocused()
  }
})
