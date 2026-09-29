// Real daemon/API/browser flow. The basic runtime emits no usage: missing values must stay unknown.
import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { ObservationOverview, ObservationTaskDetail } from '@agent-workflow/shared'
import { startDaemon, type DaemonHandle } from './harness'
import { ObservationPlatformNativeCaptureSchema } from '@agent-workflow/shared'
import nativeCapture from '../packages/shared/tests/fixtures/crewstation-native-capture-v2.json'

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
  await expect(page.getByRole('textbox', { name: /Workflow ID|Linked workflow ID/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /More filters/ })).toHaveCount(0)
  // Existing shared URLs retain their workflow scope, with a visible removable label.
  await page.goto(`${daemon.baseUrl}/observability?workflow=${workflow.id}`)
  await expect(page.getByText(`Linked workflow: ${workflow.id}`, { exact: true })).toBeVisible()
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
  await expect(page.getByRole('button', { name: /CSV|Export/ })).toHaveCount(0)
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

test('overview omits attention, labels every token column and aligns collection facts', async ({
  page,
}, testInfo) => {
  const { workflow } = await seedTask()
  // Read-only display fixture gives the chart nonzero and partial values; real
  // daemon task and drill-down coverage remain in the preceding journey.
  await page.route('**/api/observability/overview?*', async (route) => {
    const response = await route.fetch(),
      data = (await response.json()) as ObservationOverview
    await route.fulfill({
      response,
      json: {
        ...data,
        trend: data.trend.slice(0, 3).map((row, i) => ({
          ...row,
          metrics: {
            ...row.metrics,
            tokens: {
              ...row.metrics.tokens,
              hasKnown: i !== 2,
              totalKnown: ['1250', '2500', '0'][i],
              complete: i === 0,
            },
          },
        })),
      },
    })
  })
  await prime(page)
  await page.goto(`${daemon.baseUrl}/observability?workflow=${workflow.id}`)
  const chart = page.getByRole('list', { name: 'Task usage trend' })
  await expect(chart.locator('.observation-trend__value')).toHaveText(['1,250', '≥ 2,500', '—'])
  await expect(page.getByRole('region', { name: 'Tasks needing attention' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Task traces', exact: true }).click()
  const name = page.getByRole('button', { name: 'Observed parallel task', exact: true })
  await expect(name).toBeVisible()
  expect(
    await name.evaluate((element) => [
      getComputedStyle(element).borderTopWidth,
      getComputedStyle(element).backgroundColor,
    ]),
  ).toEqual(['0px', 'rgba(0, 0, 0, 0)'])
  await page.getByRole('tab', { name: 'Performance and data quality', exact: true }).click()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const facts = page.locator('.detail-grid--centered')
    await expect(facts).toHaveCount(2)
    for (const list of await facts.all()) {
      const differences = await list.evaluate((element) =>
        Array.from(element.querySelectorAll('dt')).map((title) => {
          const label = title.getBoundingClientRect(),
            value = title.nextElementSibling!.getBoundingClientRect()
          return Math.abs((label.top + label.bottom) / 2 - (value.top + value.bottom) / 2)
        }),
      )
      expect(differences.every((difference) => difference <= 1)).toBe(true)
    }
    await expectAnalysisSpacing(page)
    await page.screenshot({
      path: testInfo.outputPath(`collection-facts-${width}.png`),
      fullPage: true,
    })
  }
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

test('platform capture dialog keeps last-row focus and shared spacing at wide and narrow widths', async ({
  page,
}, testInfo) => {
  const { task } = await seedTask()
  const capture = ObservationPlatformNativeCaptureSchema.parse(nativeCapture.capture)
  // Read-only platform display fixture, not a claim of a live managed CS execution.
  await page.route('**/api/observability/tasks/' + task.id, async (route) => {
    const response = await route.fetch(),
      data = (await response.json()) as ObservationTaskDetail
    await route.fulfill({
      response,
      json: {
        ...data,
        platformCaptures: Array.from({ length: 30 }, (_, index) => ({
          invocationId: 'platform-invocation-' + index,
          nodeRunId: 'platform-attempt-' + index,
          sourceId: 'cs-fixture',
          schemaVersion: 2,
          capture: {
            ...capture,
            id: 'capture-' + index,
            proof: { ...capture.proof, turn: 'turn-' + index, turnIndex: index },
          },
          issues: [],
        })),
      },
    })
  })
  await prime(page)
  await page.goto(`${daemon.baseUrl}/observability?task=${task.id}`)
  const opener = page.getByRole('button', { name: 'View turn capture', exact: true }).last()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expectCardSpacing(page)
    // Mouse click intentionally has no preceding focus() (WebKit does not focus it).
    await opener.click()
    const dialog = page.getByRole('dialog', {
      name: 'CrewStation native turn capture',
      exact: true,
    })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('turn-29')
    await expect(dialog).toContainText('Corrected historical steps')
    const box = await dialog.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    await page.screenshot({
      path: testInfo.outputPath(`platform-capture-${width}.png`),
      fullPage: true,
    })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    await expect(page.getByRole('button', { name: /CSV|Export|More filters/ })).toHaveCount(0)
  }
})
