// Real acceptance source: daily AW task 01M4SK0C3RQH0FPWSBQHER3FES, completed
// with opencode-go/deepseek-v4.1-flash on 2026-10-13. Replay is regression evidence,
// not a substitute for that real model run. No API/application-state mocks.
import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import recording from '../packages/system-mocks/src/runtime/fixtures/rfc372-real-mindmap.json' with { type: 'json' }
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(300_000)
let daemon: DaemonHandle
let state: string
const detail = (page: Page) => page.locator('.mindmap-workspace__detail')
interface Round {
  intermediaryNodeRunId: string
  kind: 'self' | 'cross'
  status: string
  questions: Array<{
    id: string
    title: string
    mindmap: { categoryPath: string[]; parentQuestionId?: string }
  }>
}
async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = await response.text()
  expect(response.ok, `${path}: ${response.status} ${value}`).toBe(true)
  return value ? (JSON.parse(value) as T) : (null as T)
}
async function waitRound(taskId: string, kind: Round['kind']): Promise<Round> {
  let row: Round | undefined
  await expect
    .poll(
      async () => {
        row = (await api<Round[]>(`/api/clarify?status=awaiting_human&taskId=${taskId}`)).find(
          (r) => r.kind === kind,
        )
        return !!row
      },
      { timeout: 90_000 },
    )
    .toBe(true)
  return api(`/api/clarify/${row!.intermediaryNodeRunId}`)
}
async function select(page: Page, title: string) {
  if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape')
  // A newly entered round may still be loading. Wait for the workspace before
  // deciding whether its directory is hidden by the mobile layout.
  await expect(page.getByRole('region', { name: 'Clarify workspace', exact: true })).toBeVisible()
  const search = page.getByRole('textbox', { name: 'Search categories or questions' })
  if (!(await search.isVisible()))
    await page
      .getByRole('radiogroup', { name: 'Clarify workspace', exact: true })
      .getByRole('radio', { name: 'Question outline', exact: true })
      .click()
  await search.fill(title)
  await page.getByRole('option').filter({ hasText: title }).click()
  if (!(await page.getByRole('dialog').isVisible()) && (await search.isVisible()))
    await search.fill('')
  await expect(detail(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
}
async function answer(page: Page, round: 'self' | 'cross', index: number) {
  const question = recording[round].questions[index]!
  const answer = recording[round].answers.find((a) => a.questionId === question.id)!
  await select(page, question.title)
  for (const option of answer.selectedOptionIndices)
    await detail(page).locator(`input[data-option-idx="${option}"]`).check()
  if (answer.customText) {
    await page.getByTestId('clarify-custom-radio').check()
    await page.getByTestId('clarify-custom-textarea').fill(answer.customText)
  }
  await page.getByRole('button', { name: 'Confirm this answer', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Confirmed', exact: true })).toBeDisabled()
}
async function deepen(page: Page, hint: string) {
  const toggle = page.getByRole('button', { name: 'Deepen this question', exact: true })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await detail(page).getByRole('textbox', { name: 'What needs more detail? (optional)' }).fill(hint)
  const response = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().endsWith('/followup'),
  )
  await page.getByRole('button', { name: 'Ask follow-up', exact: true }).click()
  return { response }
}
async function stop(page: Page, id: string) {
  if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape')
  await expect(page.getByText('This round is reviewed and ready to submit.')).toBeVisible()
  const response = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().endsWith(`/api/clarify/${id}/answers`),
  )
  await page.getByTestId('clarify-submit-stop').click()
  await page.getByTestId('clarify-stop-confirm').click()
  const result = await response
  expect(result.ok()).toBe(true)
  const payload = result.request().postDataJSON()
  expect(
    payload.answers.every((a: { confirmedBasis?: string }) => a.confirmedBasis?.startsWith('v1:')),
  ).toBe(true)
}
async function readingFits(page: Page) {
  const dimensions = await detail(page).evaluate((element) => {
    const reading = element.querySelector('.mindmap-question__reading')!
    const text = [
      ...element.querySelectorAll<HTMLElement>(
        '.mindmap-question__title, .clarify-option__label, .clarify-option__description, .clarify-option__reason',
      ),
    ]
    return {
      pageFits: document.documentElement.scrollWidth <= window.innerWidth + 1,
      paneFits: element.scrollWidth <= element.clientWidth + 1,
      readingFits: reading.scrollWidth <= reading.clientWidth + 1,
      textFits: text.every(
        (el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1,
      ),
      textCount: text.length,
    }
  })
  expect(dimensions).toEqual({
    pageFits: true,
    paneFits: true,
    readingFits: true,
    textFits: true,
    textCount: expect.any(Number),
  })
  expect(dimensions.textCount).toBeGreaterThan(8)
}

test.beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'aw-rfc372-recorded-'))
  daemon = await startDaemon({
    stubMode: 'clarify',
    extraEnv: { CLARIFY_STUB_STATE: state, CLARIFY_STUB_MINDMAP_SCENARIO: 'recorded-live-design' },
  })
  // This recording replaces only the design task's model. Do not feed the
  // separate background memory distiller through the same recorded dialogue.
  await api('/api/config', { memoryDistillerEnabled: false }, 'PUT')
})
test.afterAll(async () => {
  await daemon?.stop()
  if (state) rmSync(state, { recursive: true, force: true })
})

