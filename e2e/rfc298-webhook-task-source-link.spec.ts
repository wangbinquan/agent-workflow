// RFC-298 — real daemon/API/browser seam for webhook task source navigation.
// The fixture plants the same frozen context produced at webhook launch, then
// proves getTask derives the minimal wire value and the task header renders
// controlled copy after the ID at desktop and 390px widths.

import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'

import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

const COMMENT_URL = 'https://gitlab.example/platform/api/-/merge_requests/42#note_17'

let daemon: DaemonHandle
let webhookTaskId = ''
let ordinaryTaskId = ''

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`RFC-298 fixture ${path} failed (${response.status}): ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  const workflow = await postJson<{ id: string }>('/api/workflows', {
    name: 'RFC-298 source-link fixture',
    description: 'Empty deterministic workflow for task detail rendering',
    definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
  })
  const webhookTask = await postJson<{ id: string }>('/api/tasks', {
    workflowId: workflow.id,
    name: 'Webhook source task',
    scratch: true,
    inputs: {},
  })
  const ordinaryTask = await postJson<{ id: string }>('/api/tasks', {
    workflowId: workflow.id,
    name: 'Ordinary task without source',
    scratch: true,
    inputs: {},
  })
  webhookTaskId = webhookTask.id
  ordinaryTaskId = ordinaryTask.id

  const context = JSON.stringify({
    trigger: {
      webhook: {
        event_type: 'note',
        provider: 'gitlab',
        project_web_url: 'https://gitlab.example/platform/api',
        mr_url: 'https://gitlab.example/platform/api/-/merge_requests/42',
        comment_url: COMMENT_URL,
        comment_text: 'raw fixture text must never reach the browser',
      },
    },
  })
  runSqlite(
    join(daemon.home, 'db.sqlite'),
    `UPDATE tasks SET trigger_context_json=${sqlLiteral(context)} WHERE id=${sqlLiteral(webhookTaskId)};`,
  )
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('detail API and desktop header expose only the controlled comment link after the ID', async ({
  page,
}) => {
  const response = await fetch(`${daemon.baseUrl}/api/tasks/${webhookTaskId}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expect(response.ok).toBe(true)
  const detail = (await response.json()) as Record<string, unknown>
  expect(detail.webhookSourceLink).toEqual({ kind: 'comment', url: COMMENT_URL })
  expect(detail).not.toHaveProperty('triggerContextJson')
  expect(detail).not.toHaveProperty('triggerContext')
  expect(JSON.stringify(detail)).not.toContain('raw fixture text')

  await primeAuth(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${daemon.baseUrl}/tasks/${webhookTaskId}`)
  await expect(page.getByRole('heading', { name: /Webhook source task/ })).toBeVisible()

  const source = page.getByTestId('task-webhook-source')
  const link = page.getByTestId('task-webhook-source-link')
  await expect(source).toBeVisible()
  await expect(link).toHaveText('Open original comment ↗')
  await expect(link).toHaveAttribute('href', COMMENT_URL)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link).not.toHaveAttribute('title', /.+/)
  await expect(source).not.toContainText('https://')

  expect(
    await page.evaluate(() => {
      const code = document.querySelector('.task-detail__id code')
      const sourceGroup = document.querySelector('[data-testid="task-webhook-source"]')
      if (code === null || sourceGroup === null) return false
      return Boolean(code.compareDocumentPosition(sourceGroup) & Node.DOCUMENT_POSITION_FOLLOWING)
    }),
  ).toBe(true)
  expect(await source.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap')
})

test('390px layout keeps the source group contained and ordinary tasks render no placeholder', async ({
  page,
}) => {
  await primeAuth(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${daemon.baseUrl}/tasks/${webhookTaskId}`)
  const source = page.getByTestId('task-webhook-source')
  await expect(source).toBeVisible()
  const box = await source.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)

  await page.goto(`${daemon.baseUrl}/tasks/${ordinaryTaskId}`)
  await expect(page.getByRole('heading', { name: /Ordinary task without source/ })).toBeVisible()
  await expect(page.getByTestId('task-webhook-source')).toHaveCount(0)
  await expect(page.getByTestId('task-webhook-source-link')).toHaveCount(0)
  await expect(page.locator('.task-detail__id')).not.toContainText('·')
})
