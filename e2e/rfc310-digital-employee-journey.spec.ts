// RFC-310 browser journey for the current Digital Employee OS.
//
// The browser owns the user boundary: a published employee is visible on the
// fixed responsibility map, body and repository-bound files can be assigned,
// and the resulting stateful case appears in the unified task list. The full
// external-ID -> MR -> cross-repository employee -> approval -> large pipeline
// evidence -> repair -> merged lifecycle is covered by the backend system-mock
// E2E, where those deterministic participants can be asserted without UI races.

import { expect, test, type Locator, type Page } from '@playwright/test'

import { SYSTEM_MOCK_CODE_HOST_TOKEN, SystemMockClient } from '@agent-workflow/system-mocks'

import { defaultSystemMockToolPath, startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

interface ExactRef {
  id: string
  revision: number
}

interface EmployeeTypePackage {
  authoringManifest: {
    lifecycleRegions: Array<{
      regionId: string
      responsibilityLanes: Array<{
        laneId: string
        kind: 'spine' | 'branch'
        optional: boolean
      }>
    }>
    workItems: Array<{
      workItemRef: string
      responsibilityLaneId: string | null
      workContractRef: { contractId: string; version: number }
      toolRoleGroups: Array<{
        roleRef: string
        workContractRef?: { contractId: string; version: number }
        bindingSlots: Array<{ slotRef: string; required: boolean }>
      }>
    }>
  }
  workContracts: Array<{
    contractId: string
    version: number
    allowedToolKinds: Array<'agent' | 'workflow' | 'program'>
    requiredConnectionPurpose: string | null
  }>
}

interface AgentChoice {
  id: string
  updatedAt: number
  frontmatterExtra: {
    digitalEmployeeTemplate?: string
    executionContracts?: Array<{ contractId: string; version: number }>
  }
}

interface ToolDraft {
  id: string
  validationReceipt: {
    status: 'valid' | 'invalid'
    checks: Array<{ code: string; ok: boolean; detail: string }>
  }
}

const RUN_TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const PROJECT_PATH = `rfc310/os-browser-${RUN_TAG}`
const TYPE_REF = 'development@8'
const PROGRAM_FIXTURE = `import { readFileSync } from 'node:fs'
const inputJson = process.env.AW_PORT_CONTRACT_INPUT ??
  readFileSync(process.env.AW_PORT_FILE_CONTRACT_INPUT ?? '', 'utf8')
const input = JSON.parse(inputJson)
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  roundRef: input.roundRef,
  executionNonce: input.executionNonce,
  status: 'blocked',
  summary: 'browser contract fixture',
  contextPatches: [],
  effectSuggestions: [],
  artifactRefs: [],
}))`

let daemon: DaemonHandle
let mocks: SystemMockClient
let repositoryId = ''
let employeeId = ''
let employeeName = ''

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

async function requestJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${text}`)
  }
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function importRepository(repoUrl: string): Promise<string> {
  let batch = await requestJson<{
    batchId: string
    state: 'running' | 'completed'
    rows: Array<{ status: string; message: string | null }>
  }>('/api/cached-repos/batch-import', { method: 'POST', body: { urls: [repoUrl] } })
  const deadline = Date.now() + 60_000
  while (batch.state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    batch = await requestJson(`/api/cached-repos/imports/${batch.batchId}`)
  }
  if (batch.state !== 'completed' || batch.rows.some((row) => row.status !== 'done')) {
    throw new Error(`repository import failed: ${JSON.stringify(batch.rows)}`)
  }
  const repositories = await requestJson<{
    items: Array<{ id: string; urlRedacted: string | null }>
  }>('/api/cached-repos')
  const repository = repositories.items.find((candidate) => candidate.urlRedacted === repoUrl)
  if (repository === undefined) throw new Error(`imported repository ${repoUrl} is missing`)
  return repository.id
}

async function createPublishedApprovalAdapter(): Promise<ExactRef> {
  const draft = await requestJson<{ id: string }>('/api/integrations/development-adapters', {
    method: 'POST',
    body: {
      name: `Browser approval system ${RUN_TAG}`,
      purpose: 'approval-gateway',
      draft: {
        schemaVersion: 1,
        purpose: 'approval-gateway',
        operations: ['submit', 'lookup-by-idempotency-key', 'observe'],
        contractVersion: 1,
        executableRef: defaultSystemMockToolPath(),
        parameterSchemaRef: null,
        connectionRef: null,
        secretProjection: [],
        outputBudget: {
          maxFiles: 16,
          maxFileBytes: 1024 * 1024,
          maxTotalBytes: 4 * 1024 * 1024,
        },
        timeoutMs: 30_000,
      },
    },
  })
  const published = await requestJson<{ revision: number }>(
    `/api/integrations/development-adapters/${encodeURIComponent(draft.id)}/publish`,
    { method: 'POST', body: {} },
  )
  return { id: draft.id, revision: published.revision }
}

async function seedPublishedEmployee(): Promise<void> {
  const typePackage = await requestJson<EmployeeTypePackage>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}`,
  )
  const agents = await requestJson<AgentChoice[]>('/api/agents/builtins/digital-employee-templates')
  if (agents.length === 0) throw new Error('built-in Digital Employee Agent templates are missing')
  const approvalAdapterRef = await createPublishedApprovalAdapter()
  const optionalLaneIds = new Set(
    typePackage.authoringManifest.lifecycleRegions.flatMap((region) =>
      region.responsibilityLanes.filter((lane) => lane.optional).map((lane) => lane.laneId),
    ),
  )
  const bindings: Array<{
    workItemRef: string
    slotRef: string
    registrationRef: ExactRef
  }> = []

  for (const item of typePackage.authoringManifest.workItems) {
    if (item.responsibilityLaneId !== null && optionalLaneIds.has(item.responsibilityLaneId)) {
      continue
    }
    for (const role of item.toolRoleGroups) {
      const roleContractRef = role.workContractRef ?? item.workContractRef
      const contract = typePackage.workContracts.find(
        (candidate) =>
          candidate.contractId === roleContractRef.contractId &&
          candidate.version === roleContractRef.version,
      )
      if (contract === undefined) throw new Error(`missing work contract for ${item.workItemRef}`)
      for (const slot of role.bindingSlots) {
        if (!slot.required) continue
        const agent = agents.find((candidate) =>
          candidate.frontmatterExtra.executionContracts?.some(
            (declared) =>
              declared.contractId === contract.contractId && declared.version === contract.version,
          ),
        )
        const implementation =
          contract.allowedToolKinds.includes('agent') && agent !== undefined
            ? {
                kind: 'agent' as const,
                agentRef: { id: agent.id, revision: agent.updatedAt },
              }
            : contract.allowedToolKinds.includes('program')
              ? {
                  kind: 'program' as const,
                  runtimeKind: 'node' as const,
                  source: PROGRAM_FIXTURE,
                  parameterValues: {},
                  runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
                }
              : null
        if (implementation === null) {
          throw new Error(`${item.workItemRef}/${slot.slotRef} has no browser fixture executor`)
        }
        const draft = await requestJson<ToolDraft>(
          `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/${encodeURIComponent(item.workItemRef)}/tools`,
          {
            method: 'POST',
            body: {
              displayName: `${item.workItemRef}/${slot.slotRef}`,
              description: 'Current Digital Employee OS browser fixture',
              roleRef: role.roleRef,
              implementation,
              connectionRef:
                contract.requiredConnectionPurpose === null ? null : approvalAdapterRef,
            },
          },
        )
        if (draft.validationReceipt.status !== 'valid') {
          throw new Error(
            `tool ${item.workItemRef}/${slot.slotRef} invalid: ${JSON.stringify(draft.validationReceipt.checks)}`,
          )
        }
        const published = await requestJson<{ ref: ExactRef }>(
          `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/${encodeURIComponent(item.workItemRef)}/tools/${encodeURIComponent(draft.id)}/publish`,
          { method: 'POST', body: {} },
        )
        bindings.push({
          workItemRef: item.workItemRef,
          slotRef: slot.slotRef,
          registrationRef: published.ref,
        })
      }
    }
  }

  const job = await requestJson<{ id: string }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/job-templates`,
    {
      method: 'POST',
      body: {
        name: `Browser development role ${RUN_TAG}`,
        description: 'One deterministic tool binding for every required work-item slot.',
        defaultToolBindings: bindings,
        defaultCollaborationBindings: [],
      },
    },
  )
  const jobRef = await requestJson<{ ref: ExactRef }>(
    `/api/digital-employee-job-templates/${encodeURIComponent(job.id)}/publish`,
    { method: 'POST', body: {} },
  )

  employeeName = `Browser development employee ${RUN_TAG}`
  const employee = await requestJson<{ id: string; revision: number }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/employees`,
    {
      method: 'POST',
      body: {
        name: employeeName,
        jobTemplateRef: jobRef.ref,
        workScope: { kind: 'repository', repositoryId },
        toolOverrides: [],
        collaborationOverrides: [],
      },
    },
  )
  employeeId = employee.id
  expect(employee.revision).toBe(1)
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function expectUniformCapabilityToolCards(
  map: Locator,
  expectedWidth: number,
): Promise<void> {
  const sizes = await map.locator('[data-capability-tool-ref]').evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect()
      return { width: box.width, height: box.height }
    }),
  )
  expect(sizes.length).toBeGreaterThan(0)
  expect(Math.max(...sizes.map((size) => size.width))).toBeLessThanOrEqual(
    Math.min(...sizes.map((size) => size.width)) + 0.5,
  )
  expect(Math.max(...sizes.map((size) => size.height))).toBeLessThanOrEqual(
    Math.min(...sizes.map((size) => size.height)) + 0.5,
  )
  expect(Math.round(sizes[0]!.width)).toBe(expectedWidth)
  expect(Math.round(sizes[0]!.height)).toBe(56)
}

