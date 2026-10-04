// Real daemon/API/browser flow. The basic runtime emits no usage: missing values must stay unknown.
import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  CompleteObservationMetrics,
  CompleteObservationReport,
  CompleteObservationReportContent,
  CompleteObservationReportPage,
  CompleteObservationSection,
  CompleteObservationTask,
  CompleteObservationDimension,
  CompleteObservationDimensionTask,
  CompleteObservationInvocation,
  CompleteObservationAttempt,
  CompleteObservationTrend,
  ObservationOverviewQuery,
  ObservationPriceHistory,
  ObservationPriceVersion,
  ObservationPricingRuntime,
} from '@agent-workflow/shared'
import { startDaemon, type DaemonHandle } from './harness'
import { ObservationPlatformNativeCaptureSchema } from '../packages/shared/src/schemas/observationPlatform'
import {
  COMPLETE_OBSERVATION_SECTIONS,
  completeObservationReportContent,
} from '../packages/shared/src/schemas/observationReport'
import { ObservationDimensionSelectionSchema } from '../packages/shared/src/schemas/observationTasks'

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
      api<{ id: string; name: string }>('/api/agents', {
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

async function settledReport(value: CompleteObservationReport) {
  let report = value
  await expect
    .poll(
      async () => {
        if (report.state === 'building')
          report = await api<CompleteObservationReport>(
            '/api/observability/reports/' + encodeURIComponent(report.reportId),
          )
        return report.state
      },
      { timeout: 60_000, intervals: [250, 500, 1000] },
    )
    .not.toBe('building')
  expect(['ready', 'not-ready']).toContain(report.state)
  return report
}

async function originalReport(taskId?: string, workflow?: string) {
  const report = await settledReport(
    await api<CompleteObservationReport>('/api/observability/reports', {
      filters: {
        from: 0,
        to: Date.now() + 1,
        timezone: 'UTC',
        ...(workflow ? { workflow } : {}),
      },
      refreshKey: randomUUID(),
      ...(taskId ? { taskId } : {}),
    }),
  )
  const content = completeObservationReportContent(report)
  expect(content).not.toBeNull()
  return content!
}

async function originalRows<T>(
  report: CompleteObservationReportContent,
  section: CompleteObservationSection,
): Promise<T[]> {
  const expected = BigInt(report.counts[section] ?? '0')
  if (expected === 0n) return []
  const rows: T[] = []
  let after: string | null = null
  do {
    const query = new URLSearchParams({ section, limit: '2', ...(after ? { after } : {}) })
    const page = await api<CompleteObservationReportPage<T>>(
      `/api/observability/reports/${encodeURIComponent(report.header.reportId)}/pages?${query}`,
    )
    expect(page.reportId).toBe(report.header.reportId)
    expect(page.section).toBe(section)
    expect(page.parent).toBeNull()
    expect(BigInt(page.total)).toBe(expected)
    expect(page.nextCursor).not.toBe(after === null ? '' : after)
    rows.push(...page.items)
    after = page.nextCursor
  } while (after !== null)
  expect(BigInt(rows.length)).toBe(expected)
  return rows
}

function displayMetrics(
  total: string,
  amount: string,
  calls = 1,
  buckets = { input: total, cacheRead: '0', cacheWrite: '0', output: '0' },
): Extract<CompleteObservationMetrics, { state: 'ready' }> {
  expect(Object.values(buckets).reduce((sum, value) => sum + BigInt(value), 0n)).toBe(BigInt(total))
  return {
    state: 'ready',
    invocations: String(calls),
    observedInvocations: String(calls),
    records: String(calls),
    tokens: { ...buckets, total },
    cost: { currency: 'CNY', state: 'complete', amount },
  }
}

type DisplayRows = Partial<Record<CompleteObservationSection, readonly unknown[]>>
interface DisplayFixture {
  readonly whole: CompleteObservationMetrics
  readonly task: CompleteObservationMetrics
  readonly rows?: DisplayRows
  readonly contributions?: ReadonlyMap<string, readonly CompleteObservationDimensionTask[]>
}

function filterSelection(filters: ObservationOverviewQuery) {
  return filters.selection
    ? ObservationDimensionSelectionSchema.parse(JSON.parse(filters.selection))
    : null
}

/** Finite, read-only presentation data uses the current report/page protocol.
 * It does not replace the real-provider journey or claim these numbers are captured usage.
 */
async function reportDisplay(
  page: Page,
  original: CompleteObservationReportContent,
  fixture: DisplayFixture,
) {
  const root = original.summary.rootTask!
  expect(root).toBeDefined()
  const sourceRows = Object.fromEntries(
    await Promise.all(
      COMPLETE_OBSERVATION_SECTIONS.map(async (section) => [
        section,
        [
          'dimension-tasks',
          'quality-tasks',
          'span-facts',
          'span-captures',
          'span-statuses',
        ].includes(section)
          ? []
          : await originalRows<unknown>(original, section),
      ]),
    ),
  ) as Record<CompleteObservationSection, readonly unknown[]>
  const retained = new Map<
    string,
    { report: Extract<CompleteObservationReport, { state: 'ready' }>; rows: DisplayRows }
  >()
  await page.route('**/api/observability/reports**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/observability/reports' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        filters: ObservationOverviewQuery
        taskId?: string
      }
      // Actual model intersections go to the daemon; display values must never become evidence.
      if (filterSelection(body.filters)?.model) return route.fallback()
      const scoped = !!body.taskId,
        task = { ...root, metrics: fixture.task },
        rows: DisplayRows = {
          ...sourceRows,
          ...(scoped ? {} : fixture.rows),
          ...(scoped ? { tasks: [task] } : {}),
          ...(fixture.rows?.['platform-captures']
            ? { 'platform-captures': fixture.rows['platform-captures'] }
            : {}),
        },
        counts = Object.fromEntries(
          COMPLETE_OBSERVATION_SECTIONS.map((section) => [
            section,
            String(rows[section]?.length ?? 0),
          ]),
        ),
        id = 'display-report-' + randomUUID()
      const report: Extract<CompleteObservationReport, { state: 'ready' }> = {
        state: 'ready',
        header: {
          ...original.header,
          reportId: id,
          filters: body.filters,
          taskId: body.taskId ?? null,
        },
        summary: {
          ...original.summary,
          metrics: scoped ? fixture.task : fixture.whole,
          inventory: {
            tasks: counts.tasks!,
            attempts: counts.attempts!,
            invocations: counts.invocations!,
            numericRecords: counts.allocations!,
            nativeCaptures: counts['native-captures']!,
          },
          rootTask: scoped ? task : null,
        },
        counts,
      }
      retained.set(id, { report, rows })
      return route.fulfill({ json: report })
    }
    const match = /^\/api\/observability\/reports\/([^/]+)(\/pages)?$/.exec(url.pathname)
    const value = match && retained.get(decodeURIComponent(match[1]!))
    if (!value) return route.fallback()
    if (!match![2]) return route.fulfill({ json: value.report })
    const section = url.searchParams.get('section') as CompleteObservationSection,
      parent = url.searchParams.get('parent'),
      population =
        section === 'dimension-tasks'
          ? (fixture.contributions?.get(parent!) ?? [])
          : (value.rows[section] ?? []),
      offset = Number(url.searchParams.get('after') ?? '0'),
      size = Number(url.searchParams.get('limit')),
      items = population.slice(offset, offset + size)
    return route.fulfill({
      json: {
        reportId: value.report.header.reportId,
        section,
        parent,
        total: String(population.length),
        items,
        nextCursor:
          offset + items.length < population.length ? String(offset + items.length) : null,
      },
    })
  })
  return root
}

