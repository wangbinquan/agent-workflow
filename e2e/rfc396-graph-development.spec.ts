// Model output and the code host are controlled fixtures. The daemon, Case, native
// clarify/review, Git, MR publication and external-state observation use production paths.
// Actual model-quality and hosted-provider acceptance are recorded separately in RFC-396.
import { expect, test, type Page } from '@playwright/test'
import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'
import { startDaemon, type DaemonHandle } from './harness'
import { clarifyQuestionSetKey, clarifyAnswerBasis } from '../packages/shared/src/clarifyMindmap'
import type { ClarifyAnswer, ClarifyQuestion } from '../packages/shared/src/schemas/clarify'

test.setTimeout(300_000)
let daemon: DaemonHandle
let mocks: SystemMockClient
let employeeId: string
let repositoryId: string
let repositoryUrl: string
let defaultJob: { id: string; name: string; revision: number }
const typeRef = 'graph-development@2'
const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const projectPath = `rfc396/graph-${tag}`
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
  mocks = new SystemMockClient(
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
    projectPath,
    title: 'Graph journey',
    defaultBranch: 'main',
    baseFiles: { 'README.md': '# Existing repository\n' },
  })
  repositoryUrl = project.repoHttpUrl
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
    await api<{ items: { id: string; name: string; publishedRevision: number | null }[] }>(
      `/api/digital-employee-types/${typeRef}/job-templates`,
    )
  ).items
  const job = jobs.find((row) => row.id === 'platform:graph-development:job:mr-v1')
  expect(job?.publishedRevision).toBeGreaterThan(0)
  if (!job || job.publishedRevision === null)
    throw new Error('graph@2 MR default job is unavailable')
  defaultJob = { id: job.id, name: job.name, revision: job.publishedRevision }
  // The other scenarios share an API fixture; booking creates its own employee in the browser.
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
      decision?: { status?: string; uncertainty?: string; validationOwner?: string }
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
interface CaseProjection {
  case: {
    id: string
    typeRef: { typeId: string; revision: number }
    state: 'active' | 'waiting' | 'blocked' | 'terminal'
    terminalKind: string | null
  }
  contexts: { typeId: string }[]
  detail: {
    delivery: null | {
      kind: 'merge-request'
      status: 'active' | 'merged' | 'closed'
      ref: string
      webUrl: string | null
      sourceBranch: string | null
      targetBranch: string | null
      headSha: string
      readyToMerge: boolean
    }
  }
}
async function primeAuth(page: Page) {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function open(page: Page, caseId: string) {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/employee-cases/${caseId}?tab=design`)
  await expect(page.getByTestId('graph-design-workspace')).toBeVisible()
}

async function createBookingCaseThroughUi(page: Page, scenario: string): Promise<string> {
  await primeAuth(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${daemon.baseUrl}/digital-employees/${encodeURIComponent(typeRef)}`)
  await page.getByRole('tab', { name: 'Employees', exact: true }).click()
  await page.getByRole('button', { name: 'Create employee', exact: true }).click()
  const employeeName = `Graph browser employee ${tag}`
  const dialog = page.getByRole('dialog', { name: 'Create digital employee', exact: true })
  await dialog.getByLabel('Employee name').fill(employeeName)
  await dialog.getByRole('combobox', { name: 'Job template', exact: true }).click()
  await page.getByRole('option', { name: defaultJob.name, exact: true }).click()
  await expect(dialog.getByTestId('employee-scope-picker')).toContainText(
    'Choose repository when starting a task',
  )
  const creating = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      decodeURIComponent(new URL(response.url()).pathname) ===
        `/api/digital-employee-types/${typeRef}/employees`,
  )
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  const created = await creating
  expect(created.status()).toBe(201)
  expect(created.request().postDataJSON()).toMatchObject({
    name: employeeName,
    jobTemplateRef: { id: defaultJob.id, revision: defaultJob.revision },
    workScope: { kind: 'task' },
  })
  const employee = (await created.json()) as { id: string }
  const card = page.locator('.employee-summary-card--employee').filter({ hasText: employeeName })
  await expect(card).toContainText(defaultJob.name)
  await card.getByRole('link', { name: 'Create task', exact: true }).click()
  await expect(page.getByTestId('stepper-step-mode')).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('combobox', { name: 'Digital employee', exact: true })).toContainText(
    employeeName,
  )
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-space')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('repo-source-recent-urls-0').click()
  await page.getByRole('option', { name: repositoryUrl, exact: true }).click()
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-task-name').fill(scenario)
  await page.getByRole('radio', { name: 'Write request', exact: true }).click()
  await page.getByRole('textbox', { name: 'Request', exact: true }).fill(scenario)
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  await expect(page.getByTestId('employee-case-summary-employee')).toContainText(employeeName)
  await expect(page.getByTestId('employee-case-summary-space')).toContainText(projectPath)
  await expect(page.getByTestId('employee-case-summary-name')).toContainText(scenario)
  await expect(page.getByTestId('employee-case-summary-content')).toContainText(scenario)
  await test.info().attach('graph-booking-create-task', {
    body: await page.getByTestId('task-wizard').screenshot(),
    contentType: 'image/png',
  })
  const launching = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/digital-employees/${employee.id}/cases`,
  )
  await page.getByTestId('wizard-launch').click()
  const launched = await launching
  expect(launched.ok()).toBe(true)
  expect(launched.request().postDataJSON()).toMatchObject({
    name: scenario,
    kind: 'body',
    body: scenario,
    target: { repositoryId },
  })
  const projection = (await launched.json()) as { case: { id: string } }
  await expect(page).toHaveURL(
    (url) => url.pathname === `/tasks/employee-cases/${projection.case.id}`,
  )
  return projection.case.id
}

async function answerOriginalQuestionsThroughUi(
  page: Page,
  taskId: string,
  roundId: string,
  round: { iteration: number; questions: ClarifyQuestion[] },
  answer: ClarifyAnswer,
) {
  await page.getByRole('link', { name: 'Answer original questions', exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === `/tasks/${taskId}`)
  await page.locator('[data-task-detail-section-link="task-questions"]').first().click()
  await expect(page.getByTestId('task-questions-board')).toBeVisible()
  await page.getByTestId('tq-open-answer-pane').click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Open mindmap to clarify and review', exact: true })
    .click()
  await expect(page).toHaveURL((url) => url.pathname === `/clarify/${roundId}`)
  await expect(page.getByRole('img', { name: 'Clarification mindmap', exact: true })).toBeVisible()
  const question = round.questions.find((entry) => entry.id === answer.questionId)!
  await page.getByRole('textbox', { name: 'Search categories or questions' }).fill(question.title)
  await page.getByRole('option').filter({ hasText: question.title }).click()
  const questionDialog = page.getByRole('dialog')
  await expect(
    questionDialog.getByRole('heading', { name: question.title, exact: true }),
  ).toBeVisible()
  await test.info().attach('graph-booking-original-questions', {
    body: await questionDialog.screenshot(),
    contentType: 'image/png',
  })
  await questionDialog.getByTestId('clarify-custom-radio').check()
  await questionDialog.getByTestId('clarify-custom-textarea').fill(answer.customText)
  await questionDialog.locator('summary').filter({ hasText: 'Decision context' }).click()
  await questionDialog.getByRole('radio', { name: 'Provisional', exact: true }).click()
  await questionDialog
    .getByRole('textbox', { name: 'Still unverified', exact: true })
    .fill(answer.decision!.uncertainty!)
  await expect(questionDialog.getByRole('textbox', { name: 'Who will validate' })).toHaveValue('')
  await expect(
    questionDialog.getByRole('textbox', { name: 'When or under what conditions to revisit' }),
  ).toHaveValue('')
  await questionDialog.getByRole('button', { name: 'Confirm this answer', exact: true }).click()
  await expect(
    questionDialog.getByRole('button', { name: 'Confirmed', exact: true }),
  ).toBeDisabled()
  await questionDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(
    page.getByText('This round’s answers are confirmed. Review decisions before submitting.'),
  ).toBeVisible()
  await page.getByTestId('mindmap-review-open').click()
  const review = page.getByTestId('mindmap-review')
  await expect(review).toContainText(answer.customText)
  await expect(review).toContainText('Provisional')
  await expect(review).toContainText(answer.decision!.uncertainty!)
  await expect(review).toContainText(
    'This decision is provisional; validation ownership or review timing is still unspecified.',
  )
  await expect(page.getByTestId('mindmap-review-submit')).toBeEnabled()
  await test.info().attach('graph-booking-answer-confirmation', {
    body: await review.screenshot(),
    contentType: 'image/png',
  })
  const submitting = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/clarify/${roundId}/answers`,
  )
  await page.getByTestId('mindmap-review-submit').click()
  const submitted = await submitting
  expect(submitted.ok()).toBe(true)
  expect(submitted.request().postDataJSON()).toMatchObject({
    ifMatchIteration: round.iteration,
    questionSetKey: clarifyQuestionSetKey(round.questions),
    directive: 'stop',
    answers: [{ ...answer, confirmedBasis: clarifyAnswerBasis(question, answer) }],
  })
}

