// Synthetic model boundary; real daemon, Case, native clarify/review, Git and design APIs.
// Actual model-quality acceptance is recorded separately in RFC-396.
import { expect, test, type Page } from '@playwright/test'
import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'
import { startDaemon, type DaemonHandle } from './harness'
import { clarifyQuestionSetKey, clarifyAnswerBasis } from '../packages/shared/src/clarifyMindmap'
import type { ClarifyQuestion } from '../packages/shared/src/schemas/clarify'

test.setTimeout(300_000)
let daemon: DaemonHandle
let employeeId: string
let repositoryId: string
const typeRef = 'graph-development@1'
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  expect(response.ok, `${path}: ${response.status} ${text}`).toBe(true)
  return (text ? JSON.parse(text) : null) as T
}
test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'graph-development', home: process.env.RFC396_E2E_HOME })
  const mocks = new SystemMockClient(
    process.env.AW_SYSTEM_MOCK_CONTROL_URL!,
    process.env.AW_SYSTEM_MOCK_CONTROL_TOKEN!,
  )
  await api(
    '/api/code-hosts/gitlab',
    {
      baseUrl: process.env.AW_SYSTEM_MOCK_GITLAB_API_BASE_URL!,
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
    },
    'PUT',
  )
  const project = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath: `rfc396/graph-${tag}`,
    title: 'Graph journey',
    defaultBranch: 'main',
    baseFiles: { 'README.md': '# Existing repository\n' },
  })
  const batch = await api<{ batchId: string }>('/api/cached-repos/batch-import', {
    urls: [project.repoHttpUrl],
  })
  await expect
    .poll(
      async () =>
        (await api<{ state: string }>(`/api/cached-repos/imports/${batch.batchId}`)).state,
      { timeout: 60_000 },
    )
    .toBe('completed')
  repositoryId = (
    await api<{ items: { id: string; urlRedacted: string }[] }>('/api/cached-repos')
  ).items.find((row) => row.urlRedacted === project.repoHttpUrl)!.id
  const jobs = (
    await api<{ items: { id: string; publishedRevision: number }[] }>(
      `/api/digital-employee-types/${typeRef}/job-templates`,
    )
  ).items
  const job = jobs.find((row) => row.id === 'platform:graph-development:job:v2')!
  employeeId = (
    await api<{ id: string }>(`/api/digital-employee-types/${typeRef}/employees`, {
      name: `Graph employee ${tag}`,
      jobTemplateRef: { id: job.id, revision: job.publishedRevision },
      workScope: { kind: 'task' },
      toolOverrides: [],
      adapterOverrides: [],
      collaborationOverrides: [],
    })
  ).id
})
test.afterAll(async () => {
  await daemon?.stop()
})

interface Workspace {
  document: {
    id: string
    revision: number
    views: { id: string; status: string }[]
    sources: {
      kind: string
      originalAnswer?: string
      decision?: { status?: string; validationOwner?: string }
    }[]
  }
  host: {
    state: string
    executionRef: string | null
    workItemRef: string | null
    editableClarify: { taskId: string; roundId: string } | null
  }
  bases: { id: string }[]
  proposals: { id: string; status: string }[]
  executionLinks: {
    kind: string
    commitSha?: string
    receipt?: { id: string; decision: string; taskId: string }
  }[]
}
async function open(page: Page, caseId: string) {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.goto(`${daemon.baseUrl}/tasks/employee-cases/${caseId}?tab=design`)
  await expect(page.getByTestId('graph-design-workspace')).toBeVisible()
}

