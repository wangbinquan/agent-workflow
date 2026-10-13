// RFC-372: author a real nested clarify configuration through the workflow editor,
// persist it via the original save path, then reopen and undo without flattening.
import { test, expect, type Page } from '@playwright/test'
import recording from '../packages/system-mocks/src/runtime/fixtures/rfc372-real-directions.json' with { type: 'json' }
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
test.setTimeout(90_000)
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  expect(response.ok, `${path}: ${response.status}`).toBe(true)
  return (await response.json()) as T
}
test.beforeAll(async () => {
  daemon = await startDaemon()
})
test.afterAll(async () => {
  await daemon?.stop()
})
async function openGate(page: Page) {
  await page.locator('.react-flow__node[data-id="clarify"]').click()
  await expect(page.getByRole('tree', { name: 'Question categories' })).toBeVisible()
}
async function saveName(page: Page, name: string) {
  await page.getByRole('textbox', { name: 'Category name' }).fill(name)
  await page.getByRole('button', { name: 'Save category', exact: true }).click()
}
test('nested categories can be created, renamed, deleted, undone and persisted without custom classification prompts', async ({
  page,
}) => {
  const agent = await api<{ id: string }>('/api/agents', {
    name: 'nested-category-authoring',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const definition = structuredClone(recording.workflow)
  for (const node of definition.nodes) {
    if (node.agentId) node.agentId = agent.id
    if (node.mindmap) {
      node.mindmap.categories = ['Service/API']
      node.mindmap.instructions = ''
    }
  }
  const workflow = await api<{ id: string }>('/api/workflows', {
    name: 'Nested category editor',
    definition,
  })
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.setViewportSize({ width: 1536, height: 1000 })
  await page.goto(`${daemon.baseUrl}/workflows/${workflow.id}`)
  await openGate(page)
  await page.getByRole('button', { name: 'Add subcategory', exact: true }).click()
  await saveName(page, 'Database')
  await page.getByRole('button', { name: 'Add subcategory', exact: true }).click()
  await saveName(page, 'SQL')
  await expect(page.getByRole('treeitem', { name: 'SQL', exact: true })).toHaveAttribute(
    'aria-level',
    '3',
  )
  await page.getByRole('treeitem', { name: 'Database', exact: true }).click()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await saveName(page, 'Storage')
  await page.getByRole('button', { name: 'Delete entire branch', exact: true }).click()
  await expect(page.getByRole('treeitem')).toHaveCount(1)
  await page.getByTestId('workflow-undo').click()
  await expect(page.getByRole('treeitem', { name: 'SQL', exact: true })).toHaveAttribute(
    'aria-level',
    '3',
  )
  const expected = [['Service/API'], ['Service/API', 'Storage'], ['Service/API', 'Storage', 'SQL']]
  await expect
    .poll(async () => {
      const current = await api<{
        definition: { nodes: Array<{ id: string; mindmap?: unknown }> }
      }>(`/api/workflows/${workflow.id}`)
      return current.definition.nodes.find((node) => node.id === 'clarify')?.mindmap
    })
    .toEqual({ categories: expected, instructions: '' })
  await page.reload()
  await openGate(page)
  await expect(page.getByRole('treeitem')).toHaveCount(3)
  await expect(page.getByRole('treeitem', { name: 'SQL', exact: true })).toHaveAttribute(
    'aria-level',
    '3',
  )
  await expect(page.getByRole('textbox', { name: 'Additional focus (optional)' })).toHaveValue('')
  await expect(
    page.getByText(
      'Classification, coverage and follow-up rules are built in. Add only the business topics you care about.',
    ),
  ).toBeVisible()
})