async function journey(
  page: Page,
  scenario: string,
  followup: string,
  finalMrState: 'merged' | 'closed' = 'merged',
) {
  const booking = scenario.startsWith('Booking:')
  const caseId = booking
    ? await createBookingCaseThroughUi(page, scenario)
    : (
        await api<{ case: { id: string } }>(`/api/digital-employees/${employeeId}/cases`, {
          name: scenario,
          kind: 'body',
          body: scenario,
          externalId: null,
          target: { repositoryId },
          uploads: [],
          executionOptions: {},
          advanced: { typeOptions: {} },
          idempotencyKey: `${tag}:${scenario}`,
        })
      ).case.id
  const caseProjection = () => api<CaseProjection>(`/api/employee-cases/${caseId}`)
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
  if (booking) {
    await answerOriginalQuestionsThroughUi(
      page,
      host.editableClarify!.taskId,
      roundId,
      round,
      answer,
    )
  } else {
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
  }
  await expect
    .poll(async () => (await workspace()).host.executionRef, { timeout: 90_000 })
    .toBeNull()
  const human = (await workspace()).document.sources.find((source) => source.kind === 'clarify')!
  expect(human.originalAnswer).toContain('owner and date are undecided')
  expect(human.decision?.status).toBe('provisional')
  expect(human.decision?.uncertainty).toBe('Owner and date remain unknown')
  expect(human.decision?.validationOwner).toBeUndefined()
  await open(page, caseId)
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
  if (booking) {
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
  if (booking) {
    await page.getByRole('button', { name: 'Business flow', exact: true }).first().click()
    const graph = page.getByRole('region', { name: 'flow', exact: true })
    await expect(graph.locator('svg')).toBeVisible()
    await graph.scrollIntoViewIfNeeded()
    await test.info().attach('graph-booking-adapted-flow', {
      body: await graph.screenshot(),
      contentType: 'image/png',
    })
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    if (booking) {
      await page.getByRole('region', { name: 'flow', exact: true }).scrollIntoViewIfNeeded()
      await test.info().attach(`graph-booking-${width}px`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
    }
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
      async () => {
        const state = await workspace()
        return {
          delivered: state.executionLinks.some(
            (link) => link.kind === 'delivery' && Boolean(link.commitSha),
          ),
          caseState: state.host.state,
          workItem: state.host.workItemRef,
        }
      },
      { timeout: 90_000 },
    )
    .toMatchObject({ delivered: true })
  // The internal candidate receipt is an MR handoff, not the end of this graph@2 Case.
  await expect
    .poll(
      async () => {
        const state = await caseProjection()
        return state.case.state === 'waiting' && state.detail.delivery?.status === 'active'
      },
      { timeout: 90_000, intervals: [1_000, 2_500, 5_000] },
    )
    .toBe(true)
  const published = await caseProjection()
  expect(published.case).toMatchObject({
    id: caseId,
    typeRef: { typeId: 'graph-development', revision: 2 },
    terminalKind: null,
  })
  expect(['active', 'waiting']).toContain(published.case.state)
  expect(published.contexts.map((context) => context.typeId)).toEqual(
    expect.arrayContaining([
      'graph-development.design-context',
      'development.issue-handling',
      'development.change-candidate',
      'development.merge-request',
    ]),
  )
  const delivery = published.detail.delivery
  if (!delivery?.sourceBranch || !delivery.webUrl) throw new Error('MR publication is incomplete')
  expect(delivery.kind).toBe('merge-request')
  expect(delivery.targetBranch).toBe('main')
  expect(delivery.sourceBranch).not.toBe(delivery.targetBranch)
  // This default job has no enterprise CI connection; an absent check cannot establish readiness.
  expect(delivery.readyToMerge).toBe(false)
  const project = (await mocks.snapshot()).codeHosts.find(
    (host) => host.projectPath === projectPath,
  )
  const matchingMrs =
    project?.mergeRequests.filter((mr) => mr.sourceBranch === delivery.sourceBranch) ?? []
  expect(matchingMrs).toHaveLength(1)
  const mergeRequest = matchingMrs[0]!
  expect(mergeRequest).toMatchObject({
    state: 'opened',
    headSha: delivery.headSha,
    targetBranch: 'main',
  })
  expect(
    (await workspace()).executionLinks.filter((link) => link.kind === 'delivery').at(-1)?.commitSha,
  ).toBe(delivery.headSha)
  await page.reload()
  await expect(page.getByTestId('graph-design-workspace')).toBeVisible()
  const care = page.getByTestId('graph-delivery-care')
  await expect(care).toContainText(delivery.ref)
  await expect(care).toContainText(`${delivery.sourceBranch} → main`)
  await expect(care.getByRole('link', { name: 'Open MR', exact: true })).toHaveAttribute(
    'href',
    delivery.webUrl,
  )
  await test.info().attach('graph-mr-published-and-waiting', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
  if (booking) {
    await care.getByRole('link', { name: 'Configure CI care job', exact: true }).click()
    await expect(page).toHaveURL(
      (url) =>
        decodeURIComponent(url.pathname) === `/digital-employees/${typeRef}` &&
        url.searchParams.get('view') === 'jobs' &&
        url.searchParams.get('jobTemplateId') === 'platform:graph-development:job:mr-ci-v1' &&
        url.searchParams.get('workItem') === 'collect-pipeline',
    )
    await expect(page.getByTestId('employee-job-template-editor')).toBeVisible()
    await open(page, caseId)
  }
  // Graph design remains the primary workspace while the same Case owns its MR care contexts.
  await page.getByRole('link', { name: /^Overview Input,/ }).click()
  await expect(page.getByTestId('employee-case-overview-repo')).toContainText(
    'The frozen baseline, candidate and delivery are in the design workspace.',
  )
  await expect(
    page.getByText('The workspace is not prepared; this is the task target.'),
  ).toHaveCount(0)
  // Change only the external fixture. The real observer must discover the new state
  // and settle this same Case; no internal event injection or Case termination endpoint is used.
  await mocks.mutateCodeHost({
    kind: 'set-mr-state',
    provider: 'gitlab',
    projectPath,
    number: mergeRequest.number,
    state: finalMrState,
  })
  await expect
    .poll(
      async () => {
        const state = await caseProjection()
        return {
          caseId: state.case.id,
          state: state.case.state,
          terminalKind: state.case.terminalKind,
          mrRef: state.detail.delivery?.ref,
          mrStatus: state.detail.delivery?.status,
        }
      },
      { timeout: 90_000, intervals: [1_000, 2_500, 5_000] },
    )
    .toEqual({
      caseId,
      state: 'terminal',
      terminalKind: finalMrState,
      mrRef: delivery.ref,
      mrStatus: finalMrState,
    })
  expect((await workspace()).host.state).toBe('terminal')
  await open(page, caseId)
  await expect(page.getByTestId('graph-delivery-care')).toContainText(
    finalMrState === 'merged' ? 'Merge request merged' : 'Merge request closed without merging',
  )
  await test.info().attach(`graph-mr-${finalMrState}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
  if (booking) {
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

test('RFC-396 booking journey adapts graphs, publishes the accepted candidate and observes MR merge', async ({
  page,
}) => {
  await journey(
    page,
    'Booking: prevent double reservation',
    'Add a priority rule for concurrent requests',
  )
})
test('RFC-396 notification journey adapts graphs and observes MR close without merging', async ({
  page,
}) => {
  await journey(
    page,
    'Notifications: deliver asynchronous messages',
    'Add duplicate and out-of-order handling',
    'closed',
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
