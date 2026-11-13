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
// RFC-490: the reading pane is a region of the workspace — the panel beside (or in place
// of) the canvas in the panorama, the whole stage in the focused view. Never a modal.
const detail = (page: Page) => page.getByRole('region', { name: 'Answer and confirm', exact: true })
const panes = (page: Page) => page.locator('.mindmap-workspace__panes')
const SEARCH = 'Search categories, questions, options or answers'
interface Round {
  intermediaryNodeRunId: string
  kind: 'self' | 'cross'
  status: string
  questions: Array<{
    id: string
    title: string
    mindmap: { categoryPath: string[]; parentQuestionId?: string }
  }>
  /** RFC-372 O8: the running follow-up, or its last failure. */
  followup?: { state: 'running' | 'failed'; error?: { code: string } }
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
  // A newly entered round may still be loading. Wait for the workspace before
  // deciding whether its directory is hidden by the mobile layout.
  await expect(page.getByRole('region', { name: 'Clarify workspace', exact: true })).toBeVisible()
  const search = page.getByRole('textbox', { name: SEARCH })
  if (!(await search.isVisible()))
    await page
      .getByRole('radiogroup', { name: 'Clarify workspace', exact: true })
      .getByRole('radio', { name: 'Question outline', exact: true })
      .click()
  await search.fill(title)
  await page.getByRole('option').filter({ hasText: title }).click()
  // The panel is no layer over the outline: the search stays in reach wherever the
  // outline is shown (on a phone-wide workspace the answer tab has replaced it).
  if (await search.isVisible()) await search.fill('')
  await expect(detail(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
  // RFC-490 (C1): a selected node is read in the workspace's own panel, never in a modal.
  await expect(page.getByRole('dialog')).toHaveCount(0)
}
/**
 * The full-width reader. From a panel beside the canvas it is the panel's own button;
 * where the panel already has the whole stage it is the view switch — the "Answer and
 * confirm" tab, entered from the map, on a phone-wide workspace.
 */
async function focusedAnswers(page: Page) {
  const fromPanel = detail(page).getByRole('button', { name: 'Open in focused answers' })
  const viewSwitch = page
    .getByRole('radiogroup', { name: 'View', exact: true })
    .getByRole('radio', { name: 'Focused answers' })
  if (await fromPanel.isVisible()) await fromPanel.click()
  else if (await viewSwitch.isVisible()) await viewSwitch.click()
  else {
    const tabs = page.getByRole('radiogroup', { name: 'Clarify workspace', exact: true })
    await tabs.getByRole('radio', { name: 'Panorama', exact: true }).click()
    await tabs.getByRole('radio', { name: 'Answer and confirm', exact: true }).click()
  }
  await expect(page.locator('.mindmap-workspace__panes[data-split]')).toHaveCount(0)
  await expect(detail(page)).toBeVisible()
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
/** RFC-490: one row under the question asks a follow-up; "Write my own…" opens the empty form. */
async function deepen(page: Page, hint: string) {
  const direction = detail(page).getByRole('textbox', {
    name: 'What needs more detail? (optional)',
  })
  if (!(await direction.isVisible()))
    await detail(page).getByRole('button', { name: 'Write my own…', exact: true }).click()
  await direction.fill(hint)
  const response = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().endsWith('/followup'),
  )
  await detail(page).getByRole('button', { name: 'Generate follow-ups', exact: true }).click()
  return { response }
}
async function stop(page: Page, id: string) {
  await expect(
    page.getByText('This round’s answers are confirmed. Review decisions before submitting.'),
  ).toBeVisible()
  const response = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().endsWith(`/api/clarify/${id}/answers`),
  )
  await page.getByTestId('mindmap-review-open').click()
  await page.getByTestId('mindmap-review-submit').click()
  const result = await response
  expect(result.ok()).toBe(true)
  const payload = result.request().postDataJSON()
  expect(
    payload.answers.every((a: { confirmedBasis?: string }) => a.confirmedBasis?.startsWith('v2:')),
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

// WebKit nightly 40991904663 (macOS): the first attempt timed out in `deepen` waiting for the
// POST …/followup response, then passed on retry. Open in docs/audit-backlog.md (2026-10-30).
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
  // Mindmap requires explicit confirmation, so the normal questionnaire's keyboard hint
  // ("Enter jumps to next / submits") stays out of it. The mindmap has its own Enter
  // (RFC-490): the panel's primary action, which confirms the open answer and only then
  // moves on — it never carries an unconfirmed answer forward, and it never submits.
  await expect(page.getByTestId('clarify-keyboard-hint')).toHaveCount(0)
  await expect(page.getByLabel('Zoom level')).toHaveText(/^\d+(?:\.\d+)?%$/)
  expect(parseFloat((await page.getByLabel('Zoom level').textContent())!)).toBeGreaterThanOrEqual(
    80,
  )
  const firstTitle = recording.self.questions[0]!.title
  const surface = page.getByRole('img', { name: 'Clarification mindmap' })
  // The canvas root reports its camera as "x,y,zoom" (RFC-490 design §5.5). Take it once
  // late layout has stopped moving it: the same value on two reads.
  const map = page.locator('.mindmap-canvas')
  let mapCamera = ''
  await expect
    .poll(async () => {
      const camera = (await map.getAttribute('data-camera')) ?? ''
      const settled = /^-?[\d.]+,-?[\d.]+,[\d.]+$/.test(camera) && camera === mapCamera
      mapCamera = camera
      return settled
    })
    .toBe(true)
  const mapBounds = (await surface.boundingBox())!
  // RFC-490 (C1, C11): a node picked in the panorama opens in a panel beside the canvas.
  // Picked from its outline row, nothing asks the map to move to it.
  await page.getByRole('treeitem').filter({ hasText: firstTitle }).click()
  // One heading, complete long option text, and the canvas still there to the left.
  await expect(detail(page).getByRole('heading', { name: firstTitle })).toHaveCount(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(panes(page)).toHaveAttribute('data-split', 'side')
  await expect(surface).toBeVisible()
  const mapBeside = (await surface.boundingBox())!
  const panelBeside = (await detail(page).boundingBox())!
  expect(mapBeside.x).toBe(mapBounds.x)
  expect(mapBeside.width).toBeLessThan(mapBounds.width)
  expect(mapBeside.x + mapBeside.width).toBeLessThanOrEqual(panelBeside.x + 1)
  await readingFits(page)
  // The panel names its own keys.
  await expect(
    detail(page).getByText('Digits pick an option · Enter confirms and moves on'),
  ).toBeVisible()
  // Putting the panel away gives the canvas its size and its camera back.
  await detail(page)
    .getByRole('button', { name: /Back to mindmap/ })
    .click()
  await expect(detail(page)).toHaveCount(0)
  await expect.poll(() => surface.boundingBox()).toEqual(mapBounds)
  await expect(map).toHaveAttribute('data-camera', mapCamera)
  await select(page, firstTitle)
  await expect(panes(page)).toHaveAttribute('data-split', 'side')
  // RFC-490 (C8): the free-text box only exists once the custom row is chosen.
  await expect(page.getByTestId('clarify-custom-textarea')).toHaveCount(0)
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
  await page.getByTestId('mindmap-review-open').click()
  await expect(page.getByTestId('mindmap-review-submit')).toBeDisabled()
  await page.getByRole('button', { name: 'Back to answers', exact: true }).click()
  await answer(page, 'self', 2)
  expect((await first.response).ok()).toBe(true)
  await expect(
    detail(page).getByRole('heading', { name: recording.self.questions[2]!.title }),
  ).toBeVisible()
  await answer(page, 'self', 3)
  const invalid = await deepen(page, recording.hints.invalid)
  // RFC-372 O8: accepted at once; the round reports the background failure.
  expect((await invalid.response).status()).toBe(202)
  await expect
    .poll(async () => (await api<Round>(`/api/clarify/${self.intermediaryNodeRunId}`)).followup)
    .toMatchObject({ state: 'failed', error: { code: 'clarify-followup-invalid' } })
  await expect(page.getByRole('alert').last()).toContainText('Existing answers are kept')
  await page.getByText('Technical details', { exact: true }).click()
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
    const height = width <= 390 ? 844 : 1000
    await page.setViewportSize({ width, height })
    const back = page.getByRole('button', { name: /Back to mindmap/ })
    if (await back.isVisible()) await back.click()
    await select(page, firstTitle)
    await readingFits(page)
    // RFC-490 (C1): the reader is a panel of the workspace, not a modal. The measured
    // stage decides its form (design §4.1): wider than 760 px it sits beside the canvas,
    // otherwise it takes the canvas's place. Either way it stays inside the viewport.
    const panel = detail(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const stage = (await page.locator('.mindmap-workspace__stage').boundingBox())!
    const split = stage.width > 760 ? 'side' : 'full'
    if (width === 1440) expect(split).toBe('side')
    if (width <= 390) expect(split).toBe('full')
    await expect(panes(page)).toHaveAttribute('data-split', split)
    const panelBox = (await panel.boundingBox())!
    expect(panelBox.x).toBeGreaterThanOrEqual(0)
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(width)
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(height)
    if (split === 'side') {
      await expect(surface).toBeVisible()
      const canvasBox = (await surface.boundingBox())!
      expect(canvasBox.x + canvasBox.width).toBeLessThanOrEqual(panelBox.x + 1)
      expect(panelBox.width).toBeGreaterThanOrEqual(420)
    } else {
      await expect(surface).toBeHidden()
      expect(Math.abs(panelBox.x - stage.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(panelBox.width - stage.width)).toBeLessThanOrEqual(1)
    }
    // It is no layer over the page: it claims no modality, and a control outside it
    // (the footer's review button) is still the pointer's target while it is open.
    expect(await panel.getAttribute('aria-modal')).toBeNull()
    await page.getByTestId('mindmap-review-open').click({ trial: true })
    await page.screenshot({
      path: testInfo.outputPath(`recorded-panel-${width}.png`),
      fullPage: true,
    })
    await focusedAnswers(page)
    await expect(detail(page).getByRole('heading', { name: firstTitle })).toHaveCount(1)
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
  await select(page, firstTitle)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await readingFits(page)
  // Still the phone-wide workspace: the panel has the whole stage.
  await expect(detail(page)).toBeVisible()
  await expect(panes(page)).toHaveAttribute('data-split', 'full')
  await page.screenshot({ path: testInfo.outputPath('recorded-panel-dark.png'), fullPage: true })
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
  await select(page, firstTitle)
  await expect(page.getByTestId('clarify-custom-textarea')).toHaveValue(
    recording.self.answers[0]!.customText,
  )
  await expect(page.getByTestId('clarify-custom-textarea')).toBeDisabled()
  // A sealed question is only read: no follow-up row, no skip, nothing to confirm.
  await expect(detail(page).getByText('Follow up:', { exact: true })).toHaveCount(0)
  await expect(
    detail(page).getByRole('button', {
      name: /Write my own|Generate follow-ups|Not applicable|Decide later|Confirm/,
    }),
  ).toHaveCount(0)
  // RFC-490 (P6): the sealed round's footer leads to its summary and to the task result.
  await expect(page.getByTestId('mindmap-review-open')).toHaveText('View decision summary')
  await expect(page.getByTestId('clarify-view-task')).toHaveText('View task result')
  await expect(page.getByTestId('clarify-view-task')).toHaveAttribute(
    'href',
    new RegExp(`/tasks/${task.id}$`),
  )
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