async function capabilityLaneRowCount(map: Locator, laneId: string): Promise<number> {
  return map
    .locator(`[data-capability-lane-id="${laneId}"] .employee-toolbox-lane__cards`)
    .evaluate((cards) => {
      const rowCenters = Array.from(cards.children)
        .filter((child) => !child.classList.contains('employee-toolbox-card--auxiliary'))
        .map((child) => {
          const box = child.getBoundingClientRect()
          return Math.round(box.top + box.height / 2)
        })
      return new Set(rowCenters).size
    })
}

test.beforeAll(async () => {
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  daemon = await startDaemon({ stubMode: 'development' })
  await requestJson('/api/code-hosts/gitlab', {
    method: 'PUT',
    body: {
      baseUrl: requiredEnv('AW_SYSTEM_MOCK_GITLAB_API_BASE_URL'),
      token: SYSTEM_MOCK_CODE_HOST_TOKEN,
    },
  })
  const project = await mocks.seedCodeHost({
    provider: 'gitlab',
    projectPath: PROJECT_PATH,
    title: 'RFC-310 current Digital Employee OS browser journey',
    defaultBranch: 'main',
    baseFiles: {
      'README.md': '# Browser journey repository\n',
      'src/App.java': 'class App {}\n',
    },
  })
  repositoryId = await importRepository(project.repoHttpUrl)
  await seedPublishedEmployee()
})

