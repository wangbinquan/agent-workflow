// Daily AW real-model task 01M4SZ1T6KTD54544KPDVVT7NX is the source.
// This reproduces accepted model responses; it never mocks application APIs.
import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import recording from '../packages/system-mocks/src/runtime/fixtures/rfc372-real-directions.json' with { type: 'json' }
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)
let daemon: DaemonHandle
let state: string
async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  expect(response.ok, `${path}: ${response.status} ${text}`).toBe(true)
  return text ? (JSON.parse(text) as T) : (null as T)
}
interface Round {
  intermediaryNodeRunId: string
  status: string
  questions: Array<{
    id: string
    title: string
    mindmap: { categoryPath: string[]; parentQuestionId?: string }
  }>
}
const dialog = (page: Page) => page.getByRole('dialog')
async function close(page: Page) {
  if (await dialog(page).isVisible())
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click()
}
async function select(page: Page, title: string) {
  await close(page)
  await page.getByRole('textbox', { name: 'Search categories or questions' }).fill(title)
  await page.getByRole('option').filter({ hasText: title }).click()
  await expect(dialog(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
}
async function answer(page: Page, id: string) {
  const question = recording.questions.find((q) => q.id === id)!
  const value = recording.answers.find((a) => a.questionId === id)!
  await select(page, question.title)
  for (const index of value.selectedOptionIndices)
    await dialog(page).locator(`input[data-option-idx="${index}"]`).check()
  if (value.customText) {
    await page.getByTestId('clarify-custom-radio').check()
    await page.getByTestId('clarify-custom-textarea').fill(value.customText)
  }
  await dialog(page).getByRole('button', { name: 'Confirm this answer', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: 'Confirmed', exact: true })).toBeDisabled()
}
test.beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'aw-rfc372-directions-'))
  daemon = await startDaemon({
    stubMode: 'clarify',
    extraEnv: {
      CLARIFY_STUB_STATE: state,
      CLARIFY_STUB_MINDMAP_SCENARIO: 'recorded-live-directions',
    },
  })
  await api('/api/config', { memoryDistillerEnabled: false }, 'PUT')
})
test.afterAll(async () => {
  await daemon?.stop()
  if (state) rmSync(state, { recursive: true, force: true })
})
test('real recorded directions: category peers, question child, root category, modal recovery and final document', async ({
  page,
}, testInfo) => {
  const agent = await api<{ id: string }>('/api/agents', {
    name: 'recorded-database-design',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const definition = structuredClone(recording.workflow)
  for (const node of definition.nodes) if (node.agentId) node.agentId = agent.id
  const workflow = await api<{ id: string }>('/api/workflows', {
    name: 'Recorded database directions',
    definition,
  })
  const task = await api<{ id: string }>('/api/tasks', {
    name: 'Recorded category guidance',
    workflowId: workflow.id,
    scratch: true,
    inputs: { topic: recording.topic },
  })
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  let round: Round | undefined
  await expect
    .poll(
      async () => {
        round = (await api<Round[]>(`/api/clarify?taskId=${task.id}&status=awaiting_human`))[0]
        return !!round
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  const roundId = round!.intermediaryNodeRunId
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${daemon.baseUrl}/clarify/${roundId}`)
  for (const question of recording.questions.slice(0, 2)) await answer(page, question.id)
  for (const stage of recording.stages) {
    await close(page)
    const search = page.getByRole('textbox', { name: 'Search categories or questions' })
    await search.fill('')
    if (stage.kind === 'deep') {
      await select(
        page,
        recording.questions.find((q) => q.id === stage.contextQuestionIds.at(-1))!.title,
      )
      await dialog(page).getByRole('button', { name: 'Deepen this question' }).click()
      await dialog(page).getByLabel('What needs more detail? (optional)').fill(stage.instruction)
    } else {
      if (stage.kind === 'root')
        await page.getByRole('button', { name: 'Question outline', exact: true }).click()
      else
        await page
          .getByRole('treeitem')
          .filter({ has: page.getByText('性能', { exact: true }) })
          .click()
      await dialog(page)
        .getByLabel('What else should AI consider? (optional)')
        .fill(stage.instruction)
    }
    const response = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/followup'),
    )
    await dialog(page)
      .getByRole('button', {
        name: stage.kind === 'deep' ? 'Ask follow-up' : 'Add questions in this direction',
        exact: true,
      })
      .click()
    await close(page)
    await page.getByRole('button', { name: 'View generating branch' }).click()
    await expect(dialog(page).getByRole('button', { name: 'Cancel follow-up' })).toBeVisible()
    const result = await response
    expect(result.ok()).toBe(true)
    const request = result.request().postDataJSON()
    if (stage.kind === 'deep') expect(request.parentQuestionId).toBeTruthy()
    else {
      expect(request.categoryPath).toEqual(stage.categoryPath)
      expect(request.parentQuestionId).toBeUndefined()
    }
    const current = await api<Round>(`/api/clarify/${roundId}`)
    for (const id of stage.questionIds) {
      const recorded = recording.questions.find((q) => q.id === id)!
      const actual = current.questions.find((q) => q.title === recorded.title)!
      expect(actual.mindmap.categoryPath).toEqual(recorded.mindmap.categoryPath)
      if (stage.kind === 'deep')
        expect(actual.mindmap.parentQuestionId).toBe(request.parentQuestionId)
      else expect(actual.mindmap.parentQuestionId).toBeUndefined()
      await answer(page, id)
    }
  }
  await close(page)
  await expect(page.getByTestId('clarify-draft-indicator')).toHaveAttribute(
    'data-draft-status',
    'saved',
  )
  await page.reload()
  await expect(page.getByText('This round is reviewed and ready to submit.')).toBeVisible()
  await page.getByRole('button', { name: 'Fit all', exact: true }).click()
  await page.screenshot({
    path: testInfo.outputPath('recorded-directions-reviewed.png'),
    fullPage: true,
  })
  await page.getByTestId('clarify-submit-stop').click()
  await page.getByTestId('clarify-stop-confirm').click()
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${task.id}`)).status, {
      timeout: 60_000,
    })
    .toBe('done')
  const result = await api<{
    runs: Array<{ id: string; nodeId: string; status: string }>
    outputs: Array<{ nodeRunId: string; port: string; value: string }>
  }>(`/api/tasks/${task.id}/node-runs`)
  const output = result.runs.findLast((run) => run.nodeId === 'output' && run.status === 'done')!
  expect(
    result.outputs
      .find((value) => value.nodeRunId === output.id && value.port === 'design')!
      .value.trim(),
  ).toBe(recording.finalDocument.trim())
  expect(
    readFileSync(join(state, 'recorded-directions.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).kind),
  ).toEqual(['initial', 'category', 'deep', 'root', 'final'])
  await testInfo.attach('real-source', {
    body: JSON.stringify(recording.source),
    contentType: 'application/json',
  })
})
