// RFC-310 browser journey for the current Digital Employee OS.
//
// The browser owns the user boundary: a published employee is visible on the
// fixed responsibility map, body and repository-bound files can be assigned,
// and the resulting stateful case appears in the unified task list. The full
// external-ID -> MR -> cross-repository employee -> approval -> large pipeline
// evidence -> repair -> merged lifecycle is covered by the backend system-mock
// E2E, where those deterministic participants can be asserted without UI races.

import { expect, test, type Page } from '@playwright/test'

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
const TYPE_REF = 'development@5'
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
    const contract = typePackage.workContracts.find(
      (candidate) =>
        candidate.contractId === item.workContractRef.contractId &&
        candidate.version === item.workContractRef.version,
    )
    if (contract === undefined) throw new Error(`missing work contract for ${item.workItemRef}`)
    for (const role of item.toolRoleGroups) {
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
  await expect(responsibilityMap.locator('[data-work-item-ref]')).toHaveCount(20)
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
    await responsibilityMap
      .locator('.employee-toolbox-card strong')
      .evaluateAll((labels) =>
        labels.flatMap((label) =>
          label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1
            ? [label.textContent]
            : [],
        ),
      ),
  ).toEqual([])
  const responsibilityCardWidths = await responsibilityMap
    .locator('.employee-toolbox-card')
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
  await expect(page.getByLabel('Template name')).toHaveCount(0)
  await expect(page.getByLabel('Description')).toHaveCount(0)
  await templateEditor.locator('[data-work-item-ref="analyze-implement"]').click()
  const newTemplateDutyDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(newTemplateDutyDialog).toBeVisible()
  await newTemplateDutyDialog.getByRole('combobox').click()
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
  expect((jobMapBox?.y ?? 0) + (jobMapBox?.height ?? 0)).toBeLessThanOrEqual(900)
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
  await expect(page.getByTestId('employee-case-summary-content')).toContainText(
    'docs/acceptance.md',
  )
  await page.getByTestId('wizard-launch').click()
  const submitted = await launchRequest
  expect(submitted.postDataJSON()).toMatchObject({
    kind: 'body-and-files',
    target: { repositoryId },
    body: 'Implement the requested change and keep the supplied acceptance document in Git.',
    uploads: [{ targetPath: 'docs/acceptance.md' }],
  })

  await page.waitForURL(/\/tasks\/employee-cases\/[0-9A-Z]+$/)
  const caseId = page.url().split('/').at(-1)!
  await expect(page.getByRole('heading', { name: employeeName, exact: true })).toBeVisible()
  const runtimeMap = page.getByTestId('employee-toolbox-responsibility-map')
  await expect(runtimeMap).toBeVisible()
  await expect(runtimeMap.locator('[data-work-item-ref]')).toHaveCount(20)
  await expect(page.getByText('Work context', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Complete digital employee capability map', { exact: true }),
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

  await page.goto(`${daemon.baseUrl}/tasks?type=digital-employee`)
  await expect(page.getByTestId('task-operations-list')).toBeVisible()
  await expect(page.getByTestId(`task-row-${caseId}`)).toBeVisible()
})