async function expectCardSpacing(page: Page) {
  // RFC-371: separate boundingBox awaits can span scrolling or a layout update.
  // Keep every rectangle, spacing token and overflow bound in one browser snapshot.
  const geometry = await page.locator('.page').evaluate((el) => ({
    cards: Array.from(el.querySelectorAll('.card')).map((card) => {
      const rect = card.getBoundingClientRect()
      return {
        title: card.querySelector('.card__title')?.textContent,
        box:
          card.getClientRects().length && getComputedStyle(card).visibility !== 'hidden'
            ? { x: rect.x, right: rect.right, y: rect.y, width: rect.width, height: rect.height }
            : null,
      }
    }),
    gap: Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--space-4'),
    ),
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(geometry.cards.length).toBeGreaterThanOrEqual(3)
  for (const card of geometry.cards) {
    expect(card.box, card.title ?? 'Untitled card').not.toBeNull()
    expect(card.box!.width).toBeGreaterThan(0)
    expect(card.box!.height).toBeGreaterThan(0)
  }
  let rowBottom = geometry.cards[0]!.box!.y + geometry.cards[0]!.box!.height
  for (let i = 1; i < geometry.cards.length; i++) {
    const before = geometry.cards[i - 1]!,
      after = geometry.cards[i]!
    const sameRow = Math.abs(after.box!.y - before.box!.y) < 1
    expect(
      sameRow ? after.box!.x - before.box!.right : after.box!.y - rowBottom,
      JSON.stringify({ before, after, expectedGap: geometry.gap }),
    ).toBeCloseTo(geometry.gap, 0)
    const bottom = after.box!.y + after.box!.height
    rowBottom = sameRow ? Math.max(rowBottom, bottom) : bottom
  }
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1)
}

async function expectAnalysisSpacing(page: Page) {
  await expect(page.getByRole('tabpanel')).toHaveClass(/(?:^|\s)stack--md(?:\s|$)/)
  const geometry = await page.getByRole('tabpanel').evaluate((panel) => {
    const gap = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--space-4'),
    )
    const blocks = Array.from(panel.children).map((el) => el.getBoundingClientRect())
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
  const detail = await originalReport(task.id)
  const calls = await originalRows<CompleteObservationInvocation>(detail, 'invocations')
  const agentRows = await originalRows<CompleteObservationDimension>(detail, 'agents')
  const attempts = await originalRows<CompleteObservationAttempt>(detail, 'attempts')
  expect(detail.summary.inventory.invocations).toBe('2')
  expect(calls).toHaveLength(2)
  expect(agentRows.map((agent) => agent.selection.agent!.id).sort()).toEqual(
    agents.map((agent) => agent.id).sort(),
  )
  const calledAttempts = new Set(calls.map((call) => call.nodeRunId))
  expect(attempts.filter((attempt) => calledAttempts.has(attempt.id))).toHaveLength(2)
  expect(detail.summary.metrics.state).toBe('not-ready')
  expect(detail.summary.metrics).not.toHaveProperty('tokens')
  expect(detail.summary.metrics).not.toHaveProperty('cost')
  const directory = await api<{ runtimes: ObservationPricingRuntime[] }>(
    '/api/observability/pricing/runtimes',
  )
  for (const row of await originalRows<CompleteObservationDimension>(detail, 'runtimes')) {
    const runtime = row.selection.runtime!
    expect(runtime.authority).toBe('local')
    expect(runtime.registrationId).not.toBeNull()
    const original = directory.runtimes.find(
      (entry) => entry.registrationId === runtime.registrationId,
    )
    expect(original).toBeDefined()
    expect(row.label).toBe(original!.name)
    expect(runtime.configurationRevision).toBe(original!.configurationRevision)
    expect(runtime.protocol).toBe(original!.protocol)
  }
  const trendRows = await originalRows<CompleteObservationTrend>(
    await originalReport(undefined, workflow.id),
    'trends',
  )
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
    const chart = page.locator('[data-observation-trend]')
    const tracks = await chart.locator('.observation-trend__track').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect()
        return { x: box.x, y: box.y, height: box.height }
      }),
    )
    // The complete report groups actual task creation periods, including every original task.
    expect(tracks).toHaveLength(trendRows.length)
    expect(tracks.length).toBeGreaterThan(0)
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
    .locator('[data-observation-trend]')
    .getByRole('button', { name: /1 tasks.*Usage records are incomplete for this scope/ })
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
  await page
    .getByRole('button', { name: agents[0]!.name, exact: true })
    .and(page.locator('[data-observation-dimension]'))
    .click()
  const agentDialog = page.getByRole('dialog', { name: agents[0]!.name, exact: true })
  const agentContributions = agentDialog
    .locator('.card')
    .filter({ has: page.getByRole('region', { name: 'Task usage', exact: true }) })
  await expect(agentContributions).toHaveCount(1)
  await expect(
    agentContributions.getByRole('heading', { name: 'Contributions by task', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /CSV|Export/ })).toHaveCount(0)
  await agentDialog.getByRole('button', { name: 'Observed parallel task', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Task total', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '← Back to analysis', exact: true }).click()
  await expect(agentDialog).toBeVisible()
  await expect(agentContributions).toHaveCount(1)
  await expect(
    agentContributions.getByRole('heading', { name: 'Contributions by task', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(agentDialog).toHaveCount(0)
  await page.getByRole('tab', { name: 'Tokens and cost', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Actual model', exact: true })).toBeVisible()
  await expectAnalysisSpacing(page)
  await page.getByRole('tab', { name: 'Performance and data quality', exact: true }).click()
  await expect(page.getByText('Completed task wall time P50', { exact: true })).toBeVisible()
  await expectAnalysisSpacing(page)
  await page.getByRole('tab', { name: 'Task traces', exact: true }).click()
  await page.getByRole('button', { name: 'Observed parallel task', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Task total', exact: true })).toBeVisible()
  await expectCardSpacing(page)
  const attempt = page.getByRole('button', {
    name: 'Show attempt statistics · agent_0',
    exact: true,
  })
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
  await page.getByRole('button', { name: '← Back to analysis', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Observed parallel task', exact: true }),
  ).toBeVisible()
})

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
  const original = await originalReport(task.id)
  const template = original.summary.rootTask!
  const contribution = displayMetrics('100', '1.25')
  const tasks = Array.from(
    { length: 48 },
    (_, i): CompleteObservationTask => ({
      ...template,
      task: {
        ...template.task,
        id: i === 47 ? task.id : 'display-task-' + i,
        name: i === 47 ? 'Observed parallel task' : 'Runtime display task ' + i,
      },
      metrics: i === 47 ? displayMetrics('470100', '95.25', 48) : contribution,
    }),
  )
  const runtimes = Array.from(
    { length: 48 },
    (_, i): CompleteObservationDimension => ({
      key: 'runtime-display-' + i,
      kind: 'runtime',
      label: i === 47 ? 'original-last-runtime' : 'accepted-runtime-' + i,
      selection: {
        runtime: {
          authority: 'local',
          sourceId: null,
          registrationId: i === 47 ? 'display-last-runtime' : 'display-runtime-' + i,
          configurationRevision: i === 47 ? 7 : i,
          protocol: 'opencode',
        },
      },
      metrics: i === 47 ? displayMetrics('4800', '60', 48) : displayMetrics('10000', '2'),
      taskCount: i === 47 ? '48' : '1',
    }),
  )
  await reportDisplay(page, original, {
    whole: displayMetrics('474800', '154', 95),
    task: displayMetrics('470100', '95.25', 48),
    rows: { tasks, runtimes },
    contributions: new Map(
      runtimes.map((row, i) => [
        row.key,
        i === 47
          ? tasks.map(({ task, timing }) => ({ task, timing, metrics: contribution }))
          : [
              {
                task: template.task,
                timing: template.timing,
                metrics: displayMetrics('10000', '2'),
              },
            ],
      ]),
    ),
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
        const back = page.getByRole('button', {
          name: language === 'zh-CN' ? '← 返回统计分析' : '← Back to analysis',
          exact: true,
        })
        const backBox = await back.boundingBox()
        const titleBox = await page.locator('.page__header .page__title').boundingBox()
        expect(backBox!.width).toBeLessThanOrEqual(180)
        expect(backBox!.height).toBeLessThanOrEqual(44)
        expect(backBox!.x).toBeCloseTo(titleBox!.x, 0)
        expect(backBox!.y + backBox!.height).toBeLessThanOrEqual(titleBox!.y + 1)
        await back.click()
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

test('model contributions restore the exact Dialog and scope before selecting an intersection at desktop, tablet and phone widths', async ({
  page,
  browserName,
}, testInfo) => {
  const { task, workflow } = await seedTask()
  let language: 'zh-CN' | 'en-US' = 'en-US',
    theme: 'light' | 'dark' = 'light'
  // Read-only numeric/long-list presentation around a genuine basic-runtime task.
  // These display values are not model usage evidence; real provider/API tests verify attribution.
  await page.route('**/api/config', async (route) => {
    expect(route.request().method()).toBe('GET')
    const response = await route.fetch(),
      config = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...config, language, theme } })
  })
  const original = await originalReport(task.id)
  const template = original.summary.rootTask!
  const contribution = displayMetrics('100', '1.25')
  const tasks = Array.from(
    { length: 48 },
    (_, i): CompleteObservationTask => ({
      ...template,
      task: {
        ...template.task,
        id: i === 47 ? task.id : 'display-model-task-' + i,
        name: i === 47 ? 'Observed parallel task' : 'Model display task ' + i,
      },
      metrics: i === 47 ? displayMetrics('470100', '95.25', 48) : contribution,
    }),
  )
  const models = Array.from(
    { length: 48 },
    (_, i): CompleteObservationDimension => ({
      key: 'model-display-' + i,
      kind: 'model',
      label: i === 47 ? 'original-last-model' : 'display-model-' + i,
      selection: {
        model: {
          authority: 'local',
          sourceId: null,
          provider: 'display-provider',
          model: i === 47 ? 'original-last-model' : 'display-model-' + i,
        },
      },
      metrics: i === 47 ? displayMetrics('4800', '60', 48) : displayMetrics('10000', '2'),
      taskCount: i === 47 ? '48' : '1',
    }),
  )
  await reportDisplay(page, original, {
    whole: displayMetrics('474800', '154', 95),
    task: displayMetrics('470100', '95.25', 48),
    rows: { tasks, models },
    contributions: new Map(
      models.map((row, i) => [
        row.key,
        i === 47
          ? tasks.map(({ task, timing }) => ({ task, timing, metrics: contribution }))
          : [
              {
                task: template.task,
                timing: template.timing,
                metrics: displayMetrics('10000', '2'),
              },
            ],
      ]),
    ),
  })
  await prime(page)
  const to = Date.now() + 1,
    from = to - 7 * 86400000
  const initialSelection = { purpose: 'task' as const }
  const scope = new URLSearchParams({
    from: String(from),
    to: String(to),
    period: 'custom',
    tab: 'usage',
    workflow: workflow.id,
    q: 'Observed',
    status: 'done',
    // TanStack search is JSON-first: encode this JSON-valued string as a string,
    // matching router navigation rather than parsing it into an object on load.
    selection: JSON.stringify(JSON.stringify(initialSelection)),
  })
  const nextControl = process.platform === 'darwin' && browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
  for (language of ['zh-CN', 'en-US'] as const)
    for (theme of ['light', 'dark'] as const)
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 844 })
        await page.goto(`${daemon.baseUrl}/observability?${scope}`)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        const openers = page.locator('[data-observation-model]')
        await expect(openers).toHaveCount(48)
        await expectAnalysisSpacing(page)
        await openers.nth(46).focus()
        await page.keyboard.press(nextControl)
        const opener = page.getByRole('button', {
          name:
            language === 'zh-CN'
              ? '查看模型 original-last-model 的任务贡献'
              : 'View task contributions from model original-last-model',
          exact: true,
        })
        await expect(opener).toBeFocused()
        await page.keyboard.press('Enter')
        const dialog = page.getByRole('dialog', {
          name:
            'original-last-model' +
            (language === 'zh-CN' ? ' · 任务贡献' : ' · Task contributions'),
          exact: true,
        })
        await expect(dialog).toBeVisible()
        const cards = dialog.locator('.card'),
          body = dialog.locator('.dialog__body')
        await expect(cards).toHaveCount(2)
        const geometry = await dialog.evaluate((element) => ({
          cards: Array.from(element.querySelectorAll('.card')).map((card) => {
            const box = card.getBoundingClientRect()
            return { top: box.top, bottom: box.bottom }
          }),
          gap: Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--space-4'),
          ),
          width: document.documentElement.scrollWidth - innerWidth,
        }))
        expect(geometry.cards[1]!.top - geometry.cards[0]!.bottom).toBeCloseTo(geometry.gap, 0)
        expect(geometry.width).toBeLessThanOrEqual(1)
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
        const main = page.getByTestId('app-shell-main'),
          saved = {
            main: await main.evaluate((element) => element.scrollTop),
            body: await body.evaluate((element) => element.scrollTop),
            window: await page.evaluate(() => scrollY),
            url: page.url(),
          }
        expect(saved.body).toBeGreaterThan(100)
        await page.keyboard.press('Enter')
        await expect(
          page.getByRole('heading', {
            name: language === 'zh-CN' ? '任务整体' : 'Task total',
            exact: true,
          }),
        ).toBeVisible()
        await expect(page.locator('.observation-metrics').first()).toContainText('470,100')
        const back = page.getByRole('button', {
          name: language === 'zh-CN' ? '← 返回统计分析' : '← Back to analysis',
          exact: true,
        })
        await expect(back).toHaveClass(/page__heading-back/)
        const backBox = await back.boundingBox()
        expect(backBox!.width).toBeLessThanOrEqual(180)
        expect(backBox!.height).toBeLessThanOrEqual(44)
        await back.click()
        await expect(dialog).toBeVisible()
        await expect(page).toHaveURL(saved.url)
        await expect(taskButton).toBeFocused()
        expect(await body.evaluate((element) => element.scrollTop)).toBeCloseTo(saved.body, 0)
        expect(await main.evaluate((element) => element.scrollTop)).toBeCloseTo(saved.main, 0)
        expect(await page.evaluate(() => scrollY)).toBeCloseTo(saved.window, 0)
        await page.screenshot({
          path: testInfo.outputPath(`model-contributions-${language}-${theme}-${width}.png`),
          fullPage: true,
        })
        // Escape restores the exact model trigger; reopening can select a server range.
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(opener).toBeFocused()
        await opener.click()
        const expectedSelection = {
          ...initialSelection,
          model: {
            authority: 'local',
            sourceId: null,
            provider: 'display-provider',
            model: 'original-last-model',
          },
        }
        const responsePromise = page.waitForResponse((response) => {
          const url = new URL(response.url())
          if (
            url.pathname !== '/api/observability/reports' ||
            response.request().method() !== 'POST'
          )
            return false
          const body = response.request().postDataJSON() as {
            filters: ObservationOverviewQuery
          } | null
          return (
            body !== null && filterSelection(body.filters)?.model?.model === 'original-last-model'
          )
        })
        await dialog
          .getByRole('button', {
            name: language === 'zh-CN' ? '查看关联任务' : 'View related tasks',
            exact: true,
          })
          .click()
        const response = await responsePromise
        expect(response.ok()).toBe(true)
        const selectedUrl = new URL(page.url()),
          requestFilters = response.request().postDataJSON().filters as ObservationOverviewQuery
        expect(JSON.parse(JSON.parse(selectedUrl.searchParams.get('selection')!))).toEqual(
          expectedSelection,
        )
        expect(requestFilters.selection).toBe(JSON.stringify(expectedSelection))
        expect(filterSelection(requestFilters)).toEqual(expectedSelection)
        for (const key of ['from', 'to', 'q', 'status', 'workflow']) {
          expect(selectedUrl.searchParams.get(key)).toBe(scope.get(key))
          expect(String(requestFilters[key as keyof ObservationOverviewQuery])).toBe(scope.get(key))
        }
        const selected = completeObservationReportContent(
          await settledReport((await response.json()) as CompleteObservationReport),
        )
        // Basic emits no usage; this journey must not turn the display fixture into facts.
        if (selected) {
          expect(selected.summary.metrics.state).not.toBe('ready')
          for (const item of await originalRows<CompleteObservationTask>(selected, 'tasks')) {
            expect(item.metrics).not.toHaveProperty('tokens')
            expect(item.metrics).not.toHaveProperty('cost')
          }
        }
        await expect(dialog).toHaveCount(0)
        await expect(
          page.getByRole('tab', {
            name: language === 'zh-CN' ? '任务追踪' : 'Task traces',
            exact: true,
          }),
        ).toHaveAttribute('aria-selected', 'true')
        await page
          .getByRole('button', {
            name: language === 'zh-CN' ? '清除实际模型范围' : 'Clear Actual model range',
            exact: true,
          })
          .click()
        await expect
          .poll(() => JSON.parse(JSON.parse(new URL(page.url()).searchParams.get('selection')!)))
          .toEqual(initialSelection)
        await expect(
          page.getByRole('button', { name: /CSV|Export|More filters|导出|更多筛选/ }),
        ).toHaveCount(0)
      }
})

test('overview omits attention, labels every token column and aligns collection facts', async ({
  page,
}, testInfo) => {
  const { task, workflow } = await seedTask()
  const original = await originalReport(task.id)
  const day = (await originalRows<CompleteObservationTrend>(original, 'trends'))[0]!
  const first = displayMetrics('1250', '1', 1, {
    input: '800',
    cacheRead: '200',
    cacheWrite: '50',
    output: '200',
  })
  const second = displayMetrics('2500', '2', 1, {
    input: '1600',
    cacheRead: '400',
    cacheWrite: '100',
    output: '400',
  })
  // Complete display values first; then remove the fixture and verify the original
  // daemon's unknown report. Partial lower bounds must never become exact totals.
  await reportDisplay(page, original, {
    whole: displayMetrics('3750', '3', 2, {
      input: '2400',
      cacheRead: '600',
      cacheWrite: '150',
      output: '600',
    }),
    task: first,
    rows: {
      tasks: [first, second].map((metrics, i) => ({
        ...original.summary.rootTask!,
        task: {
          ...original.summary.rootTask!.task,
          id: i === 0 ? task.id : 'display-trend-task',
          name: i === 0 ? 'Observed parallel task' : 'Trend display task',
        },
        metrics,
      })),
      trends: [first, second, { state: 'not-applicable' } as const].map((metrics, i) => ({
        ...day,
        key: 'display-day-' + i,
        from: day.from - (2 - i) * 86400000,
        to: day.to - (2 - i) * 86400000,
        tasks: i === 2 ? '0' : '1',
        metrics,
      })),
    },
  })
  await prime(page)
  await page.goto(`${daemon.baseUrl}/observability?workflow=${workflow.id}`)
  const chart = page.locator('[data-observation-trend]')
  await expect(chart.locator('.observation-trend__scale strong')).toHaveText([
    '1,250 Token',
    '2,500 Token',
    'No model calls',
  ])
  await expect(chart.locator('.observation-trend__segment')).toHaveCount(8)
  await chart.getByRole('button').first().focus()
  const selectedBuckets = page
    .getByRole('group', { name: 'Current trend interval' })
    .locator('[data-token-bucket]')
  await expect(selectedBuckets.locator('dd')).toHaveText(['800', '200', '50', '200'])
  await expect(chart.getByRole('button').first()).toHaveAccessibleName(
    /Uncached input 800.*Cache read 200.*Cache write 50.*Output 200/,
  )
  await chart.getByRole('button').nth(1).focus()
  await expect(selectedBuckets.locator('dd')).toHaveText(['1,600', '400', '100', '400'])
  await page.unroute('**/api/observability/reports**')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(chart.locator('.observation-trend__scale strong')).toHaveText([
    'Usage records are incomplete for this scope',
  ])
  await expect(chart.locator('.observation-trend__segment')).toHaveCount(0)
  await chart.getByRole('button').first().focus()
  await expect(selectedBuckets.locator('dd')).toHaveText([
    'Not observed',
    'Not observed',
    'Not observed',
    'Not observed',
  ])
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
    // The current formal page has timing facts and capture capabilities. Keep
    // the centering check on both actual lists, rather than the removed status card.
    const facts = page.getByRole('tabpanel').locator('dl.detail-grid')
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
    // Both cards can finish loading between two separate boundingBox calls.
    // Read their actual geometry together, keeping the original gap oracle.
    const { before, after, expectedGap } = await runtime.evaluate((element) => {
      const other = document.querySelector('#token-cost > .settings-card')
      return {
        before: element.getBoundingClientRect().toJSON(),
        after: other?.getBoundingClientRect().toJSON() ?? null,
        expectedGap: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--space-4'),
        ),
      }
    })
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
  await reportDisplay(page, await originalReport(task.id), {
    whole: displayMetrics('0', '0', 0),
    task: displayMetrics('0', '0', 0),
    rows: {
      'platform-captures': Array.from({ length: 30 }, (_, index) => ({
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

test('actual attempt swimlanes fill aligned tracks on one ruler at desktop and narrow widths', async ({
  page,
}, testInfo) => {
  const { task } = await seedTask()
  const original = await originalReport(task.id)
  const attempts = await originalRows<CompleteObservationAttempt>(original, 'attempts')
  expect(attempts.length).toBeGreaterThan(0)
  await prime(page)
  await page.goto(`${daemon.baseUrl}/observability?task=${task.id}`)
  const lanes = page.locator('.execution-swimlane').first()
  await expect(lanes.locator('tbody tr')).toHaveCount(attempts.length)
  await expect(lanes.locator('.execution-swimlane__axis span')).toHaveCount(5)
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const geometry = await lanes.locator('.execution-swimlane__track').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect()
        return { x: box.x, width: box.width }
      }),
    )
    expect(geometry).toHaveLength(attempts.length)
    for (const track of geometry) {
      // The real regression collapsed every track to 2px under the common btn alignment.
      expect(track.width).toBeGreaterThan(400)
      expect(track.x).toBeCloseTo(geometry[0]!.x, 0)
      expect(track.width).toBeCloseTo(geometry[0]!.width, 0)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    await page.screenshot({
      path: testInfo.outputPath(`attempt-swimlanes-${width}.png`),
      fullPage: true,
    })
  }
})
