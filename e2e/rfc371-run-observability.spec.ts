// Real daemon/API/browser flow. The basic runtime emits no usage: missing values must stay unknown.
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ObservationOverview, ObservationTaskDetail } from '@agent-workflow/shared'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
test.setTimeout(120_000)
test.beforeAll(async () => {
  daemon = await startDaemon()
})
test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.ok, `${path}: ${response.status}`).toBe(true)
  return (await response.json()) as T
}

async function seedTask() {
  const fixtureId = randomUUID()
  const agents = await Promise.all(
    ['left', 'right'].map((side) =>
      api<{ id: string }>('/api/agents', {
        name: `observation-${side}-${fixtureId}`,
        description: 'Observation browser fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    ),
  )
  const workflow = await api<{ id: string }>('/api/workflows', {
    name: `observation-parallel-${fixtureId}`,
    description: 'Two parallel agents with separate attempts',
    definition: {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'input', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        ...agents.map((agent, i) => ({
          id: `agent_${i}`,
          kind: 'agent-single',
          agentId: agent.id,
          promptTemplate: 'Explain {{topic}}.',
          position: { x: 300, y: i * 200 },
        })),
        {
          id: 'output',
          kind: 'output',
          ports: agents.map((_, i) => ({
            name: `answer_${i}`,
            bind: { nodeId: `agent_${i}`, portName: 'answer' },
          })),
          position: { x: 600, y: 0 },
        },
      ],
      edges: agents.flatMap((_, i) => [
        {
          id: `input_${i}`,
          source: { nodeId: 'input', portName: 'topic' },
          target: { nodeId: `agent_${i}`, portName: 'topic' },
        },
        {
          id: `output_${i}`,
          source: { nodeId: `agent_${i}`, portName: 'answer' },
          target: { nodeId: 'output', portName: `answer_${i}` },
        },
      ]),
    },
  })
  const task = await api<{ id: string }>('/api/tasks', {
    name: 'Observed parallel task',
    workflowId: workflow.id,
    scratch: true,
    inputs: { topic: 'parallel observations' },
  })
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${task.id}`)).status, {
      timeout: 60_000,
      intervals: [250, 500, 1000],
    })
    .toBe('done')
  return { task, agents, workflow }
}

async function prime(page: Page) {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function expectCardSpacing(page: Page) {
  const cards = await page.locator('.page .card').all()
  expect(cards.length).toBeGreaterThanOrEqual(3)
  const expectedGap = await page
    .locator('html')
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).getPropertyValue('--space-4')))
  for (let i = 1; i < cards.length; i++) {
    const before = await cards[i - 1]!.boundingBox(),
      after = await cards[i]!.boundingBox()
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(after!.y - before!.y - before!.height).toBeCloseTo(expectedGap, 0)
  }
  const width = await page.locator('.page').evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1)
}

async function expectAnalysisSpacing(page: Page) {
  const geometry = await page.getByRole('tabpanel').evaluate((panel) => {
    const gap = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--space-4'),
    )
    const blocks = Array.from(panel.querySelector('.stack--md')!.children).map((el) =>
      el.getBoundingClientRect(),
    )
    const grids = Array.from(
      panel.querySelectorAll('.observation-summary, .observation-columns'),
    ).map((grid) => ({
      gap: Number.parseFloat(getComputedStyle(grid).gap),
      cards: Array.from(grid.children).map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }
      }),
    }))
    return {
      gap,
      gaps: blocks.slice(1).map((b, i) => b.y - blocks[i]!.bottom),
      grids,
      overflow: document.documentElement.scrollWidth - innerWidth,
      width: innerWidth,
    }
  })
  for (const gap of geometry.gaps) expect(gap).toBeCloseTo(geometry.gap, 0)
  for (const grid of geometry.grids) {
    expect(grid.gap).toBe(geometry.gap)
    for (const [i, card] of grid.cards.entries()) {
      expect(card.x).toBeGreaterThanOrEqual(0)
      expect(card.right).toBeLessThanOrEqual(geometry.width)
      const previous = grid.cards[i - 1]
      if (previous && Math.abs(previous.y - card.y) < 1)
        expect(card.x - previous.right).toBeCloseTo(geometry.gap, 0)
      else if (previous && Math.abs(previous.x - card.x) < 1)
        expect(card.y - previous.bottom).toBeCloseTo(geometry.gap, 0)
    }
  }
  expect(geometry.overflow).toBeLessThanOrEqual(1)
}

test('task, agents and attempt drill-down use real observations and standard card spacing', async ({
  page,
}, testInfo) => {
  const { task, agents, workflow } = await seedTask()
  const detail = await api<ObservationTaskDetail>(`/api/observability/tasks/${task.id}`)
  expect(detail.metrics.invocations).toBe(2)
  expect(detail.agents.map((agent) => agent.agentId).sort()).toEqual(agents.map((a) => a.id).sort())
  expect(detail.attempts.filter((attempt) => attempt.metrics.invocations > 0)).toHaveLength(2)
  expect(detail.metrics.tokens.hasKnown).toBe(false)
  expect(detail.metrics.cost.knownAmount).toBeNull()
  expect(detail.metrics.cost.currency).toBe('CNY')
  await prime(page)
  await page.goto(`${daemon.baseUrl}/observability`)
  await expect(page.getByRole('heading', { name: 'Run observability', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Task usage trend', exact: true })).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Task name or ID', exact: true })
    .fill('Observed parallel task')
  await page.getByRole('textbox', { name: 'Workflow ID', exact: true }).fill(workflow.id)
  await expect(page).toHaveURL(new RegExp(`workflow=${workflow.id}`))
  await expect(page.getByRole('heading', { name: 'Task usage trend', exact: true })).toBeVisible()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expectAnalysisSpacing(page)
    const chart = page.getByRole('list', { name: 'Task usage trend' })
    const tracks = await chart.locator('.observation-trend__track').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect()
        return { x: box.x, y: box.y, height: box.height }
      }),
    )
    expect(tracks.length).toBeGreaterThan(1)
    for (const [i, track] of tracks.entries()) {
      expect(track.height).toBe(176)
      expect(track.y).toBeCloseTo(tracks[0]!.y, 0)
      if (i > 0) expect(track.x).toBeGreaterThan(tracks[i - 1]!.x)
    }
    const last = chart.getByRole('button').last()
    await chart.getByRole('button').first().focus()
    for (let index = 1; index < tracks.length; index++) await page.keyboard.press('Tab')
    await expect(last).toBeFocused()
    const visible = await last.boundingBox()
    expect(visible!.x).toBeGreaterThanOrEqual(0)
    expect(visible!.x + visible!.width).toBeLessThanOrEqual(width)
    await page.screenshot({
      path: testInfo.outputPath(`trend-columns-${width}.png`),
      fullPage: true,
    })
  }
  const observedBucket = page
    .getByRole('list', { name: 'Task usage trend' })
    .getByRole('button', { name: /1 tasks.*Not observed Token/ })
  await observedBucket.focus()
  await expect(page.getByRole('group', { name: 'Current trend interval' })).toContainText(
    'Not observed',
  )
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: 'Task traces', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page).toHaveURL(/period=custom/)
  await expect(
    page.getByRole('button', { name: 'Observed parallel task', exact: true }),
  ).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 844 })
  await page.getByRole('tab', { name: 'Agent analysis', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Agents across tasks', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: new RegExp(agents[0]!.id) }).click()
  await expect(
    page.getByRole('heading', { name: 'Agent contributions by task', exact: true }),
  ).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export snapshot CSV', exact: true }).click(),
  ])
  expect(await download.failure()).toBeNull()
  expect(download.suggestedFilename()).toMatch(/^aw-observations-agents-\d+-\d+\.csv$/)
  const csvPath = await download.path()
  expect(csvPath).not.toBeNull()
  const csv = await readFile(csvPath!, 'utf8')
  expect(csv).toContain('"agent_revision"')
  expect(csv).toContain('"CNY"')
  expect(csv).toContain(agents[0]!.id)
  expect(csv).not.toContain(agents[1]!.id)
  expect(csv).toContain(task.id)
  expect(csv).toContain('"workflow_filter"')
  expect(csv).toContain(workflow.id)
  expect(csv).toContain('Observed parallel task')
  await page.getByRole('button', { name: 'Observed parallel task', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Task total', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to analysis', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Agent contributions by task', exact: true }),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Tokens and cost', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Usage by actual model', exact: true }),
  ).toBeVisible()
  await expectAnalysisSpacing(page)
  await page.getByRole('tab', { name: 'Performance and data quality', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Task wall time P50', exact: true })).toBeVisible()
  await expectAnalysisSpacing(page)
  await page.getByRole('tab', { name: 'Task traces', exact: true }).click()
  await page.getByRole('button', { name: 'Observed parallel task', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Task total', exact: true })).toBeVisible()
  await expectCardSpacing(page)
  const attempt = page.getByRole('button', { name: /^Show attempt statistics · agent_0 ·/ })
  await attempt.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: /^Attempt / })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('CNY valuation')
  await expect(dialog).toContainText('Not observed')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(attempt).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await expectCardSpacing(page)
  await attempt.click()
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: testInfo.outputPath('attempt-390.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Back to task usage', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Observed parallel task', exact: true }),
  ).toBeVisible()
})

test('attention preview is bounded, explains causes and opens the canonical task page by keyboard', async ({
  page,
}, testInfo) => {
  const { task } = await seedTask()
  // Read-only display fixture: business state remains unchanged. The selected row
  // uses a real task ID so the handling link also exercises the canonical route.
  await page.route('**/api/observability/overview?*', async (route) => {
    const response = await route.fetch()
    const data = (await response.json()) as ObservationOverview
    const observed = data.tasks.find((row) => row.task.id === task.id)!
    const statuses = [
      'failed',
      'interrupted',
      'awaiting_review',
      'failed',
      'failed',
      'failed',
      'awaiting_human',
      'failed',
      'awaiting_human',
    ]
    await route.fulfill({
      response,
      json: {
        ...data,
        tasks: statuses.map((status, i) => ({
          ...observed,
          task: {
            ...observed.task,
            id: i === 8 ? task.id : `attention-fixture-${i}`,
            name: `Attention ${i}: ${'A long but readable task name '.repeat(8)}`,
            status,
            startedAt: observed.task.startedAt + i,
            errorSummary: status === 'failed' ? 'Result persistence failed: '.repeat(30) : null,
          },
        })),
      },
    })
  })
  await prime(page)
  await page.goto(`${daemon.baseUrl}/observability`)
  const card = page.getByRole('region', { name: 'Tasks needing attention' })
  const list = card.getByRole('list')
  await expect(list.getByRole('listitem')).toHaveCount(5)
  await expect(list.getByRole('link').first()).toContainText('Waiting for more information')
  await expect(list.getByRole('link').nth(2)).toContainText('human review')
  await expect(list.getByRole('link').nth(3)).toContainText('Result persistence failed')
  await expect(card).toContainText('9 in the loaded scope; showing 5')
  const all = card.getByRole('link', { name: 'View all in task center' })
  const destination = new URL((await all.getAttribute('href'))!, daemon.baseUrl)
  expect(destination.searchParams.get('statuses')!.split(',').sort()).toEqual([
    'awaiting_human',
    'awaiting_review',
    'failed',
    'interrupted',
  ])
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expectAnalysisSpacing(page)
    const geometry = await list.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return {
        width: box.width,
        height: box.height,
        overflow: element.scrollWidth - element.clientWidth,
        rows: Array.from(element.querySelectorAll('a')).map((row) => {
          const rect = row.getBoundingClientRect()
          return { left: rect.left, right: rect.right }
        }),
      }
    })
    expect(geometry.overflow).toBeLessThanOrEqual(1)
    expect(geometry.height).toBeLessThan(width === 390 ? 900 : 620)
    for (const row of geometry.rows) {
      expect(row.left).toBeGreaterThanOrEqual(0)
      expect(row.right).toBeLessThanOrEqual(width)
    }
    const last = list.getByRole('link').last()
    // Start from the header on each viewport: focusing an already-focused row
    // after screenshot scrolling does not trigger browser focus scrolling again.
    await all.focus()
    for (let index = 0; index < 5; index++) await page.keyboard.press('Tab')
    await expect(last).toBeFocused()
    await expect(last).toBeInViewport()
    await card.screenshot({ path: testInfo.outputPath(`attention-summary-${width}.png`) })
  }
  await list.getByRole('link').first().focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}`))
  await expect(
    page.getByRole('heading', { name: 'Observed parallel task', exact: true }),
  ).toBeVisible()
})

test('runtime configuration and CNY price cards retain the shared section gap', async ({
  page,
}) => {
  await prime(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=runtime`)
  const runtime = page.locator('.runtime-status-anchor > .settings-card')
  const pricing = page.locator('#token-cost > .settings-card')
  await expect(runtime).toBeVisible()
  await expect(pricing).toBeVisible()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const before = await runtime.boundingBox(),
      after = await pricing.boundingBox()
    const expectedGap = await page
      .locator('html')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).getPropertyValue('--space-4')))
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(after!.y - before!.y - before!.height).toBeCloseTo(expectedGap, 0)
  }
})
