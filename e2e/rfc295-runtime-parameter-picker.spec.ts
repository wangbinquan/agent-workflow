// RFC-295 — live-daemon browser proof for the public runtime-parameter picker.
//
// These flows deliberately use no page.route mocks: the field-adjacent picker
// writes through the real workflow autosave / Webhook create APIs, then a full
// reload proves the canonical token survived persistence.

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let agentId = ''
let workflowId = ''
let endpointId = ''

test.setTimeout(60_000)

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    throw new Error(`RFC-295 fixture ${path} failed (${response.status}): ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function chooseParameter(page: Page, pickerTestId: string, query: string): Promise<void> {
  await page.getByTestId(pickerTestId).click()
  const popover = page.locator('[data-runtime-parameter-popover]')
  await expect(popover).toBeVisible()
  await popover.getByRole('combobox').fill(query)
  await popover.getByRole('option', { name: new RegExp(query.replaceAll('_', '.*'), 'i') }).click()
  await expect(popover).toBeHidden()
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  const agent = await postJson<{ id: string }>('/api/agents', {
    name: 'rfc295-picker-agent',
    description: 'Zero-port Agent for the Webhook authoring flow',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  agentId = agent.id
  const workflow = await postJson<{ id: string }>('/api/workflows', {
    name: 'rfc295-picker-workflow',
    description: 'Runtime parameter picker live-daemon fixture',
    definition: {
      $schema_version: 5,
      inputs: [],
      nodes: [
        {
          id: 'picker_agent',
          kind: 'agent-single',
          agentId,
          agentName: 'rfc295-picker-agent',
          promptTemplate: 'Use ',
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
  })
  workflowId = workflow.id
  const endpoint = await postJson<{ id: string }>('/api/webhook-endpoints', {
    name: 'rfc295-picker-endpoint',
  })
  endpointId = endpoint.id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('Workflow Agent picker autosaves through the real PUT and reloads the token', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/workflows/${workflowId}`)
  await expect(page.locator('.react-flow__node[data-id="picker_agent"]')).toBeVisible()
  await page.locator('.react-flow__node[data-id="picker_agent"]').click()
  await expect(page.getByTestId('agent-runtime-parameter-picker')).toBeVisible()
  await expect(page.getByText('{{trigger.webhook.comment_text}}', { exact: true })).toHaveCount(0)
  const prompt = page.getByRole('textbox', { name: 'Prompt template' })
  await prompt.focus()
  await prompt.press('End')

  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/workflows/${workflowId}`,
  )
  await chooseParameter(page, 'agent-runtime-parameter-picker', '__repo_path__')
  expect((await saveResponse).ok()).toBe(true)
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  await page.reload()
  await expect(page.locator('.react-flow__node[data-id="picker_agent"]')).toBeVisible()
  await page.locator('.react-flow__node[data-id="picker_agent"]').click()
  await expect(page.getByRole('textbox', { name: 'Prompt template' })).toHaveValue(
    'Use {{__repo_path__}}',
  )
})

test('Webhook Agent picker creates through the real POST and reloads the XOR description', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/webhooks?tab=triggers`)
  const create = page.getByTestId('webhook-trigger-new')
  await expect(create).toBeEnabled()
  await create.click()
  await expect(page.getByTestId('webhook-trigger-dialog')).toBeVisible()

  await page.getByTestId('wt-name').fill('RFC-295 picker trigger')
  await expect(page.getByTestId('wt-endpoint')).toContainText('rfc295-picker-endpoint')
  await page.getByTestId('wt-scope-prefix').fill('platform/')
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('webhook-trigger-step-events')).toBeVisible()
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('webhook-trigger-step-target')).toBeVisible()

  await page.getByTestId('wt-launch-kind-agent').click()
  await page.getByTestId('wt-target').click()
  await page.getByRole('option', { name: 'rfc295-picker-agent', exact: true }).click()
  await expect(page.getByTestId('wt-description')).toBeVisible()
  await page.getByTestId('wt-description').fill('Handle ')
  await chooseParameter(page, 'wt-description-parameter', 'repo_path')
  await expect(page.getByTestId('wt-description')).toHaveValue(
    'Handle {{trigger.webhook.repo_path}}',
  )

  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('webhook-trigger-step-review')).toBeVisible()
  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/webhook-triggers',
  )
  await page.getByTestId('webhook-trigger-save').click()
  const response = await saveResponse
  expect(response.ok()).toBe(true)
  const created = (await response.json()) as {
    id: string
    endpointId: string
    launchPayload: { description?: string; inputs?: Record<string, string> }
  }
  expect(created.endpointId).toBe(endpointId)
  expect(created.launchPayload).toMatchObject({
    description: 'Handle {{trigger.webhook.repo_path}}',
  })
  expect(created.launchPayload.inputs).toBeUndefined()

  await page.reload()
  await page.getByTestId(`webhook-trigger-edit-${created.id}`).click()
  await page.getByTestId('stepper-step-target').click()
  await expect(page.getByTestId('wt-description')).toHaveValue(
    'Handle {{trigger.webhook.repo_path}}',
  )
})

test('RFC-303 terminal protection is conditional, persists, and remains usable at 390px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/webhooks?tab=triggers`)
  await expect(page.getByTestId('webhook-trigger-new')).toBeEnabled()
  await page.getByTestId('webhook-trigger-new').click()

  await page.getByTestId('wt-name').fill('RFC-303 terminal protection')
  await page.getByTestId('wt-scope-prefix').fill('platform/')
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('webhook-trigger-step-events')).toBeVisible()
  await page.getByTestId('wt-cancel-on-mr-terminal').click()
  await expect(page.getByTestId('wt-cancel-on-mr-terminal')).toBeChecked()

  await page.getByTestId('wt-event-mr_closed').click()
  await expect(page.getByTestId('wt-cancel-on-mr-terminal')).toBeHidden()
  await expect(page.getByTestId('wt-terminal-policy-error')).toBeHidden()
  await expect(page.getByTestId('stepper-next')).toBeEnabled()
  await page.getByTestId('wt-event-mr_closed').click()
  await expect(page.getByTestId('wt-cancel-on-mr-terminal')).not.toBeChecked()
  await page.getByTestId('wt-cancel-on-mr-terminal').click()
  await page.getByTestId('stepper-next').click()

  await page.getByTestId('wt-target').click()
  await page.getByRole('option', { name: 'rfc295-picker-workflow', exact: true }).click()
  await page.getByTestId('stepper-next').click()
  await expect(page.getByTestId('webhook-trigger-step-review')).toContainText(
    'Stop running tasks when the MR / PR is closed or merged',
  )

  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/webhook-triggers',
  )
  await page.getByTestId('webhook-trigger-save').click()
  const response = await saveResponse
  expect(response.ok()).toBe(true)
  const created = (await response.json()) as { id: string; cancelOnMrTerminal: boolean }
  expect(created.cancelOnMrTerminal).toBe(true)
  await expect(page.getByTestId(`webhook-trigger-${created.id}`)).toContainText(
    'Stops on MR / PR terminal state',
  )

  await page.reload()
  await page.getByTestId(`webhook-trigger-edit-${created.id}`).click()
  await page.getByTestId('stepper-step-events').click()
  await expect(page.getByTestId('wt-cancel-on-mr-terminal')).toBeChecked()
})