async function journey(page: Page, scenario: string, followup: string) {
  const launched = await api<{ case: { id: string } }>(
    `/api/digital-employees/${employeeId}/cases`,
    {
      name: scenario,
      kind: 'body',
      body: scenario,
      externalId: null,
      target: { repositoryId },
      uploads: [],
      executionOptions: {},
      advanced: { typeOptions: {} },
      idempotencyKey: `${tag}:${scenario}`,
    },
  )
  const caseId = launched.case.id
  let identity: { id: string } | null = null
  await expect
    .poll(
      async () => {
        identity = await api(`/api/employee-cases/${caseId}/design`)
        return identity?.id
      },
      { timeout: 60_000 },
    )
    .toBeTruthy()
  const base = `/api/development-designs/${encodeURIComponent(identity!.id)}`
  const workspace = () => api<Workspace>(base)
  await expect
    .poll(async () => (await workspace()).host.editableClarify, { timeout: 90_000 })
    .toBeTruthy()
  // The design is already committed even though the original human gate is waiting.
  await expect
    .poll(async () => (await workspace()).document.views.length, { timeout: 30_000 })
    .toBeGreaterThan(0)
  await open(page, caseId)
  await expect(page.getByRole('link', { name: 'Answer original questions' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Business flow', exact: true }).first(),
  ).toBeVisible()
  const host = (await workspace()).host
  const rounds = await api<{ intermediaryNodeRunId: string }[]>(
    `/api/clarify?status=awaiting_human&taskId=${host.editableClarify!.taskId}`,
  )
  const roundId = rounds[0]!.intermediaryNodeRunId
  const round = await api<{ iteration: number; questions: ClarifyQuestion[] }>(
    `/api/clarify/${roundId}`,
  )
  const answer = {
    questionId: 'exception',
    selectedOptionIndices: [],
    selectedOptionLabels: [],
    customText: 'Keep exceptions explicit; owner and date are undecided',
    decision: { status: 'provisional' as const, uncertainty: 'Owner and date remain unknown' },
  }
  await api(`/api/clarify/${roundId}/answers`, {
    ifMatchIteration: round.iteration,
    questionSetKey: clarifyQuestionSetKey(round.questions),
    answers: [
      {
        ...answer,
        confirmedBasis: clarifyAnswerBasis(
          round.questions.find((question) => question.id === answer.questionId)!,
          answer,
        ),
      },
    ],
  })
  await expect
    .poll(async () => (await workspace()).host.executionRef, { timeout: 90_000 })
    .toBeNull()
  const human = (await workspace()).document.sources.find((source) => source.kind === 'clarify')!
  expect(human.originalAnswer).toContain('owner and date are undecided')
  expect(human.decision?.status).toBe('provisional')
  expect(human.decision?.validationOwner).toBeUndefined()
  await page.reload()
  await page.getByRole('button', { name: 'Pin this view', exact: true }).click()
  // The semantic pin edit advances the revision. Wait for the response/refetch
  // before starting requests that deliberately bind that revision (Windows CI).
  await expect(page.getByRole('button', { name: 'Unpin', exact: true })).toBeEnabled()
  await api(
    `/api/content-links/${encodeURIComponent(identity!.id)}?selection=%5B%22requirement%22%5D&viewId=overview`,
  )
  await api(
    `${base}/presentation`,
    {
      expectedRevision: 1,
      views: {
        overview: {
          viewId: 'overview',
          revision: 1,
          collapsedIds: [],
          positions: {},
          viewport: { x: 0, y: 0, zoom: 1.1 },
        },
      },
    },
    'PUT',
  )
  if (scenario.startsWith('Booking:')) {
    const requestId = `${tag}:cancel`
    await api(`${base}/actions`, {
      requestId,
      expectedRevision: (await workspace()).document.revision,
      action: 'replan',
      instruction: 'rfc396-cancelable-call',
      anchor: null,
    })
    await api(`${base}/actions/${requestId}/cancel`, {})
    await api(`${base}/actions/${requestId}/retry`, {})
    await expect
      .poll(async () => (await workspace()).proposals.some((p) => p.id === `action:${requestId}`), {
        timeout: 60_000,
      })
      .toBe(true)
  }
  await page.getByRole('button', { name: 'Adapt the view combination', exact: true }).click()
  await page.getByRole('dialog').getByRole('textbox').fill(followup)
  await page.getByRole('dialog').getByRole('button', { name: 'Submit request' }).click()
  await expect
    .poll(
      async () =>
        (await workspace()).proposals.some(
          (p) => p.id.startsWith('action:') && !p.id.endsWith(':cancel') && p.status === 'proposed',
        ),
      { timeout: 60_000 },
    )
    .toBe(true)
  const proposal = (await workspace()).proposals.find(
    (p) => p.id.startsWith('action:') && !p.id.endsWith(':cancel'),
  )!
  await page.getByTestId(`graph-proposal-${proposal.id}`).click()
  await expect(page.getByRole('dialog')).toContainText('Exception rules')
  await page.getByRole('button', { name: 'Apply proposal', exact: true }).click()
  await expect
    .poll(
      async () => (await workspace()).document.views.filter((v) => v.status !== 'archived').length,
    )
    .toBe(2)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Preview implementation basis', exact: true }).click()
  await page.getByRole('button', { name: 'Create reviewable preview', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Complete frozen semantics')
  const latestBasis = (await workspace()).bases.at(-1)!
  expect(
    (
      await api<{ files: { path: string }[] }>(
        `${base}/bases/${encodeURIComponent(latestBasis.id)}/export`,
      )
    ).files.length,
  ).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Request human review', exact: true }).click()
  let reviewId = ''
  await expect
    .poll(
      async () => {
        const state = await workspace()
        if (!state.host.executionRef) return false
        const reviews = await api<{ nodeRunId: string; taskId: string }[]>(
          '/api/reviews?status=pending',
        )
        reviewId = reviews.find((r) => r.taskId === state.host.executionRef)?.nodeRunId ?? ''
        return Boolean(reviewId)
      },
      { timeout: 90_000 },
    )
    .toBe(true)
  await page.goto(`${daemon.baseUrl}/reviews/${reviewId}`)
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await workspace()).executionLinks.some((link) => link.receipt?.decision === 'approved'),
      { timeout: 60_000 },
    )
    .toBe(true)
  await open(page, caseId)
  await page
    .getByRole('button', { name: /View basis/ })
    .last()
    .click()
  await page.getByRole('button', { name: 'Implement this basis', exact: true }).click()
  await expect
    .poll(
      async () => {
        const state = await workspace()
        return (
          state.host.state === 'blocked' &&
          state.executionLinks.some((link) => link.kind === 'implementation')
        )
      },
      { timeout: 90_000 },
    )
    .toBe(true)
  await page.reload()
  await expect(page.getByText('graph-result.js', { exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: 'Inspect original evidence and logs', exact: true })
    .first()
    .click()
  await expect(page.getByRole('dialog', { name: 'Original verification evidence' })).toContainText(
    'structure.json',
  )
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export original evidence', exact: true }).click()
  expect((await downloading).suggestedFilename()).toBe('graph-evidence.json')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Record acceptance', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('textbox')
    .fill(
      'Checked this synthetic fixture candidate and the generated reference test. Manual scope only.',
    )
  await page.getByRole('button', { name: 'Save acceptance', exact: true }).click()
  await page.getByRole('button', { name: 'Verify candidate again', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await workspace()).executionLinks.some(
          (link) => link.kind === 'delivery' && Boolean(link.commitSha),
        ),
      { timeout: 90_000 },
    )
    .toBe(true)
  await page.reload()
  await expect(page.getByTestId('graph-design-workspace')).toBeVisible()
  await test.info().attach('delivered-graph-workspace', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
  // Graph work does not use the development employee's MR/workspace projection.
  // A delivered graph Case must not claim its workspace is still unprepared.
  await page.getByRole('link', { name: /^Overview Input,/ }).click()
  await expect(page.getByTestId('employee-case-overview-repo')).toContainText(
    'The frozen baseline, candidate and delivery are in the design workspace.',
  )
  await expect(
    page.getByText('The workspace is not prepared; this is the task target.'),
  ).toHaveCount(0)
  await expect(page.getByTestId('employee-case-overview-mr')).toHaveCount(0)
  if (scenario.startsWith('Booking:')) {
    const current = await workspace()
    const receipt = await api<{ caseId: string }>(`${base}/clarification-requests`, {
      requestId: `${tag}:followon`,
      expectedRevision: current.document.revision,
      instruction: 'Clarify a new constraint after delivery',
      anchor: null,
      previousSourceIds: [],
      withdrawReview: false,
    })
    expect(receipt.caseId).not.toBe(caseId)
  }
}

test('RFC-396 booking journey adapts graphs and delivers an explicitly accepted candidate', async ({
  page,
}) => {
  await journey(
    page,
    'Booking: prevent double reservation',
    'Add a priority rule for concurrent requests',
  )
})
test('RFC-396 notification journey adapts graphs for duplicate and out-of-order constraints', async ({
  page,
}) => {
  await journey(
    page,
    'Notifications: deliver asynchronous messages',
    'Add duplicate and out-of-order handling',
  )
})
test('RFC-396 existing-module journey preserves the interface and adds exception rules', async ({
  page,
}) => {
  await journey(
    page,
    'Existing module: preserve the public interface',
    'Add an exception for incompatible responses',
  )
})