test('recorded real-model task: preset directions, deep hierarchy, rich reading, confirmation and final document', async ({
  page,
}, testInfo) => {
  const designer = await api<{ id: string }>('/api/agents', {
    name: 'recorded-room-designer',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const reviewer = await api<{ id: string }>('/api/agents', {
    name: 'recorded-room-reviewer',
    description: '',
    outputs: ['document'],
    outputKinds: { document: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const definition = structuredClone(recording.workflow)
  for (const node of definition.nodes)
    if (node.agentId) node.agentId = node.id === 'designer' ? designer.id : reviewer.id
  const workflow = await api<{ id: string }>('/api/workflows', {
    name: '真实会议室脑图录制回放',
    description: 'Real model recording replay',
    definition,
  })
  const task = await api<{ id: string }>('/api/tasks', {
    name: '真实脑图 UX 回归',
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
  await page.setViewportSize({ width: 1440, height: 1000 })
  const self = await waitRound(task.id, 'self')
  expect(self.questions.map((q) => q.mindmap.categoryPath[0])).toEqual([
    '业务范围',
    '数据一致性',
    '体验与验收',
  ])
  await page.goto(`${daemon.baseUrl}/clarify/${self.intermediaryNodeRunId}`)
  // Mindmap requires explicit confirmation; it must not promise the normal
  // questionnaire's Enter-to-advance shortcut, which would skip confirmation.
  await expect(page.getByTestId('clarify-keyboard-hint')).toHaveCount(0)
  await expect(page.getByLabel('Zoom level')).toHaveText(/^\d+(?:\.\d+)?%$/)
  expect(parseFloat((await page.getByLabel('Zoom level').textContent())!)).toBeGreaterThanOrEqual(
    80,
  )
  const mapBounds = await page.getByRole('img', { name: 'Clarification mindmap' }).boundingBox()
  await select(page, recording.self.questions[0]!.title)
  // One heading, complete long option text, stable canvas size behind the reader.
  await expect(
    detail(page).getByRole('heading', { name: recording.self.questions[0]!.title }),
  ).toHaveCount(1)
  expect(await page.getByRole('img', { name: 'Clarification mindmap' }).boundingBox()).toEqual(
    mapBounds,
  )
  await readingFits(page)
  await detail(page).locator('input[data-option-idx="1"]').check()
  await page.getByRole('button', { name: 'Confirm this answer', exact: true }).click()
  await page.getByTestId('clarify-custom-radio').check()
  await page.getByTestId('clarify-custom-textarea').fill(recording.self.answers[0]!.customText)
  await expect(page.getByRole('button', { name: 'Confirm this answer', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Open in focused answers' }).click()
  await page.getByRole('button', { name: 'Confirm this answer', exact: true }).click()
  await answer(page, 'self', 1)
  const first = await deepen(page, recording.hints.first)
  await expect(page.locator('.mindmap-workspace__progress')).toContainText('Generating questions')
  await expect(page.getByTestId('clarify-submit-stop')).toBeDisabled()
  await answer(page, 'self', 2)
  expect((await first.response).ok()).toBe(true)
  await expect(
    detail(page).getByRole('heading', { name: recording.self.questions[2]!.title }),
  ).toBeVisible()
  await answer(page, 'self', 3)
  const invalid = await deepen(page, recording.hints.invalid)
  expect((await invalid.response).status()).toBe(422)
  await expect(page.getByRole('alert').last()).toContainText('missing mindmap category')
  expect((await api<Round>(`/api/clarify/${self.intermediaryNodeRunId}`)).questions).toHaveLength(4)
  const retry = await deepen(page, recording.hints.retry)
  expect((await retry.response).ok()).toBe(true)
  await answer(page, 'self', 4)
  const expanded = await api<Round>(`/api/clarify/${self.intermediaryNodeRunId}`)
  expect(expanded.questions[3]!.mindmap.parentQuestionId).toBe(expanded.questions[1]!.id)
  expect(expanded.questions[4]!.mindmap.parentQuestionId).toBe(expanded.questions[3]!.id)
  const deepest = page.getByRole('treeitem').filter({ hasText: recording.self.questions[4]!.title })
  await expect(deepest).toHaveAttribute('aria-level', '5')
  await expect(deepest).toHaveAttribute('data-parent-id', `q:${expanded.questions[3]!.id}`)
  await expect(page.getByTestId('clarify-draft-indicator')).toHaveAttribute(
    'data-draft-status',
    'saved',
  )
  await page.reload()
  await select(page, recording.self.questions[4]!.title)
  await expect(page.getByRole('button', { name: 'Confirmed', exact: true })).toBeDisabled()
  // Full reading remains available at laptop and phone widths in both themes.
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 1000 })
    if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape')
    else if (await page.getByRole('button', { name: /Back to mindmap/ }).isVisible())
      await page.getByRole('button', { name: /Back to mindmap/ }).click()
    await select(page, recording.self.questions[0]!.title)
    await readingFits(page)
    const modal = page.getByRole('dialog')
    await expect(modal).toHaveAttribute('aria-modal', 'true')
    const modalBox = (await modal.boundingBox())!
    expect(modalBox.x).toBeGreaterThanOrEqual(0)
    expect(modalBox.x + modalBox.width).toBeLessThanOrEqual(width)
    expect(modalBox.y + modalBox.height).toBeLessThanOrEqual(width <= 390 ? 844 : 1000)
    expect(Math.abs(modalBox.x - (width - modalBox.width) / 2)).toBeLessThanOrEqual(1)
    expect(
      Math.abs(modalBox.y - ((width <= 390 ? 844 : 1000) - modalBox.height) / 2),
    ).toBeLessThanOrEqual(1)
    await modal.getByRole('button', { name: 'Close', exact: true }).focus()
    await page.keyboard.press('Tab')
    expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`recorded-modal-${width}.png`),
      fullPage: true,
    })
    await page.getByRole('button', { name: 'Open in focused answers' }).click()
    await readingFits(page)
    if (width <= 390) {
      // Mobile reading must get the viewport, without a redundant desktop
      // toolbar or a second page scroll hiding the answer/submit actions.
      await expect(page.locator('.mindmap-workspace__outline-control')).toBeHidden()
      await expect(page.locator('.mindmap-workspace__toolbar')).toBeHidden()
      const pane = await detail(page).boundingBox()
      const footer = await page.locator('.clarify-detail__footer').boundingBox()
      expect(pane!.height).toBeGreaterThanOrEqual(300)
      expect(pane!.y + pane!.height).toBeLessThanOrEqual(footer!.y + 1)
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(844)
    }
    await page.screenshot({
      path: testInfo.outputPath(`recorded-reader-${width}.png`),
      fullPage: true,
    })
  }
  await api('/api/config', { theme: 'dark' }, 'PUT')
  await page.reload()
  await select(page, recording.self.questions[0]!.title)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await readingFits(page)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('recorded-modal-dark.png'), fullPage: true })
  await api('/api/config', { theme: 'light' }, 'PUT')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload()
  await stop(page, self.intermediaryNodeRunId)
  const cross = await waitRound(task.id, 'cross')
  await page.goto(`${daemon.baseUrl}/clarify/${cross.intermediaryNodeRunId}`)
  for (let i = 0; i < 3; i++) await answer(page, 'cross', i)
  await stop(page, cross.intermediaryNodeRunId)
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${task.id}`)).status, {
      timeout: 90_000,
    })
    .toBe('done')
  const result = await api<{
    runs: Array<{ id: string; nodeId: string; status: string }>
    outputs: Array<{ nodeRunId: string; port: string; value: string }>
  }>(`/api/tasks/${task.id}/node-runs`)
  const finalRun = result.runs.findLast((run) => run.nodeId === 'output' && run.status === 'done')!
  const document = result.outputs.find(
    (output) => output.nodeRunId === finalRun.id && output.port === 'document',
  )!.value
  expect(document.trim()).toBe(recording.finalDocument.trim())
  expect((await api<Round>(`/api/clarify/${self.intermediaryNodeRunId}`)).status).toBe('answered')
  await page.goto(`${daemon.baseUrl}/clarify/${self.intermediaryNodeRunId}`)
  await expect(
    page.getByText('This round was submitted. Confirmed answers are available to read.'),
  ).toBeVisible()
  await select(page, recording.self.questions[0]!.title)
  await expect(page.getByTestId('clarify-custom-textarea')).toHaveValue(
    recording.self.answers[0]!.customText,
  )
  await expect(page.getByTestId('clarify-custom-textarea')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Deepen this question' })).toHaveCount(0)
  const log = readFileSync(join(state, 'recorded-mindmap.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(log.map((event) => event.kind)).toEqual([
    'self-questions',
    'followup',
    'followup-missing-category',
    'followup',
    'self-final',
    'cross-questions',
    'cross-final',
  ])
  await testInfo.attach('real-recording-source', {
    body: JSON.stringify(
      {
        source: recording.source,
        replayTaskId: task.id,
        status: 'done',
        questionCounts: [5, 3],
        modelBoundaryCalls: log,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
  await testInfo.attach('recorded-final-document', { body: document, contentType: 'text/markdown' })
})
