// Real daemon/API/browser flow. The basic runtime emits no usage: missing values must stay unknown.
import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  ObservationMetrics,
  ObservationOverview,
  ObservationTaskDetail,
  ObservationPriceHistory,
  ObservationPriceVersion,
  ObservationPricingRuntime,
} from '@agent-workflow/shared'
import { startDaemon, type DaemonHandle } from './harness'
import { ObservationPlatformNativeCaptureSchema } from '../packages/shared/src/schemas/observationPlatform'

const nativeCapture = JSON.parse(
  readFileSync(
    new URL(
      '../packages/shared/tests/fixtures/crewstation-native-capture-v2.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { capture: unknown }

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
  browserName,
}, testInfo) => {
  const { task, agents, workflow } = await seedTask()
  const detail = await api<ObservationTaskDetail>(`/api/observability/tasks/${task.id}`)
  expect(detail.metrics.invocations).toBe(2)
  expect(detail.agents.map((agent) => agent.agentId).sort()).toEqual(agents.map((a) => a.id).sort())
  expect(detail.attempts.filter((attempt) => attempt.metrics.invocations > 0)).toHaveLength(2)
  expect(detail.metrics.tokens.hasKnown).toBe(false)
  expect(detail.metrics.cost.knownAmount).toBeNull()
  expect(detail.metrics.cost.currency).toBe('CNY')
  const directory = await api<{ runtimes: ObservationPricingRuntime[] }>(
    '/api/observability/pricing/runtimes',
  )
  for (const runtime of detail.runtimes.filter(
    (row) => row.authority === 'local' && row.registrationId !== null,
  )) {
    const original = directory.runtimes.find((row) => row.registrationId === runtime.registrationId)
    expect(original).toBeDefined()
    expect(runtime.acceptedNames).toEqual([original!.name])
    expect(runtime.unnamedInvocations).toBe(0)
  }
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
    // Like the shared UX keyboard journey, macOS Safari uses Option+Tab to
    // traverse buttons in its default text-field-only Tab mode. Keep real
    // keyboard traversal and every focus/geometry assertion on both runners.
    const nextControl =
      process.platform === 'darwin' && browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
    for (let index = 1; index < tracks.length; index++) {
      await page.keyboard.press(nextControl)
      await expect(chart.getByRole('button').nth(index)).toBeFocused()
    }
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

function displayRuntimeMetrics(
  base: ObservationMetrics,
  total: string,
  amount: string,
  calls = 1,
): ObservationMetrics {
  return {
    ...base,
    invocations: calls,
    observedInvocations: calls,
    records: calls,
    tokens: {
      known: { input: total, cacheRead: '0', cacheWrite: '0', output: '0' },
      totalKnown: total,
      hasKnown: true,
      complete: true,
      unknownBuckets: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
    cost: {
      currency: 'CNY',
      knownAmount: amount,
      complete: true,
      pricedRecords: calls,
      priceVersionIds: ['display-frozen-CNY'],
      reasons: [],
    },
    authorities: ['local'],
    truncated: false,
  }
}

test('runtime last-row contributions preserve Dialog, URL, scroll and focus across task detail in both languages and themes', async ({
  page,
  browserName,
}, testInfo) => {
  const { task, workflow } = await seedTask()
  let language: 'zh-CN' | 'en-US' = 'en-US',
    theme: 'light' | 'dark' = 'light'
  // Numeric/long-list read-only display fixture around an actual daemon task.
  // Frozen-name persistence and authorization are verified by the real API and provider tests.
  await page.route('**/api/config', async (route) => {
    expect(route.request().method()).toBe('GET')
    const response = await route.fetch(),
      config = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...config, language, theme } })
  })
  await page.route('**/api/observability/overview?*', async (route) => {
    const response = await route.fetch(),
      data = (await response.json()) as ObservationOverview
    const contribution = displayRuntimeMetrics(data.metrics, '100', '1.25')
    const whole = displayRuntimeMetrics(data.metrics, '470100', '95.25', 48)
    const tasks = Array.from({ length: 48 }, (_, i) => ({
      task: {
        ...data.tasks.find((row) => row.task.id === task.id)!.task,
        id: i === 47 ? task.id : 'display-task-' + i,
        name: i === 47 ? 'Observed parallel task' : 'Runtime display task ' + i,
      },
      metrics: i === 47 ? whole : contribution,
      wallMs: 10000,
      runningMs: 5000,
    }))
    const runtimes: ObservationOverview['runtimes'] = [
      ...Array.from({ length: 47 }, (_, i) => ({
        authority: 'local' as const,
        sourceId: null,
        registrationId: 'display-runtime-' + i,
        configurationRevision: i,
        protocol: 'opencode',
        acceptedNames: ['accepted-runtime-' + i],
        unnamedInvocations: 0,
        metrics: displayRuntimeMetrics(data.metrics, '10000', '2'),
        tasks: [{ taskId: task.id, metrics: displayRuntimeMetrics(data.metrics, '10000', '2') }],
      })),
      {
        authority: 'local',
        sourceId: null,
        registrationId: 'display-last-runtime',
        configurationRevision: 7,
        protocol: 'opencode',
        acceptedNames: ['original-last-runtime'],
        unnamedInvocations: 0,
        metrics: displayRuntimeMetrics(data.metrics, '4800', '60', 48),
        tasks: tasks.map((row) => ({ taskId: row.task.id, metrics: contribution })),
      },
    ]
    await route.fulfill({
      response,
      json: {
        ...data,
        metrics: displayRuntimeMetrics(data.metrics, '474800', '154', 95),
        tasks,
        runtimes,
        partial: false,
      },
    })
  })
  await page.route('**/api/observability/tasks/' + task.id, async (route) => {
    const response = await route.fetch(),
      data = (await response.json()) as ObservationTaskDetail
    await route.fulfill({
      response,
      json: { ...data, metrics: displayRuntimeMetrics(data.metrics, '470100', '95.25', 48) },
    })
  })
  await prime(page)
  const to = Date.now() + 1,
    from = to - 7 * 86400000
  const scope = new URLSearchParams({
    from: String(from),
    to: String(to),
    period: 'custom',
    tab: 'usage',
    workflow: workflow.id,
  })
  const nextControl = process.platform === 'darwin' && browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
  for (language of ['zh-CN', 'en-US'] as const)
    for (theme of ['light', 'dark'] as const)
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 })
        await page.goto(`${daemon.baseUrl}/observability?${scope.toString()}`)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        const prefix = language === 'zh-CN' ? '查看运行时贡献 · ' : 'View runtime contributions · '
        const openers = page.locator('[data-observation-runtime]')
        await expect(openers).toHaveCount(48)
        await expectAnalysisSpacing(page)
        await openers.nth(46).focus()
        await page.keyboard.press(nextControl)
        const opener = page.getByRole('button', {
          name: prefix + 'original-last-runtime',
          exact: true,
        })
        await expect(opener).toBeFocused()
        await page.keyboard.press('Enter')
        const dialog = page.getByRole('dialog', {
          name:
            (language === 'zh-CN' ? '运行时贡献 · ' : 'Runtime contributions · ') +
            'original-last-runtime',
          exact: true,
        })
        await expect(dialog).toBeVisible()
        const cards = dialog.locator('.card'),
          body = dialog.locator('.dialog__body')
        await expect(cards).toHaveCount(2)
        const boxes = await cards.evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect()
            return { top: box.top, bottom: box.bottom }
          }),
        )
        const gap = await dialog.evaluate(() =>
          Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--space-4'),
          ),
        )
        expect(boxes[1]!.top - boxes[0]!.bottom).toBeCloseTo(gap, 0)
        const taskButton = dialog.getByRole('button', {
          name: 'Observed parallel task',
          exact: true,
        })
        await taskButton.scrollIntoViewIfNeeded()
        await taskButton.focus()
        const row = taskButton.locator('xpath=ancestor::tr')
        await expect(row).toContainText('100')
        await expect(row).toContainText('¥1.25')
        await expect(row).not.toContainText('470,100')
        const main = page.getByTestId('app-shell-main')
        const saved = {
          main: await main.evaluate((element) => element.scrollTop),
          body: await body.evaluate((element) => element.scrollTop),
          window: await page.evaluate(() => scrollY),
          url: page.url(),
        }
        expect(saved.body).toBeGreaterThan(100)
        await page.keyboard.press(nextControl)
        await expect(
          dialog
            .getByRole('button', { name: language === 'zh-CN' ? '关闭' : 'Close', exact: true })
            .last(),
        ).toBeFocused()
        await taskButton.focus()
        await page.keyboard.press('Enter')
        await expect(
          page.getByRole('heading', {
            name: language === 'zh-CN' ? '任务整体' : 'Task total',
            exact: true,
          }),
        ).toBeVisible()
        await expect(page.locator('.observation-metrics').first()).toContainText('470,100')
        await page
          .getByRole('button', {
            name: language === 'zh-CN' ? '返回统计分析' : 'Back to analysis',
            exact: true,
          })
          .click()
        await expect(dialog).toBeVisible()
        await expect(page).toHaveURL(saved.url)
        await expect(taskButton).toBeFocused()
        expect(await body.evaluate((element) => element.scrollTop)).toBeCloseTo(saved.body, 0)
        expect(await main.evaluate((element) => element.scrollTop)).toBeCloseTo(saved.main, 0)
        expect(await page.evaluate(() => scrollY)).toBeCloseTo(saved.window, 0)
        const box = await dialog.boundingBox()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1)
        await page.screenshot({
          path: testInfo.outputPath(`runtime-contributions-${language}-${theme}-${width}.png`),
          fullPage: true,
        })
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(opener).toBeFocused()
        expect(new URL(page.url()).searchParams.has('runtime')).toBe(false)
        await expect(
          page.getByRole('button', { name: /CSV|Export|More filters|导出|更多筛选/ }),
        ).toHaveCount(0)
      }
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

