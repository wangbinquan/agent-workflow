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
      responsibilityLanes: Array<{ laneId: string; kind: 'spine' | 'branch' }>
    }>
    workItems: Array<{
      workItemRef: string
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
const TYPE_REF = 'development@2'
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
  const bindings: Array<{
    workItemRef: string
    slotRef: string
    registrationRef: ExactRef
  }> = []

  for (const item of typePackage.authoringManifest.workItems) {
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
  const employee = await requestJson<{ id: string }>(
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/employees`,
    {
      method: 'POST',
      body: {
        name: employeeName,
        jobTemplateRef: jobRef.ref,
        enabled: true,
        workScope: { kind: 'repository', repositoryId },
        toolOverrides: [],
        collaborationOverrides: [],
      },
    },
  )
  await requestJson(`/api/digital-employees/${encodeURIComponent(employee.id)}/publish`, {
    method: 'POST',
    body: {},
  })
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
  const responsibilityGraph = page.getByTestId('digital-employee-responsibility-graph')
  await expect(responsibilityGraph).toBeVisible()
  await expect(page.locator('[data-testid^="employee-work-item-"]')).toHaveCount(18)
  await expect(responsibilityGraph.locator('.employee-graph__lane-bg--spine')).toHaveCount(2)
  await expect(responsibilityGraph.locator('.employee-graph__lane-bg--branch')).toHaveCount(5)
  await expect(responsibilityGraph.locator('.employee-graph__dispatch-trunk')).toHaveCount(1)
  await expect(
    responsibilityGraph.locator('path[data-from="observe-mr"][data-to="collect-pipeline"]'),
  ).toHaveCount(1)
  await expect(
    responsibilityGraph.locator(
      'path.employee-graph__edge--loop[data-from="repair-pipeline"][data-to="repair-pipeline"]',
    ),
  ).toHaveCount(1)
  await expect(
    responsibilityGraph.locator('path[data-from="classify-pipeline"][data-to="delegate"]'),
  ).toHaveCount(1)
  await expect(
    responsibilityGraph.locator('path[data-from="evaluate-ready"][data-to="wait-merge"]'),
  ).toHaveCount(1)
  await expect(
    responsibilityGraph.locator('path[data-from="observe-mr"][data-to="wait-merge"]'),
  ).toHaveCount(0)
  const horizontalOverflow = await responsibilityGraph.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  )
  expect(horizontalOverflow).toBeLessThanOrEqual(1)
  await expect(page.getByText(employeeName, { exact: true })).toBeVisible()

  await page.goto(`${daemon.baseUrl}/tasks/employee-cases/new`)
  await expect(
    page.getByRole('heading', { name: 'Assign work to a digital employee' }),
  ).toBeVisible()
  await expect(page.getByRole('combobox').first()).toHaveAccessibleName(employeeName)
  const repositoryPicker = page.getByRole('combobox').nth(1)
  await expect(repositoryPicker).toBeVisible()
  await repositoryPicker.click()
  await page.getByRole('option', { name: new RegExp(PROJECT_PATH) }).click()
  await page.getByRole('radio', { name: 'Request and files', exact: true }).click()
  await page
    .getByLabel('Requirement or problem body')
    .fill('Implement the requested change and keep the supplied acceptance document in Git.')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'acceptance.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Acceptance\nThe change is ready for committer review.\n'),
  })
  await page
    .getByRole('textbox', { name: 'Repository target path *', exact: true })
    .fill('docs/acceptance.md')

  const launchRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /\/api\/digital-employees\/[^/]+\/cases$/.test(new URL(request.url()).pathname),
  )
  await page.getByRole('button', { name: 'Assign work', exact: true }).click()
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
  await expect(page.getByTestId('digital-employee-responsibility-graph')).toBeVisible()
  await expect(page.locator('[data-testid^="employee-work-item-"]')).toHaveCount(18)
  await expect(page.getByText('Work context', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Current responsibility and full lifecycle', { exact: true }),
  ).toBeVisible()

  await page.goto(`${daemon.baseUrl}/tasks?category=digital-employee`)
  await expect(page.getByTestId('digital-employee-task-list')).toBeVisible()
  await expect(page.getByTestId(`digital-employee-task-${caseId}`)).toBeVisible()
})
