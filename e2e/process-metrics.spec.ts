// RFC-616 (design/RFC-616-process-metrics/design.md §14): process metrics on a
// real daemon and in a real browser.
//
// A workflow task and a workgroup task run for real, so every number below is
// computed by the daemon from what those runs left behind: the six routes
// answer for them, the page lists and opens them, the canvas is coloured by the
// chosen metric, a task expands into its stages, and the text-theme analysis is
// started by hand. A digital employee's assignment needs a code host and a
// repository to exist at all; its page is driven here with one answer shaped by
// the shared contract over the daemon's own employee type, so the duty map is
// the real one. The employee facts themselves are covered on both databases by
// packages/backend/tests/rfc616-process-employee-facts.test.ts.
import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type {
  ProcessEmployeeSummary,
  ProcessInsightView,
  ProcessStat,
  ProcessSubjectList,
  ProcessUnitDetail,
  ProcessUnitPage,
  ProcessWorkflowSummary,
  ProcessWorkgroupSummary,
} from '@agent-workflow/shared'
import { DEVELOPMENT_TYPE_PATH } from './development-type-ref'
import { startDaemon, type DaemonHandle } from './harness'

const BASE = '/api/observability/process'
const MINUTE = 60_000
const HOUR = 60 * MINUTE

let daemon: DaemonHandle
let workflow: { id: string; name: string; taskId: string; taskName: string; stageName: RegExp }
let group: { id: string; name: string; taskId: string; taskName: string }

test.setTimeout(180_000)

async function request(path: string, body?: unknown): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, body)
  expect(response.ok, `${path}: ${response.status}`).toBe(true)
  return (await response.json()) as T
}

async function finished(taskId: string): Promise<void> {
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 90_000,
      intervals: [250, 500, 1000],
    })
    .toBe('done')
}

async function seedAgent(name: string): Promise<string> {
  const agent = await api<{ id: string }>('/api/agents', {
    name,
    description: 'Process metrics browser fixture',
    outputs: ['answer'],
    readonly: true,
    bodyMd: '',
  })
  return agent.id
}