// The full nightly route journal exposed two uncovered price-version routes.
// Exercise actual browser saves and durable history; no pricing request is mocked.
test('CNY price saves preserve runtime configuration and survive reopening history', async ({
  page,
}) => {
  const directory = await api<{ runtimes: ObservationPricingRuntime[] }>(
    '/api/observability/pricing/runtimes',
  )
  const runtime = directory.runtimes.find((entry) => entry.protocol === 'opencode')
  expect(runtime).toBeDefined()
  if (!runtime) throw new Error('The real daemon did not register its OpenCode runtime')
  const versionsPath =
    '/api/observability/pricing/runtimes/' +
    encodeURIComponent(runtime.registrationId) +
    '/versions'
  const before = await api<ObservationPriceHistory>(versionsPath + '?limit=20')
  const note = 'RFC-371 browser CNY tariff ' + randomUUID()
  await prime(page)
  await page.goto(`${daemon.baseUrl}/settings?tab=runtime`)
  const runtimeRow = page.locator('#token-cost tbody tr').filter({ hasText: runtime.name })
  await expect(runtimeRow).toHaveCount(1)
  await runtimeRow.getByRole('button', { name: 'Configure token prices', exact: true }).click()
  const editor = page.getByRole('dialog', { name: runtime.name + ' · Token cost', exact: true })
  await expect(editor).toBeVisible()
  await editor.getByLabel('Model provider', { exact: true }).fill('browser-fixture-provider')
  await editor.getByLabel('Actual model', { exact: true }).fill('browser-fixture-model')
  await editor.getByLabel('Uncached input', { exact: true }).fill('1.25')
  await editor.getByLabel('Cache read', { exact: true }).fill('0')
  await editor.getByLabel('Output', { exact: true }).fill('4.5')
  await editor.getByLabel('Pricing source / note', { exact: true }).fill(note)
  await expect(editor).toContainText('CNY per million tokens')
  const savedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === versionsPath && response.request().method() === 'POST',
  )
  await editor.getByRole('button', { name: 'Save price version', exact: true }).click()
  const response = await savedResponse
  expect(response.status()).toBe(201)
  const saved = (await response.json()) as ObservationPriceVersion
  expect(saved).toMatchObject({
    registrationId: runtime.registrationId,
    configurationRevision: runtime.configurationRevision,
    protocol: runtime.protocol,
    currency: 'CNY',
    revision: before.revision + 1,
    provider: 'browser-fixture-provider',
    model: 'browser-fixture-model',
    condition: null,
    rates: { input: '1.25', cacheRead: '0', cacheWrite: null, output: '4.5' },
    sourceNote: note,
  })
  await expect(editor).toHaveCount(0)
  await expect(runtimeRow).toContainText('CNY-v' + saved.revision)
  const historyButton = runtimeRow.getByRole('button', { name: 'Price history', exact: true })
  const history = page.getByRole('dialog', {
    name: runtime.name + ' · Price history',
    exact: true,
  })
  for (const reopen of [false, true]) {
    if (reopen) {
      await page.reload()
      await expect(runtimeRow).toContainText('CNY-v' + saved.revision)
    }
    const historyResponse = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === versionsPath && result.request().method() === 'GET',
    )
    await historyButton.click()
    const result = await historyResponse
    expect(result.status()).toBe(200)
    const persisted = (await result.json()) as ObservationPriceHistory
    expect(persisted.revision).toBe(saved.revision)
    expect(persisted.items.find((item) => item.id === saved.id)).toEqual(saved)
    const priceRow = history.locator('tbody tr').filter({ hasText: note })
    await expect(priceRow).toHaveCount(1)
    await expect(priceRow.locator('td').nth(3)).toHaveText('¥1.25')
    await expect(priceRow.locator('td').nth(4)).toHaveText('¥0')
    await expect(priceRow.locator('td').nth(5)).toHaveText('Unpriced')
    await expect(priceRow.locator('td').nth(6)).toHaveText('¥4.5')
    await page.keyboard.press('Escape')
    await expect(history).toHaveCount(0)
    await expect(historyButton).toBeFocused()
  }
  const after = await api<{ runtimes: ObservationPricingRuntime[] }>(
    '/api/observability/pricing/runtimes',
  )
  expect(after.runtimes.find((entry) => entry.registrationId === runtime.registrationId)).toEqual({
    ...runtime,
    pricingRevision: saved.revision,
  })
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
  const openers = page.getByRole('button', { name: 'View turn capture', exact: true })
  // Wait for the task response to render; locator.all() does not wait for loading cards.
  await expect(openers).toHaveCount(30)
  const opener = openers.last()
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