test.afterAll(async () => {
  await daemon?.stop()
})

test('body and repository-bound files enter a stateful employee case and the unified task list', async ({
  page,
}) => {
  const taskName = 'Implement the supplied acceptance change'
  await primeAuth(page)

  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_REF}?view=employees`)
  await expect(page.getByText(employeeName, { exact: true })).toBeVisible()
  const outcomeSummary = page.getByTestId(`digital-employee-outcomes-${employeeId}`)
  await expect(outcomeSummary).toBeVisible()
  await expect(outcomeSummary).toContainText('Merged0')
  await expect(outcomeSummary).toContainText('No change0')
  await expect(page.getByTestId('employee-toolbox-responsibility-map')).toHaveCount(0)
  await expect(page.getByTestId('digital-employee-type-new-task')).toHaveCount(0)
  await expect(page.getByTestId(`digital-employee-create-task-${employeeId}`)).toBeVisible()
  await page.getByRole('tab', { name: 'Toolbox' }).click()
  const responsibilityMap = page.getByTestId('employee-toolbox-responsibility-map')
  await expect(responsibilityMap).toBeVisible()
  await expectUniformCapabilityToolCards(responsibilityMap, 100)
  expect(await capabilityLaneRowCount(responsibilityMap, 'delivery-main')).toBe(1)
  await page.setViewportSize({ width: 1728, height: 900 })
  await expect.poll(() => capabilityLaneRowCount(responsibilityMap, 'delivery-main')).toBe(1)
  await expectUniformCapabilityToolCards(responsibilityMap, 136)
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect.poll(() => capabilityLaneRowCount(responsibilityMap, 'delivery-main')).toBe(1)
  await expect(responsibilityMap.locator('[data-work-item-ref]')).toHaveCount(20)
  const directInputCard = responsibilityMap.locator('[data-work-ingress-ref="ui-input:direct"]')
  const idInputCard = responsibilityMap.locator('[data-work-ingress-ref="ui-input:external-id"]')
  const issueIngressCard = responsibilityMap.locator('[data-work-ingress-ref="issue"]')
  const reviewBranch = responsibilityMap.locator(
    '[data-review-branch-work-item-ref="analyze-implement"]',
  )
  const repairPlanReviewCard = responsibilityMap.locator(
    '[data-review-option-ref="review-implementation-plan"]',
  )
  await expect(directInputCard).toHaveCount(1)
  await expect(directInputCard).toContainText('Description / document')
  await expect(idInputCard).toHaveCount(1)
  await expect(idInputCard).toContainText('Input ID')
  await expect(issueIngressCard).toHaveCount(1)
  await expect(issueIngressCard).toContainText('ISSUE')
  expect(
    await directInputCard.locator('strong').evaluate((label) => ({
      fontSize: getComputedStyle(label).fontSize,
      textAlign: getComputedStyle(label).textAlign,
    })),
  ).toEqual({ fontSize: '12px', textAlign: 'left' })
  await expect(directInputCard).toHaveAttribute('data-next-work-item-ref', 'analyze-implement')
  await expect(idInputCard).toHaveAttribute('data-next-work-item-ref', 'prepare-materials')
  await expect(issueIngressCard).toHaveAttribute('data-next-work-item-ref', 'analyze-implement')
  await expect(directInputCard.locator('small')).toHaveCount(0)
  await expect(idInputCard.locator('small')).toHaveCount(0)
  await expect(issueIngressCard.locator('small')).toHaveCount(0)
  const ingressBranch = responsibilityMap.locator(
    '[data-ingress-branch-work-item-ref="prepare-materials"]',
  )
  await expect(ingressBranch).toContainText('Prepare work materials')
  const parallelIngressBoxes = await Promise.all(
    [
      directInputCard,
      idInputCard,
      issueIngressCard,
      ingressBranch.locator('[data-work-item-ref="prepare-materials"]'),
    ].map(async (node) => await node.boundingBox()),
  )
  expect(parallelIngressBoxes.every((box) => box !== null)).toBe(true)
  const directInputBox = parallelIngressBoxes[0]!
  const idInputBox = parallelIngressBoxes[1]!
  const issueInputBox = parallelIngressBoxes[2]!
  const prepareMaterialsBox = parallelIngressBoxes[3]!
  expect(Math.abs(directInputBox.x - idInputBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(idInputBox.x - issueInputBox.x)).toBeLessThanOrEqual(1)
  expect(directInputBox.y).toBeLessThan(idInputBox.y)
  expect(idInputBox.y).toBeLessThan(issueInputBox.y)
  expect(directInputBox.x).toBeLessThan(prepareMaterialsBox.x)
  expect(idInputBox.x).toBeLessThan(prepareMaterialsBox.x)
  expect(issueInputBox.x).toBeLessThan(prepareMaterialsBox.x)
  const prepareMaterialsCenterY = prepareMaterialsBox.y + prepareMaterialsBox.height / 2
  expect(directInputBox.y + directInputBox.height / 2).toBeLessThan(prepareMaterialsCenterY)
  expect(
    Math.abs(idInputBox.y + idInputBox.height / 2 - prepareMaterialsCenterY),
  ).toBeLessThanOrEqual(1)
  expect(issueInputBox.y + issueInputBox.height / 2).toBeGreaterThan(prepareMaterialsCenterY)
  await expect(reviewBranch).toContainText('No human review')
  await expect(reviewBranch).toContainText('Analyze and implement')
  await expect(reviewBranch).toContainText('Human review required')
  await expect(reviewBranch.locator('[data-review-stage="analysis"] strong')).toHaveText(
    'Implementation planning',
  )
  await expect(reviewBranch.locator('[data-review-stage="implementation"]')).toHaveCount(0)
  await expect(reviewBranch.locator('[data-work-item-ref="analyze-implement"]')).toHaveCount(1)
  await expect(repairPlanReviewCard).toHaveCount(1)
  await expect(repairPlanReviewCard.locator('strong')).toHaveText('Human plan review')
  const reviewBypass = reviewBranch.locator('[data-review-bypass]')
  const reviewBypassJoin = reviewBranch.locator('[data-review-bypass-join]')
  const reviewPrefix = reviewBranch.locator('.employee-toolbox-review-branch__prefix')
  const analyzeImplementCard = reviewBranch.locator('[data-work-item-ref="analyze-implement"]')
  const analyzeImplementArrow = analyzeImplementCard.locator('[data-flow-arrow]')
  await expect(reviewBypass).toHaveCount(1)
  const [
    reviewBypassBox,
    reviewBypassJoinBox,
    reviewPrefixBox,
    analyzeImplementBox,
    analyzeImplementArrowBox,
    reviewCardBox,
  ] = await Promise.all([
    reviewBypass.boundingBox(),
    reviewBypassJoin.boundingBox(),
    reviewPrefix.boundingBox(),
    analyzeImplementCard.boundingBox(),
    analyzeImplementArrow.boundingBox(),
    repairPlanReviewCard.boundingBox(),
  ])
  expect(reviewBypassBox).not.toBeNull()
  expect(reviewBypassJoinBox).not.toBeNull()
  expect(reviewPrefixBox).not.toBeNull()
  expect(analyzeImplementBox).not.toBeNull()
  expect(analyzeImplementArrowBox).not.toBeNull()
  expect(reviewCardBox).not.toBeNull()
  expect(reviewBypassBox!.x - (prepareMaterialsBox.x + prepareMaterialsBox.width)).toBeGreaterThan(
    0,
  )
  expect(
    Math.abs(
      reviewBypassBox!.x +
        reviewBypassBox!.width -
        (reviewCardBox!.x + reviewCardBox!.width + analyzeImplementBox!.x) / 2,
    ),
  ).toBeLessThanOrEqual(1)
  expect(
    analyzeImplementBox!.x - (analyzeImplementArrowBox!.x + analyzeImplementArrowBox!.width),
  ).toBe(2)
  expect(
    Math.abs(
      reviewBypassJoinBox!.x -
        (reviewCardBox!.x + reviewCardBox!.width + analyzeImplementBox!.x) / 2,
    ),
  ).toBeLessThanOrEqual(1)
  expect(reviewBypassBox!.y).toBeLessThan(reviewPrefixBox!.y - 5)
  expect(
    Math.abs(
      reviewBypassBox!.y +
        reviewBypassBox!.height -
        (analyzeImplementBox!.y + analyzeImplementBox!.height / 2),
    ),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(
      reviewBypassBox!.y +
        reviewBypassBox!.height -
        (prepareMaterialsBox.y + prepareMaterialsBox.height / 2),
    ),
  ).toBeLessThanOrEqual(1)
  expect(
    await reviewBranch
      .locator('.employee-toolbox-review-branch__reviewed-flow .employee-toolbox-card')
      .evaluateAll((cards) =>
        cards.map((card) => card.querySelector('strong')?.textContent?.trim()),
      ),
  ).toEqual(['Implementation planning', 'Human plan review'])
  await expect(directInputCard).not.toHaveAttribute('data-work-item-ref')
  await expect(idInputCard).not.toHaveAttribute('data-work-item-ref')
  await expect(issueIngressCard).not.toHaveAttribute('data-work-item-ref')
  await expect(repairPlanReviewCard).not.toHaveAttribute('data-work-item-ref')

  const mainFlowCenters = await Promise.all(
    [
      ingressBranch,
      reviewBranch,
      responsibilityMap.locator('[data-work-item-ref="prepare-change"]'),
      responsibilityMap.locator('[data-work-item-ref="publish-mr"]'),
    ].map(async (node) => {
      const box = await node.boundingBox()
      return box === null ? Number.NaN : box.y + box.height / 2
    }),
  )
  expect(mainFlowCenters.every(Number.isFinite)).toBe(true)
  expect(Math.max(...mainFlowCenters) - Math.min(...mainFlowCenters)).toBeLessThanOrEqual(1)

  await directInputCard.click()
  await page.waitForURL(/\/tasks\/new\?kind=digital-employee$/)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_REF}?view=toolbox`)
  await expect(responsibilityMap).toBeVisible()

  await repairPlanReviewCard.click()
  const reviewGateDialog = page.getByTestId('employee-toolbox-duty-dialog')
  await expect(reviewGateDialog).toBeVisible()
  await expect(repairPlanReviewCard).toHaveClass(/employee-toolbox-card--active/)
  await expect(
    responsibilityMap.locator('[data-work-item-ref="analyze-implement"]'),
  ).not.toHaveClass(/employee-toolbox-card--active/)
  await expect(reviewGateDialog.getByTestId('employee-review-gate-detail')).toBeVisible()
  await expect(reviewGateDialog.getByRole('button', { name: 'Add tool', exact: true })).toHaveCount(
    0,
  )
  await reviewGateDialog.locator('.dialog__close').click()
  await expect(reviewGateDialog).toHaveCount(0)

  await issueIngressCard.click()
  await page.waitForURL(/\/events\?tab=subscriptions$/)
  await page.goto(`${daemon.baseUrl}/digital-employees/${TYPE_REF}?view=toolbox`)
  await expect(responsibilityMap).toBeVisible()
  await expect(responsibilityMap.locator('.employee-toolbox-lane')).toHaveCount(7)
  await expect(responsibilityMap.getByText('Main lane', { exact: true }).first()).toBeVisible()
  await expect(responsibilityMap.getByText('Duty lane', { exact: true }).first()).toBeVisible()
  const mapWidth = await responsibilityMap.evaluate(
    (element) => element.getBoundingClientRect().width,
  )
  expect(
    await responsibilityMap
      .locator('.employee-toolbox-lane')
      .evaluateAll(
        (lanes, width) => lanes.every((lane) => lane.getBoundingClientRect().width >= width * 0.94),
        mapWidth,
      ),
  ).toBe(true)
  await expect(
    responsibilityMap.locator('.employee-toolbox-region--branching .employee-toolbox-lane__axis'),
  ).toHaveCount(6)
  expect(
    await responsibilityMap.locator('.employee-toolbox-card strong').evaluateAll((labels) =>
      labels.flatMap((label) => {
        const clipped =
          label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1
        const text = label.textContent?.trim() ?? ''
        const accessibleName = label.closest('button')?.getAttribute('aria-label') ?? ''
        return clipped && !accessibleName.includes(text) ? [text] : []
      }),
    ),
  ).toEqual([])
  expect(
    await responsibilityMap.locator('.employee-toolbox-card').evaluateAll((cards) =>
      cards.flatMap((card) => {
        const kind = card.querySelector('.employee-toolbox-card__kind')
        const detail = card.querySelector('small')
        if (kind === null || detail === null) return []
        const kindBox = kind.getBoundingClientRect()
        const detailBox = detail.getBoundingClientRect()
        const overlaps =
          kindBox.left < detailBox.right &&
          kindBox.right > detailBox.left &&
          kindBox.top < detailBox.bottom &&
          kindBox.bottom > detailBox.top
        return overlaps ? [card.getAttribute('aria-label')] : []
      }),
    ),
  ).toEqual([])
  const responsibilityCardWidths = await responsibilityMap
    .locator('.employee-toolbox-lane__cards > .employee-toolbox-card')
    .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width))
  expect(
    Math.max(...responsibilityCardWidths) - Math.min(...responsibilityCardWidths),
  ).toBeLessThanOrEqual(0.5)
  const classifierCard = responsibilityMap.locator('[data-work-item-ref="classify-pipeline"]')
  const reviewRepairCard = responsibilityMap.locator('[data-work-item-ref="repair-feedback"]')
  const pipelineFanOutCard = responsibilityMap.locator('[data-work-item-ref="repair-pipeline"]')
  await expect(reviewRepairCard).not.toHaveClass(/employee-toolbox-card--fan-out/)
  await expect(pipelineFanOutCard).toHaveClass(/employee-toolbox-card--fan-out/)
  const pipelineStackVisual = await pipelineFanOutCard.evaluate((card) => {
    const style = getComputedStyle(card)
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      legacyLayerCount: card.querySelectorAll('.employee-toolbox-card__stack-layer').length,
    }
  })
  expect(pipelineStackVisual.legacyLayerCount).toBe(0)
  expect(pipelineStackVisual.boxShadow).toContain(pipelineStackVisual.backgroundColor)
  expect(pipelineStackVisual.boxShadow).toContain(pipelineStackVisual.borderColor)
  expect(pipelineStackVisual.boxShadow).toContain('4px 4px')
  expect(pipelineStackVisual.boxShadow).toContain('8px 8px')
  expect(pipelineStackVisual.boxShadow.indexOf('4px 4px')).toBeLessThan(
    pipelineStackVisual.boxShadow.indexOf('8px 8px'),
  )
  const careSpine = responsibilityMap.locator('[data-lane-id="care-attention"]')
  await expect(careSpine.locator('[data-work-item-ref="evaluate-ready"]')).toBeVisible()
  await expect(careSpine.locator('[data-work-item-ref="wait-merge"]')).toBeVisible()
  await expect(responsibilityMap.locator('[data-lane-id="care-readiness"]')).toHaveCount(0)
  await classifierCard.click()
  await expect(classifierCard).toHaveClass(/employee-toolbox-card--active/)
  const dutyDialog = page.getByTestId('employee-toolbox-duty-dialog')
  await expect(dutyDialog).toBeVisible()
  await expect(dutyDialog.getByText('Input material', { exact: true })).toBeVisible()
  expect(
    await dutyDialog
      .locator('.dialog__body')
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)
  const horizontalOverflow = await responsibilityMap.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  )
  expect(horizontalOverflow).toBeLessThanOrEqual(1)

  await dutyDialog.getByRole('button', { name: 'Add tool', exact: true }).click()
  const toolDialog = page.getByTestId('employee-add-tool-dialog')
  await expect(toolDialog).toBeVisible()
  await page.setViewportSize({ width: 760, height: 900 })
  expect(
    await toolDialog
      .locator('.dialog__body')
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)
  expect(
    await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)
  await toolDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 900 })
  await dutyDialog.locator('.dialog__close').click()
  await expect(dutyDialog).toHaveCount(0)

  await page.getByRole('tab', { name: 'Job templates' }).click()
  await page.getByRole('button', { name: 'New job template', exact: true }).click()
  const identityDialog = page.getByTestId('employee-job-identity-dialog')
  await expect(identityDialog).toBeVisible()
  await identityDialog.getByLabel('Template name').fill('Browser-created template')
  await identityDialog.getByLabel('Description').fill('Configured from the compact duty map')
  await identityDialog
    .getByRole('button', { name: 'Create and configure duties', exact: true })
    .click()
  const templateEditor = page.getByTestId('employee-job-template-editor')
  await expect(templateEditor).toBeVisible()
  await expectUniformCapabilityToolCards(templateEditor, 100)
  expect(await capabilityLaneRowCount(templateEditor, 'delivery-main')).toBe(1)
  await expect(page.getByLabel('Template name')).toHaveCount(0)
  await expect(page.getByLabel('Description', { exact: true })).toHaveCount(0)
  await templateEditor.locator('[data-work-item-ref="analyze-implement"]').click()
  const newTemplateDutyDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(newTemplateDutyDialog).toBeVisible()
  await newTemplateDutyDialog
    .getByRole('combobox', { name: 'Choose default tool', exact: true })
    .click()
  await page.getByRole('option').first().click()
  await newTemplateDutyDialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Save and publish', exact: true }).click()
  await expect(templateEditor).toHaveCount(0)
  const createdTemplate = page
    .locator('.employee-summary-card')
    .filter({ hasText: 'Browser-created template' })
  await expect(createdTemplate).toContainText('Published · v1')
  await createdTemplate.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.job-template-detail-editor')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.employee-toolbox-card--configured').first()).toBeVisible()
  await expect(page.locator('.employee-toolbox-card--missing').first()).toBeVisible()
  const jobMap = page.getByTestId('employee-toolbox-responsibility-map')
  const jobMapBox = await jobMap.boundingBox()
  expect(jobMapBox).not.toBeNull()
  expect(jobMapBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(900)
  await jobMap.locator('[data-work-item-ref="analyze-implement"]').click()
  const jobDutyDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(jobDutyDialog).toBeVisible()
  await expect(jobDutyDialog.getByText('Selected duty', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 760, height: 900 })
  expect(
    await jobDutyDialog
      .locator('.dialog__body')
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 1280, height: 900 })
  await jobDutyDialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(jobDutyDialog).toHaveCount(0)

  await page.goto(`${daemon.baseUrl}/tasks/new`)
  await expect(page.getByTestId('wizard-kind-digital-employee')).toBeVisible()
  const orchestrationWizardWidth = await page
    .getByTestId('task-wizard')
    .evaluate((element) => element.getBoundingClientRect().width)
  const creationCardBoxes = await Promise.all(
    ['agent', 'workflow', 'workgroup', 'digital-employee'].map((kind) =>
      page.getByTestId(`wizard-kind-${kind}`).boundingBox(),
    ),
  )
  expect(creationCardBoxes.every((box) => box !== null)).toBe(true)
  const creationCardRows = creationCardBoxes.map((box) => box?.y ?? 0)
  expect(Math.max(...creationCardRows) - Math.min(...creationCardRows)).toBeLessThanOrEqual(1)
  for (const [kind, destination] of [
    ['agent', '/agents'],
    ['workflow', '/workflows'],
    ['workgroup', '/workgroups'],
    ['digital-employee', '/digital-employees'],
  ] as const) {
    const cardIcon = page.getByTestId(`wizard-kind-${kind}`).locator('[data-icon]')
    const navigationIcon = page.locator(`a[href="${destination}"] [data-icon]`).first()
    const navigationIconName = await navigationIcon.getAttribute('data-icon')
    expect(navigationIconName).not.toBeNull()
    await expect(cardIcon).toHaveAttribute('data-icon', navigationIconName!)
  }
  const creationCard = page.getByTestId('wizard-kind-digital-employee')
  const iconBox = await creationCard.locator('.choice-card__icon').boundingBox()
  const descriptionBox = await creationCard.locator('.choice-card__desc').boundingBox()
  expect(iconBox).not.toBeNull()
  expect(descriptionBox).not.toBeNull()
  expect(Math.abs((iconBox?.x ?? 0) - (descriptionBox?.x ?? 0))).toBeLessThanOrEqual(0.5)
  await page.getByTestId('wizard-kind-digital-employee').click()
  await expect(page).toHaveURL(/\/tasks\/new$/)
  await expect(page.getByRole('heading', { name: 'New task' })).toBeVisible()
  await expect(page.getByTestId('task-wizard-stepper')).toBeVisible()
  const employeeWizardWidth = await page
    .getByTestId('task-wizard')
    .evaluate((element) => element.getBoundingClientRect().width)
  expect(Math.abs(employeeWizardWidth - orchestrationWizardWidth)).toBeLessThanOrEqual(1)
  await expect(page.getByTestId('stepper-step-mode')).toHaveAttribute('aria-current', 'step')
  await expect(page.getByTestId('wizard-draft-recovery')).toHaveCount(0)
  await page.getByTestId('wizard-kind-workflow').click()
  await expect(page).toHaveURL(/\/tasks\/new$/)
  await expect(page.getByTestId('wizard-draft-recovery')).toHaveCount(0)
  await page.getByTestId('wizard-kind-digital-employee').click()
  await expect(page.getByTestId('wizard-draft-recovery')).toHaveCount(0)
  const employeePicker = page.getByRole('combobox', { name: 'Digital employee' })
  await expect(employeePicker).toContainText('Select…')
  await expect(employeePicker).not.toContainText(employeeName)
  await employeePicker.click()
  await page.getByRole('option', { name: new RegExp(employeeName) }).click()
  await expect(page.getByText('Repository selected when the task starts')).toHaveCount(0)
  await page.setViewportSize({ width: 760, height: 900 })
  expect(
    await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 1280, height: 800 })

  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-space')).toHaveAttribute('aria-current', 'step')
  const fixedRepository = page.getByTestId('repo-source-recent-urls-0')
  await expect(fixedRepository).toBeDisabled()
  await expect(fixedRepository).toContainText(PROJECT_PATH)

  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-content')).toHaveAttribute('aria-current', 'step')
  await page.getByTestId('wizard-task-name').fill(taskName)
  await page.getByRole('radio', { name: 'Request and files', exact: true }).click()
  await page
    .getByLabel('Requirement or problem body')
    .fill('Implement the requested change and keep the supplied acceptance document in Git.')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'acceptance.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Acceptance\nThe change is ready for committer review.\n'),
  })
  await page.getByLabel('Repository target path', { exact: true }).fill('docs/acceptance.md')

  const launchRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /\/api\/digital-employees\/[^/]+\/cases$/.test(new URL(request.url()).pathname),
  )
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('stepper-step-confirm')).toHaveAttribute('aria-current', 'step')
  await expect(page.getByTestId('employee-case-summary-employee')).toContainText(employeeName)
  await expect(page.getByTestId('employee-case-summary-space')).toContainText(PROJECT_PATH)
  await expect(page.getByTestId('employee-case-summary-name')).toContainText(taskName)
  await expect(page.getByTestId('employee-case-summary-content')).toContainText(
    'docs/acceptance.md',
  )
  await page.getByTestId('wizard-launch').click()
  const submitted = await launchRequest
  expect(submitted.postDataJSON()).toMatchObject({
    name: taskName,
    kind: 'body-and-files',
    target: { repositoryId },
    body: 'Implement the requested change and keep the supplied acceptance document in Git.',
    uploads: [{ targetPath: 'docs/acceptance.md' }],
  })

  await page.waitForURL(/\/tasks\/employee-cases\/[0-9A-Z]+$/)
  const caseId = page.url().split('/').at(-1)!
  const runtimeCase = await requestJson<{
    capabilityActivation: { activeWorkItemRefs: string[] }
  }>(`/api/employee-cases/${encodeURIComponent(caseId)}`)
  await expect(page.getByRole('heading', { name: taskName, exact: true })).toBeVisible()
  await expect(
    page.getByText(`Development employee · ${employeeName}`, { exact: true }),
  ).toBeVisible()

  await page.goto(`${daemon.baseUrl}/tasks?type=digital-employee`)
  await expect(page.getByTestId('task-operations-list')).toBeVisible()
  const taskRow = page.getByTestId(`task-row-${caseId}`)
  await expect(taskRow).toBeVisible()
  await expect(taskRow).toContainText(taskName)
  await expect(taskRow).toContainText('Digital employee')
  await expect(taskRow).toContainText(`Development employee · ${employeeName}`)

  await page.goto(`${daemon.baseUrl}/tasks/employee-cases/${caseId}`)
  const runtimeMap = page.getByTestId('employee-toolbox-responsibility-map')
  await expect(runtimeMap).toBeVisible()
  await expectUniformCapabilityToolCards(runtimeMap, 100)
  expect(await capabilityLaneRowCount(runtimeMap, 'delivery-main')).toBe(1)
  const renderedRuntimeWorkItemRefs = await runtimeMap
    .locator('[data-work-item-ref]')
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-work-item-ref') ?? '').sort(),
    )
  expect(renderedRuntimeWorkItemRefs).toEqual(
    [...runtimeCase.capabilityActivation.activeWorkItemRefs].sort(),
  )
  await expect(runtimeMap.locator('[data-work-ingress-ref="ui-input:direct"]')).toHaveCount(1)
  await expect(runtimeMap.locator('[data-work-ingress-ref="ui-input:external-id"]')).toHaveCount(1)
  await expect(runtimeMap.locator('[data-work-ingress-ref="issue"]')).toHaveCount(1)
  const overlappingCapabilityTools = await runtimeMap
    .locator('.employee-toolbox-card')
    .evaluateAll((cards) => {
      const collisions: string[] = []
      for (let leftIndex = 0; leftIndex < cards.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < cards.length; rightIndex += 1) {
          const left = cards[leftIndex] as HTMLElement
          const right = cards[rightIndex] as HTMLElement
          if (
            left.closest('[data-capability-lane-id]') !== right.closest('[data-capability-lane-id]')
          )
            continue
          if (left.contains(right) || right.contains(left)) continue
          const leftRect = left.getBoundingClientRect()
          const rightRect = right.getBoundingClientRect()
          const overlapWidth =
            Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left)
          const overlapHeight =
            Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top)
          if (overlapWidth > 0.5 && overlapHeight > 0.5) {
            collisions.push(
              `${left.getAttribute('data-capability-tool-ref')} -> ${right.getAttribute('data-capability-tool-ref')}`,
            )
          }
        }
      }
      return collisions
    })
  expect(overlappingCapabilityTools).toEqual([])
  const runtimeReviewGate = runtimeMap.locator(
    '[data-review-option-ref="review-implementation-plan"]',
  )
  await expect(runtimeReviewGate).toHaveCount(0)
  await expect(runtimeMap.locator('[data-work-item-ref="analyze-implement"]')).toHaveCount(1)
  await expect(runtimeMap).not.toContainText('Human plan review')
  await expect(page.getByText('Work context', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Active digital employee capability map', { exact: true }),
  ).toBeVisible()
  const timeline = page.getByTestId('employee-work-timeline')
  await expect(timeline).toBeVisible()
  await expect(timeline.locator('.employee-execution-timeline__step').first()).toBeVisible({
    timeout: 30_000,
  })
  await timeline.locator('.employee-execution-timeline__step').first().click()
  await expect(timeline.getByText('Frozen input / program input', { exact: true })).toBeVisible()
  await expect(
    timeline.getByText('Deterministic output / program output', { exact: true }),
  ).toBeVisible()
})