async function seedWorkflowTask() {
  const tag = randomUUID().slice(0, 8)
  const agentName = `process-flow-${tag}`
  const agentId = await seedAgent(agentName)
  const name = `Process flow ${tag}`
  const created = await api<{ id: string }>('/api/workflows', {
    name,
    description: 'One agent call',
    definition: {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'input', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'explain',
          kind: 'agent-single',
          agentId,
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
  const taskName = `Measured task ${tag}`
  const task = await api<{ id: string }>('/api/tasks', {
    name: taskName,
    workflowId: created.id,
    scratch: true,
    inputs: { topic: 'process metrics' },
  })
  await finished(task.id)
  // A node without a title is shown by its agent's name where the frozen definition carries one, else by its id.
  const stageName = new RegExp(`^(explain|${agentName})$`)
  return { id: created.id, name, taskId: task.id, taskName, stageName }
}

async function seedWorkgroupTask() {
  const tag = randomUUID().slice(0, 8)
  const leadAgentId = await seedAgent(`process-lead-${tag}`)
  const workerAgentId = await seedAgent(`process-worker-${tag}`)
  const name = `Process group ${tag}`
  const created = await api<{ id: string }>('/api/workgroups', {
    name,
    description: 'Process metrics browser fixture',
    mode: 'leader_worker',
    instructions: 'Close the task once the goal is met.',
    leaderDisplayName: 'Lead',
    maxRounds: 4,
    members: [
      { memberType: 'agent', agentId: leadAgentId, displayName: 'Lead', roleDesc: 'Coordinates' },
      { memberType: 'agent', agentId: workerAgentId, displayName: 'Worker', roleDesc: 'Builds' },
    ],
  })
  const taskName = `Measured group task ${tag}`
  const task = await api<{ id: string }>(`/api/workgroups/${created.id}/tasks`, {
    name: taskName,
    goal: 'ship the process metrics fixture',
    scratch: true,
  })
  await finished(task.id)
  return { id: created.id, name, taskId: task.id, taskName }
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  workflow = await seedWorkflowTask()
  group = await seedWorkgroupTask()
})
test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

const windowQuery = () => {
  const to = Date.now() + MINUTE
  return new URLSearchParams({ from: String(to - 7 * 24 * HOUR), to: String(to) })
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

/**
 * How far anything reaches past the page's width. The app scrolls inside `.content`, not the
 * document, so the document never grows: both are measured, and a missing `.content` is itself
 * a failure (the probe must not pass by measuring nothing).
 */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('.content')
    if (content === null) return Number.POSITIVE_INFINITY
    return Math.max(
      content.scrollWidth - content.clientWidth,
      document.documentElement.scrollWidth - innerWidth,
    )
  })
const views = (page: Page) => page.getByRole('tablist', { name: 'Metric views', exact: true })

test('the six routes answer for a real workflow task and a real workgroup task', async () => {
  const flows = await api<ProcessSubjectList>(`${BASE}/subjects?kind=workflow&${windowQuery()}`)
  expect(flows).toMatchObject({ kind: 'workflow', scope: 'all', partial: false })
  expect(flows.items.find((row) => row.subjectId === workflow.id)).toMatchObject({
    name: workflow.name,
    units: 1,
    successRate: 1,
  })

  const summary = await api<ProcessWorkflowSummary>(
    `${BASE}/subjects/workflow/${workflow.id}?${windowQuery()}&tzOffset=0`,
  )
  expect(summary).toMatchObject({
    kind: 'workflow',
    subjectId: workflow.id,
    subjectName: workflow.name,
    counts: { total: 1, succeeded: 1, failed: 0, canceled: 0, active: 0 },
  })
  // The frozen definition draws the canvas; the one agent node is the one stage that executed.
  expect(summary.definition?.nodes.map((node) => node.id)).toEqual(['input', 'explain', 'output'])
  const explain = summary.stages.find((stage) => stage.key === 'explain')
  expect(explain).toMatchObject({ kind: 'agent-single', units: 1, runsPerUnit: 1, failureRate: 0 })
  expect(explain!.durationMs.n).toBe(1)
  expect(summary.metrics.leadP50?.value).toBeGreaterThan(0)

  const units = await api<ProcessUnitPage>(
    `${BASE}/subjects/workflow/${workflow.id}/units?${windowQuery()}`,
  )
  expect(units.items.map((row) => [row.unitId, row.name, row.status])).toEqual([
    [workflow.taskId, workflow.taskName, 'succeeded'],
  ])
  const detail = await api<ProcessUnitDetail>(`${BASE}/units/workflow/${workflow.taskId}`)
  expect(detail.unit.unitId).toBe(workflow.taskId)
  expect(detail.stages.find((stage) => stage.key === 'explain')).toMatchObject({
    runs: 1,
    failedRuns: 0,
  })
  // A workflow task is not a workgroup unit.
  expect((await request(`${BASE}/units/workgroup/${workflow.taskId}`)).status).toBe(404)

  // No person wrote anything in this task, so there is nothing to analyse: asking queues nothing.
  const before = await api<ProcessInsightView>(
    `${BASE}/subjects/workflow/${workflow.id}/insight?${windowQuery()}`,
  )
  expect(before).toMatchObject({ schedule: 'manual', result: null, active: null, failure: null })
  const range = Object.fromEntries(windowQuery())
  const asked = await request(`${BASE}/subjects/workflow/${workflow.id}/insight`, {
    from: Number(range.from),
    to: Number(range.to),
  })
  expect(asked.status).toBe(202)
  expect(await asked.json()).toEqual({ id: '', status: 'empty' })

  const groups = await api<ProcessSubjectList>(`${BASE}/subjects?kind=workgroup&${windowQuery()}`)
  expect(groups.items.find((row) => row.subjectId === group.id)).toMatchObject({
    name: group.name,
    units: 1,
    successRate: 1,
    mode: 'leader_worker',
  })
  const groupSummary = await api<ProcessWorkgroupSummary>(
    `${BASE}/subjects/workgroup/${group.id}?${windowQuery()}&tzOffset=0`,
  )
  expect(groupSummary).toMatchObject({
    kind: 'workgroup',
    subjectId: group.id,
    mode: 'leader_worker',
    counts: { total: 1, succeeded: 1 },
  })
  // The leader read the state once and closed the task: one round, with the leader in the member list.
  expect(groupSummary.metrics.roundsPerUnit?.value).toBe(1)
  expect(groupSummary.rounds.map((round) => [round.round, round.units])).toEqual([[1, 1]])
  expect(groupSummary.members.map((member) => member.role)).toContain('leader')
  // A workgroup has no versions to split at.
  expect(
    (await request(`${BASE}/subjects/workgroup/${group.id}?${windowQuery()}&compare=version`))
      .status,
  ).toBe(422)

  const employees = await api<ProcessSubjectList>(
    `${BASE}/subjects?kind=digital-employee&${windowQuery()}`,
  )
  expect(employees).toMatchObject({ kind: 'digital-employee', items: [] })
})

test('a workflow: list, overview, canvas heat map, task stages and the analysis started by hand', async ({
  page,
}) => {
  for (const theme of ['light', 'dark'] as const) {
    await prime(page, theme)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`${daemon.baseUrl}/observability?tab=process`)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.getByRole('tab', { name: 'Process metrics', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      const list = page.getByRole('table', { name: 'Process metrics of workflows', exact: true })
      await expect(list.getByText(workflow.name, { exact: true })).toBeVisible()
      expect(await overflow(page)).toBe(0)

      await page
        .getByRole('button', { name: `Open the metrics of ${workflow.name}`, exact: true })
        .click()
      await expect(page).toHaveURL(new RegExp(`subject=${workflow.id}`))
      await expect(page.getByRole('heading', { name: workflow.name, level: 2 })).toBeVisible()
      await expect(page.getByText('Lead time (succeeded tasks)', { exact: true })).toBeVisible()
      await expect(page.getByText('Where the time goes', { exact: true })).toBeVisible()
      expect(await overflow(page)).toBe(0)

      await views(page).getByRole('tab', { name: 'Stages', exact: true }).click()
      const canvas = page.getByTestId('process-stages-canvas')
      // One node executed, so one node carries a colour step and its value.
      const heated = canvas.locator('.canvas-node--card[data-heat]')
      await expect(heated).toHaveCount(1)
      await expect(heated).toHaveAttribute('data-heat', '3')
      await expect(heated.locator('.canvas-node__heat')).toBeVisible()
      await expect(page.getByRole('heading', { name: /^Selected node · / })).toBeVisible()
      expect(await overflow(page)).toBe(0)
      await page.getByRole('button', { name: 'Back to workflows', exact: true }).click()
      await expect(list).toBeVisible()
    }
    await page.unrouteAll()
  }

  await prime(page)
  await page.setViewportSize({ width: 1280, height: 844 })
  await page.goto(
    `${daemon.baseUrl}/observability?tab=process&kind=workflow&subject=${workflow.id}`,
  )
  await expect(page.getByRole('heading', { name: workflow.name, level: 2 })).toBeVisible()

  // The same node, coloured by another metric: nothing failed, so the failure rate is the lowest step.
  await views(page).getByRole('tab', { name: 'Stages', exact: true }).click()
  await page.getByRole('radio', { name: 'Failure rate', exact: true }).click()
  await expect(
    page.getByTestId('process-stages-canvas').locator('.canvas-node--card[data-heat]'),
  ).toHaveCount(1)
  await page.getByRole('radio', { name: 'Table', exact: true }).click()
  const nodes = page.getByRole('table', { name: 'Metrics by node', exact: true })
  await expect(nodes.getByRole('rowheader', { name: workflow.stageName })).toBeVisible()

  await views(page).getByRole('tab', { name: 'Tasks', exact: true }).click()
  const tasks = page.getByRole('table', { name: 'Tasks', exact: true })
  await expect(tasks.getByRole('link', { name: workflow.taskName, exact: true })).toHaveAttribute(
    'href',
    `/tasks/${workflow.taskId}`,
  )
  await page
    .getByRole('button', { name: `Show the stages of ${workflow.taskName}`, exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`unit=${workflow.taskId}`))
  await expect(
    page.getByRole('table', { name: 'Stages', exact: true }).getByText(workflow.stageName),
  ).toBeVisible()

  await views(page).getByRole('tab', { name: 'Improvements', exact: true }).click()
  await expect(page.getByText('Not analyzed yet', { exact: true })).toBeVisible()
  const asked = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${BASE}/subjects/workflow/${workflow.id}/insight` &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Analyze', exact: true }).click()
  expect((await asked).status()).toBe(202)
  await expect(
    page.getByText('There is no text to analyze in this time range.', { exact: true }),
  ).toBeVisible()
})

test('a workgroup: list, rounds and members at desktop and phone widths in both themes', async ({
  page,
}) => {
  for (const theme of ['light', 'dark'] as const) {
    await prime(page, theme)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`${daemon.baseUrl}/observability?tab=process`)
      await page.getByRole('radio', { name: 'Workgroups', exact: true }).click()
      await expect(page).toHaveURL(/kind=workgroup/)
      const list = page.getByRole('table', { name: 'Process metrics of workgroups', exact: true })
      await expect(list.getByText(group.name, { exact: true })).toBeVisible()
      await expect(list.getByText('Leader dispatch', { exact: true })).toBeVisible()
      await page
        .getByRole('button', { name: `Open the metrics of ${group.name}`, exact: true })
        .click()
      await expect(page.getByRole('heading', { name: group.name, level: 2 })).toBeVisible()
      // A workgroup compares periods only.
      await expect(page.getByRole('radio', { name: 'Previous period', exact: true })).toBeVisible()
      await expect(page.getByRole('radio', { name: /^Split at/ })).toHaveCount(0)
      await expect(page.getByText('Coordination cost', { exact: true }).first()).toBeVisible()
      expect(await overflow(page)).toBe(0)

      await views(page).getByRole('tab', { name: 'Rounds', exact: true }).click()
      await expect(page.getByRole('group', { name: 'Cards per round', exact: true })).toBeVisible()
      const rounds = page.getByRole('table', { name: 'By round', exact: true })
      await expect(rounds.getByRole('rowheader', { name: 'Round 1', exact: true })).toBeVisible()
      expect(await overflow(page)).toBe(0)

      await views(page).getByRole('tab', { name: 'Members', exact: true }).click()
      const members = page.getByRole('table', { name: 'Members × metrics', exact: true })
      // The leader's row: its role, followed by the role note the group gave it.
      await expect(members.getByText(/^Leader( · |$)/).first()).toBeVisible()
      expect(await overflow(page)).toBe(0)
    }
    await page.unrouteAll()
  }

  await prime(page)
  await page.setViewportSize({ width: 1280, height: 844 })
  await page.goto(
    `${daemon.baseUrl}/observability?tab=process&kind=workgroup&subject=${group.id}&view=units`,
  )
  const tasks = page.getByRole('table', { name: 'Tasks', exact: true })
  await expect(tasks.getByRole('link', { name: group.taskName, exact: true })).toHaveAttribute(
    'href',
    `/tasks/${group.taskId}`,
  )
})

interface EmployeeType {
  readonly authoringManifest: {
    readonly lifecycleRegions: readonly {
      readonly regionId: string
      readonly label: { readonly 'zh-CN': string; readonly 'en-US': string }
      readonly order: number
      readonly responsibilityLanes: readonly {
        readonly laneId: string
        readonly label: { readonly 'zh-CN': string; readonly 'en-US': string }
        readonly order: number
        readonly kind: 'spine' | 'branch'
      }[]
    }[]
    readonly workItems: readonly {
      readonly workItemRef: string
      readonly regionId: string
      readonly responsibilityLaneId: string | null
      readonly order: number
      readonly label: { readonly 'zh-CN': string; readonly 'en-US': string }
      readonly nodeKind: 'business-tool' | 'system' | 'collaboration'
    }[]
  }
}

const stat = (p50: number): ProcessStat => ({ n: 4, p50, p90: p50 * 2, mean: p50 })
const compared = (value: number | null) => ({ value, baseline: null })

/** One answer in the shape of the shared contract, over the work items of the daemon's own type. */
function employeeSummary(
  type: EmployeeType,
  typeRef: { typeId: string; revision: number },
): ProcessEmployeeSummary {
  const items = type.authoringManifest.workItems.slice(0, 5)
  return {
    asOf: Date.now(),
    from: Date.now() - 7 * 24 * HOUR,
    to: Date.now(),
    scope: 'all',
    kind: 'digital-employee',
    subjectId: 'employee-fixture',
    subjectName: 'Fixture employee',
    note: {
      units: 8,
      partial: false,
      unitLimit: 2_000,
      unitsWithoutUsage: 0,
      unitsWithoutRuntime: 0,
      runsWithoutCause: 0,
      usageLowerBound: false,
      unpriced: false,
    },
    identities: [],
    compare: { mode: 'off', split: null, baselineUnits: 0 },
    counts: { total: 8, succeeded: 6, failed: 1, canceled: 0, active: 1 },
    time: { sampleUnits: 0, leadMs: null, autoMs: 0, waits: [], otherMs: 0 },
    causes: [],
    interventions: { gates: [], manualRetriesPerUnit: 0, operationsPerUnit: 0 },
    trend: [],
    stability: {
      failureCodes: [],
      autoRetries: 2,
      interruptions: 0,
      recoveries: 0,
      manualRetries: 0,
      limitCancellations: 0,
      operations: 0,
    },
    hints: [],
    revisions: [{ revision: 1, units: 8 }],
    metrics: {
      units: compared(8),
      successRate: compared(0.86),
      leadP50: compared(26 * HOUR),
      leadP90: compared(60 * HOUR),
      tokensPerUnit: compared(3_200_000),
      costNanoPerUnit: compared(41_000_000_000),
      firstPassRate: compared(0.5),
      mergeRate: compared(0.71),
      blockedRate: compared(0.14),
    },
    typeId: typeRef.typeId,
    typeRevision: typeRef.revision,
    outcomes: { merged: 5, noChange: 1, otherFinished: 0, failed: 1 },
    cycle: {
      sampleUnits: 5,
      beforeBoundaryMs: 3 * HOUR,
      afterBoundaryMs: 22 * HOUR,
      waitMs: 4 * HOUR,
      boundaryKey: items[0]!.workItemRef,
    },
    firstPassApplicable: true,
    regions: type.authoringManifest.lifecycleRegions.map((region) => ({
      regionId: region.regionId,
      label: region.label,
      order: region.order,
      lanes: region.responsibilityLanes.map((lane) => ({
        laneId: lane.laneId,
        label: lane.label,
        order: lane.order,
        kind: lane.kind,
      })),
    })),
    // Five work items with rising time per round, so the map shows all five colour steps.
    workItems: items.map((item, index) => ({
      key: item.workItemRef,
      label: item.label,
      kind: item.nodeKind === 'system' ? 'work-item-system' : 'work-item-tool',
      regionId: item.regionId,
      laneId: item.responsibilityLaneId,
      order: item.order,
      rework: false,
      units: 8,
      roundsPerUnit: 1 + index / 2,
      roundMs: stat((index + 1) * 10 * MINUTE),
      attemptsPerRound: 1,
      tokensPerUnit: (index + 1) * 400_000,
      failureRate: index / 20,
      autoRetryRate: 0,
      gateRoundsPerUnit: null,
      gateWaitMsPerUnit: null,
    })),
    review: null,
    feedbackPerUnit: 3.5,
    approvals: { perUnit: null, waitMs: { n: 0, p50: null, p90: null, mean: null } },
    blocked: {
      units: 1,
      perUnit: 0.1,
      durationMs: stat(2 * HOUR),
      resumes: 1,
      terminations: 0,
      current: [],
    },
  }
}

test("a digital employee: the overview and the type's own duty map, coloured by the chosen metric", async ({
  page,
}) => {
  const [typeId, revision] = decodeURIComponent(DEVELOPMENT_TYPE_PATH).split('@') as [
    string,
    string,
  ]
  const type = await api<EmployeeType>(`/api/digital-employee-types/${DEVELOPMENT_TYPE_PATH}`)
  expect(type.authoringManifest.workItems.length).toBeGreaterThanOrEqual(5)
  const summary = employeeSummary(type, { typeId, revision: Number(revision) })
  const list: ProcessSubjectList = {
    asOf: Date.now(),
    from: summary.from,
    to: summary.to,
    kind: 'digital-employee',
    scope: 'all',
    partial: false,
    unitLimit: 5_000,
    items: [
      {
        subjectId: 'employee-fixture',
        name: 'Fixture employee',
        units: 8,
        successRate: 0.86,
        leadP50: 26 * HOUR,
        waitShare: null,
        tokensPerUnit: 3_200_000,
        costNanoPerUnit: 41_000_000_000,
        interventionsPerUnit: null,
        firstPassRate: 0.5,
        mode: null,
        roundsPerUnit: null,
        assignmentsPerUnit: null,
        coordinationShare: null,
        mergeRate: 0.71,
        blockedRate: 0.14,
      },
    ],
  }

  for (const theme of ['light', 'dark'] as const) {
    await prime(page, theme)
    // Only the two employee answers come from this file; the employee type and everything else is the daemon's.
    await page.route(
      (url) =>
        url.pathname === `${BASE}/subjects` && url.searchParams.get('kind') === 'digital-employee',
      (route) => route.fulfill({ json: list }),
    )
    await page.route(
      (url) => url.pathname === `${BASE}/subjects/digital-employee/employee-fixture`,
      (route) => route.fulfill({ json: summary }),
    )
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`${daemon.baseUrl}/observability?tab=process&kind=digital-employee`)
      const table = page.getByRole('table', {
        name: 'Process metrics of digital employees',
        exact: true,
      })
      await expect(table.getByText('Fixture employee', { exact: true })).toBeVisible()
      await page
        .getByRole('button', { name: 'Open the metrics of Fixture employee', exact: true })
        .click()
      await expect(page.getByRole('heading', { name: 'Fixture employee', level: 2 })).toBeVisible()
      await expect(page.getByText('Merge rate', { exact: true }).first()).toBeVisible()
      await expect(page.getByRole('group', { name: 'How assignments ended' })).toBeVisible()
      expect(await overflow(page)).toBe(0)

      await views(page).getByRole('tab', { name: 'Duty map', exact: true }).click()
      const map = page.getByTestId('process-duties-map')
      await expect(map.locator('[data-work-item-ref][data-heat]').first()).toBeVisible()
      // Five distinct values take the five steps, lowest to highest.
      const steps = await Promise.all(
        summary.workItems.map((item) =>
          map.locator(`[data-work-item-ref="${item.key}"]`).first().getAttribute('data-heat'),
        ),
      )
      expect(steps).toEqual(['1', '2', '3', '4', '5'])
      await expect(page.getByText('Low 10 min', { exact: true })).toBeVisible()
      await expect(page.getByText('High 50 min', { exact: true })).toBeVisible()
      // The page itself scrolls only vertically; the duty map scrolls inside its own frame.
      expect(await overflow(page)).toBe(0)
    }
    await page.unrouteAll()
  }
})
