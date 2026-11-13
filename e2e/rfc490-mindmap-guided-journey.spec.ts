// RFC-490 — guided thinking and the panorama panel, end to end.
//
// One real first-round mindmap task driven through the browser: real daemon, real
// persistence, real TaskEngine. Only the model CLI is the deterministic stand-in
// (`CLARIFY_STUB_MINDMAP=1`: two opening questions under "Architecture", then one
// generated question per follow-up request). No API response or application state is
// mocked; the prompt the agent finally receives is read back from the stand-in.
//
// Acceptance criteria covered (design/RFC-490-mindmap-guided-thinking-and-panorama/proposal.md §5):
//   AC02  "Not applicable" and "Decide later" each take one click and confirm; a note
//         keeps the skip confirmed; "Answer instead" brings the earlier answer back; a
//         round whose questions are all confirmed or skipped can be submitted.
//   AC03  a skip survives the draft, a refresh, sealing and the final prompt, which tells
//         the two skips apart from "not answered".
//   AC05  a configured category nobody asked about is visible in the first round, takes
//         questions in place (filed under it), and is read-only once the round is sealed.
//   AC06  once everything is handled the workspace lists what is worth another look, each
//         entry with an action that lands on the right node; a sealed round lists nothing.
//   AC07  the review summary matches the answers, "Needs attention" keeps only what needs
//         it, entries are grouped by category, and the next-step choice stays in view.
//   AC08  at 1440 px the whole map fits the canvas width at the readable scale; at 390 px
//         it is laid out in a single column.
//   AC10  a canvas node opens beside the canvas instead of in a modal; the canvas stays
//         usable; the picked card stays in view; Escape returns the keyboard; closing
//         restores the canvas size and camera (or keeps the place the reader moved to).
//   AC11  follow-ups have one name and one row of entries; "Confirm and next" confirms and
//         moves on in one click; Enter does the same; a digit only picks.
//   AC13  a sealed round's footer leads to the decision summary and to the task result.
//   AC15  the journey itself: skips, an empty category filled, answering in the panel.
// It also passes through AC04 (a generated question says where it came from).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKFLOW_SCHEMA_VERSION } from '../packages/shared/src/schemas/workflow'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(300_000)

const TASK_NAME = 'Order status design'
const TOPIC = 'order_status enum'
// "Architecture" is where the stand-in files its opening questions; the other two are
// configured on the clarify node and nobody has asked about them yet.
const CATEGORIES = ['Architecture', 'Operations', 'Compliance']
const DB_QUESTION = 'Which database should we use?'
const LANGUAGE_QUESTION = 'Pick languages'
// The stand-in answers every follow-up request with this one question.
const GENERATED_QUESTION = 'Which consistency guarantee?'
const DB_RATIONALE = 'Order states need relational integrity.'
const OPERATIONS_DIRECTION = 'Cover backups and on-call ownership.'
const NOT_APPLICABLE_NOTE = 'Backups are owned by the platform team.'
const EVIDENCE_DIRECTION = 'Which assumptions behind this choice remain unverified?'
const REVIEW_COMPLETE = 'This round’s answers are confirmed. Review decisions before submitting.'
// Design §5.1 and §5.4: the readable scale and the width of a card, in world units.
const READABLE_SCALE = 0.85
const CARD_WIDTH = 236

let daemon: DaemonHandle
let state: string
let promptOut: string

interface Question {
  id: string
  title: string
  mindmap: { categoryPath: string[]; parentQuestionId?: string }
}
interface Round {
  intermediaryNodeRunId: string
  iteration: number
  status: string
  questions: Question[]
}
interface SubmittedAnswer {
  questionId: string
  selectedOptionIndices: number[]
  customText: string
  confirmedBasis?: string
  decision?: { status?: string; rationale?: string }
}

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
const edge = (
  id: string,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
) => ({
  id,
  source: { nodeId: source, portName: sourcePort },
  target: { nodeId: target, portName: targetPort },
})

const panelOf = (page: Page) =>
  page.getByRole('region', { name: 'Answer and confirm', exact: true })
const surfaceOf = (page: Page) =>
  page.getByRole('img', { name: 'Clarification mindmap', exact: true })
/** The canvas root: its data attributes are the read-only observations of design §5.5. */
const mapOf = (page: Page) => page.locator('.mindmap-canvas')
/** An outline row by what it shows: a category's name, or a question's "Qn". */
const row = (page: Page, label: string) =>
  page
    .getByRole('tree', { name: 'Question outline' })
    .getByRole('treeitem')
    .filter({ has: page.getByText(label, { exact: true }) })

async function cameraOf(map: Locator): Promise<{ x: number; y: number; zoom: number }> {
  const [x, y, zoom] = ((await map.getAttribute('data-camera')) ?? '').split(',').map(Number)
  return { x: x ?? Number.NaN, y: y ?? Number.NaN, zoom: zoom ?? Number.NaN }
}
/** The camera once late layout has stopped moving it: the same value on two reads. */
async function settledCamera(map: Locator): Promise<string> {
  let seen = ''
  await expect
    .poll(async () => {
      const current = (await map.getAttribute('data-camera')) ?? ''
      const settled = current !== '' && current === seen
      seen = current
      return settled
    })
    .toBe(true)
  return seen
}
/**
 * A real pointer click on the root card. The root is laid out at the world origin, so
 * the camera offset is its centre on the canvas. The first frame after a layout may not
 * have drawn (and hit-mapped) the cards yet, hence the retry.
 */
async function pickRootOnCanvas(page: Page): Promise<void> {
  await expect(async () => {
    const { x, y } = await cameraOf(mapOf(page))
    await surfaceOf(page).click({ position: { x, y } })
    await expect(panelOf(page)).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}
/** The panel is showing this question: two generated questions share one title. */
async function expectQuestion(page: Page, number: number, title: string): Promise<void> {
  await expect(panelOf(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(panelOf(page).getByText(`Q${number}`, { exact: true })).toBeVisible()
}
/** The answered questions of a prompt's "## Clarify Q&A" block, in the stand-ins' own reading. */
function clarifyAnswersIn(prompt: string): { title: string; answer: string }[] {
  return [...prompt.matchAll(/- Q: ([^\n]+)\n[^\n]*\n {2}Answer: ([^\n]*)/g)].map((match) => ({
    title: match[1] ?? '',
    answer: match[2] ?? '',
  }))
}

test.beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'aw-rfc490-journey-'))
  // The stand-in writes every prompt it is given to this file, so after the task is done
  // it holds the prompt of the final run.
  promptOut = join(state, 'last-prompt.txt')
  daemon = await startDaemon({
    stubMode: 'clarify',
    extraEnv: {
      CLARIFY_STUB_STATE: join(state, 'rounds'),
      CLARIFY_STUB_MINDMAP: '1',
      AW_STUB_PROMPT_OUT: promptOut,
    },
  })
  // The background memory distiller drives the same stand-in; it must not overwrite the
  // prompt this journey reads back.
  await api('/api/config', { memoryDistillerEnabled: false }, 'PUT')
})
test.afterAll(async () => {
  await daemon?.stop()
  if (state) rmSync(state, { recursive: true, force: true })
})

test('first-round mindmap: reasons in the side panel, two skips, an empty category filled, review and the final prompt', async ({
  page,
}, testInfo) => {
  const agent = await api<{ id: string }>('/api/agents', {
    name: 'rfc490-guided-designer',
    description: 'RFC-490 guided journey fixture',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const workflow = await api<{ id: string }>('/api/workflows', {
    name: 'rfc490-guided-journey',
    description: 'A first-round mindmap with configured categories nobody asked about',
    definition: {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [{ key: 'topic', kind: 'text', label: 'Topic', required: true }],
      nodes: [
        { id: 'topic', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'designer',
          kind: 'agent-single',
          agentId: agent.id,
          promptTemplate: 'Design for {{topic}}.',
          position: { x: 280, y: 0 },
        },
        {
          id: 'clarify',
          kind: 'clarify',
          title: 'Clarify the design',
          interactionMode: 'mindmap',
          mindmap: { categories: CATEGORIES, instructions: '' },
          position: { x: 280, y: 250 },
        },
        { id: 'output', kind: 'output', position: { x: 920, y: 0 } },
      ],
      edges: [
        edge('topic-designer', 'topic', 'topic', 'designer', 'topic'),
        edge('designer-clarify', 'designer', '__clarify__', 'clarify', 'questions'),
        edge('clarify-designer', 'clarify', 'answers', 'designer', '__clarify_response__'),
        edge('designer-output', 'designer', 'design', 'output', 'design'),
      ],
    },
  })
  const task = await api<{ id: string }>('/api/tasks', {
    name: TASK_NAME,
    workflowId: workflow.id,
    scratch: true,
    inputs: { topic: TOPIC },
  })
  let nodeRunId = ''
  await expect
    .poll(
      async () => {
        const rounds = await api<Round[]>(`/api/clarify?status=awaiting_human&taskId=${task.id}`)
        nodeRunId = rounds[0]?.intermediaryNodeRunId ?? ''
        return nodeRunId !== ''
      },
      { timeout: 120_000 },
    )
    .toBe(true)
  const currentRound = () => api<Round>(`/api/clarify/${nodeRunId}`)
  const opening = await currentRound()
  // Empty configured categories are a first-round affordance (design §3).
  expect(opening.iteration).toBe(0)
  expect(opening.questions.map((q) => [q.id, q.mindmap.categoryPath])).toEqual([
    ['q-db', ['Architecture']],
    ['q-lang', ['Architecture']],
  ])

  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${daemon.baseUrl}/clarify/${nodeRunId}`)
  const workspace = page.getByRole('region', { name: 'Clarify workspace', exact: true })
  const panel = panelOf(page)
  const surface = surfaceOf(page)
  const map = mapOf(page)
  const panes = page.locator('.mindmap-workspace__panes')
  const zoom = page.getByLabel('Zoom level')
  const suggestionsOpen = page.getByTestId('mindmap-suggestions-open')
  const followupAccepted = () =>
    page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/followup'),
    )
  await expect(workspace).toBeVisible()
  // The mindmap never shows the ordinary questionnaire's keyboard hint.
  await expect(page.getByTestId('clarify-keyboard-hint')).toHaveCount(0)

  // ---- AC05: configured categories nobody asked about are visible, and count nothing.
  for (const category of ['Operations', 'Compliance'])
    await expect(row(page, category)).toContainText('No questions yet')
  await expect(row(page, 'Architecture')).not.toContainText('No questions yet')
  await expect(page.getByText('2 questions', { exact: true })).toBeVisible()
  await expect(suggestionsOpen).toHaveCount(0)

  // ---- AC08: at this width the whole map fits the canvas at the readable scale.
  await expect(zoom).toHaveText(/^\d+(?:\.\d+)?%$/)
  await expect(map).toHaveAttribute('data-world-width', /^\d+$/)
  await expect(map).toHaveAttribute('data-world-height', /^\d+$/)
  const columns = Number(await map.getAttribute('data-columns'))
  expect(columns).toBeGreaterThanOrEqual(2)
  const wideMap = (await surface.boundingBox())!
  expect(Number(await map.getAttribute('data-world-width')) * READABLE_SCALE).toBeLessThanOrEqual(
    wideMap.width,
  )

  // ---- AC10: a canvas node opens beside the canvas, never in a modal.
  const cameraBefore = await settledCamera(map)
  const mapBefore = (await surface.boundingBox())!
  await pickRootOnCanvas(page)
  await expect(panel.getByRole('heading', { name: TASK_NAME, exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(panes).toHaveAttribute('data-split', 'side')
  await expect(surface).toBeVisible()
  const mapBeside = (await surface.boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(mapBeside.x).toBe(mapBefore.x)
  expect(mapBeside.width).toBeLessThan(mapBefore.width)
  expect(mapBeside.x + mapBeside.width).toBeLessThanOrEqual(panelBox.x + 1)
  expect(panelBox.width).toBeGreaterThanOrEqual(420)
  // The picked card is still inside the narrower canvas, at the same zoom.
  await expect
    .poll(async () => {
      const camera = await cameraOf(map)
      return camera.x + (CARD_WIDTH / 2) * camera.zoom
    })
    .toBeLessThanOrEqual(mapBeside.width)
  const beside = await cameraOf(map)
  expect(beside.x - (CARD_WIDTH / 2) * beside.zoom).toBeGreaterThanOrEqual(0)
  expect(beside.zoom).toBe(Number(cameraBefore.split(',')[2]))
  // Escape puts the panel away and returns the keyboard to the canvas it was opened from;
  // the canvas gets its size and its camera back.
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(surface).toBeFocused()
  await expect.poll(() => surface.boundingBox()).toEqual(mapBefore)
  await expect(map).toHaveAttribute('data-camera', cameraBefore)
  // While the panel is open the canvas still pans and zooms, and a place the reader
  // moved to is kept when the panel closes.
  await pickRootOnCanvas(page)
  await page.screenshot({ path: testInfo.outputPath('root-beside-canvas.png') })
  const opened = await settledCamera(map)
  await surface.focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => (await cameraOf(map)).x)
    .toBeCloseTo(Number(opened.split(',')[0]) - 60, 0)
  const zoomBefore = await zoom.textContent()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(zoom).not.toHaveText(zoomBefore!)
  const moved = await settledCamera(map)
  await panel.getByRole('button', { name: /Back to mindmap/ }).click()
  await expect(panel).toHaveCount(0)
  await expect.poll(() => surface.boundingBox()).toEqual(mapBefore)
  await expect(map).toHaveAttribute('data-camera', moved)

  // ---- AC08: a phone-wide stage lays the map out in one column.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(map).toHaveAttribute('data-columns', '1')

  // ---- AC10 where the stage is too narrow to share: the panel takes the stage, the
  // canvas is not rendered meanwhile, and the keyboard still returns to it on close.
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(surface).toBeVisible()
  await pickRootOnCanvas(page)
  await expect(panel.getByRole('heading', { name: TASK_NAME, exact: true })).toBeVisible()
  await expect(panes).toHaveAttribute('data-split', 'full')
  await expect(surface).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(surface).toBeVisible()
  await expect(surface).toBeFocused()

  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(map).toHaveAttribute('data-columns', String(columns))

  // ---- AC05: an empty category takes questions in place.
  await row(page, 'Operations').click()
  await expect(panel.getByRole('heading', { name: 'Operations', exact: true })).toBeVisible()
  await expect(panel.getByText('No questions yet', { exact: true })).toBeVisible()
  await expect(panel.getByText(/AI has not asked anything in this direction yet/)).toBeVisible()
  await panel
    .getByRole('textbox', { name: 'What else should AI consider? (optional)' })
    .fill(OPERATIONS_DIRECTION)
  const categoryRequest = followupAccepted()
  await panel.getByRole('button', { name: 'Generate questions', exact: true }).click()
  const categoryResponse = await categoryRequest
  expect(categoryResponse.status()).toBe(202)
  const categoryBody = categoryResponse.request().postDataJSON() as Record<string, unknown>
  expect(categoryBody).toMatchObject({
    categoryPath: ['Operations'],
    instruction: OPERATIONS_DIRECTION,
  })
  expect(categoryBody.parentQuestionId).toBeUndefined()
  await expect
    .poll(async () => (await currentRound()).questions.length, { timeout: 90_000 })
    .toBe(3)
  const filed = (await currentRound()).questions[2]!
  // The stand-in files its question elsewhere; the framework files it where it was asked for.
  expect(filed.title).toBe(GENERATED_QUESTION)
  expect(filed.mindmap.categoryPath).toEqual(['Operations'])
  expect(filed.mindmap.parentQuestionId).toBeUndefined()
  await expect(row(page, 'Q3')).toContainText(GENERATED_QUESTION, { timeout: 90_000 })
  await expect(row(page, 'Q3')).toHaveAttribute('data-parent-id', 'g:["Operations"]')
  await expect(row(page, 'Operations')).not.toContainText('No questions yet')
  await expect(row(page, 'Compliance')).toContainText('No questions yet')

  // ---- An outline row opens the panel and keeps the keyboard; Escape closes it from there.
  await row(page, 'Q1').click()
  await expectQuestion(page, 1, DB_QUESTION)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(panes).toHaveAttribute('data-split', 'side')
  await expect(surface).toBeVisible()
  await expect(row(page, 'Q1')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(row(page, 'Q1')).toBeFocused()
  await row(page, 'Q1').click()
  await expectQuestion(page, 1, DB_QUESTION)

  // ---- The reasons sit in the answering path.
  await expect(panel.getByRole('textbox', { name: 'My rationale (optional)' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /Confirm and next/ })).toBeDisabled()
  // The free-text box only exists once "Other" is chosen.
  await expect(panel.getByTestId('clarify-custom-textarea')).toHaveCount(0)
  await panel.getByTestId('clarify-custom-radio').check()
  await expect(panel.getByTestId('clarify-custom-textarea')).toBeVisible()
  await panel.getByRole('radio', { name: 'Postgres', exact: true }).check()
  await expect(panel.getByTestId('clarify-custom-textarea')).toHaveCount(0)
  await panel.getByRole('textbox', { name: 'My rationale (optional)' }).fill(DB_RATIONALE)
  await panel.getByRole('radio', { name: 'Decided', exact: true }).click()
  // The remaining notes stay folded for a decided answer.
  await expect(panel.getByText('More notes: cost, unknowns, validation')).toBeVisible()
  await expect(panel.getByRole('textbox', { name: 'Accepted tradeoff' })).toBeHidden()
  // One agent node means nothing to choose: the handler row is left out. The board does
  // know the question, so this is the rule and not missing data.
  const boardBefore = await api<{ questionId: string }[]>(`/api/tasks/${task.id}/questions`)
  expect(boardBefore.some((entry) => entry.questionId === 'q-db')).toBe(true)
  await expect(panel.getByTestId('clarify-handler-q-db')).toHaveCount(0)

  // ---- AC11: one name and one row for follow-ups.
  await expect(panel.getByText('Follow up:', { exact: true })).toBeVisible()
  for (const name of [
    'Check the evidence',
    'Consider the cost',
    'Compare alternatives',
    'Write my own…',
  ])
    await expect(panel.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Deepen this question|Ask my own question|Ask follow-up/ }),
  ).toHaveCount(0)
  await panel.getByRole('button', { name: 'Check the evidence', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Follow up on Q1', exact: true })).toBeVisible()
  const direction = panel.getByRole('textbox', { name: 'What needs more detail? (optional)' })
  await expect(direction).toHaveValue(new RegExp(EVIDENCE_DIRECTION.replace('?', '\\?')))
  const questionRequest = followupAccepted()
  await panel.getByRole('button', { name: 'Generate follow-ups', exact: true }).click()
  const questionResponse = await questionRequest
  expect(questionResponse.status()).toBe(202)
  const questionBody = questionResponse.request().postDataJSON() as Record<string, unknown>
  expect(questionBody.parentQuestionId).toBe('q-db')
  expect(questionBody.categoryPath).toBeUndefined()
  expect(String(questionBody.instruction)).toContain(EVIDENCE_DIRECTION)
  // The parent lists what was asked from it.
  await expect(
    panel.getByRole('heading', { name: 'Follow-up questions (1)', exact: true }),
  ).toBeVisible({ timeout: 90_000 })
  await expect(
    panel.getByRole('button', { name: /Q4 · Which consistency guarantee\?/ }),
  ).toBeVisible()
  const withChild = await currentRound()
  expect(withChild.iteration).toBe(opening.iteration)
  expect(withChild.questions).toHaveLength(4)
  const child = withChild.questions[3]!
  expect(child.mindmap.parentQuestionId).toBe('q-db')
  expect(child.mindmap.categoryPath).toEqual(['Architecture'])
  await expect(row(page, 'Q4')).toHaveAttribute('data-parent-id', 'q:q-db')
  // A question's follow-up form can be put away.
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(direction).toHaveCount(0)

  // ---- AC11: "Confirm and next" confirms this answer and opens the next pending one.
  await panel.getByRole('button', { name: /Confirm and next/ }).click()
  await expectQuestion(page, 4, GENERATED_QUESTION)
  await expect(row(page, 'Q1')).toContainText('Confirmed')
  // AC04: a follow-up says what it was asked from, my answer to that, and my words.
  const origin = panel.getByRole('complementary', { name: 'Where this question came from' })
  await expect(origin).toContainText(`Follow-up to Q1 · ${DB_QUESTION}`)
  await expect(origin).toContainText('Your answer: Postgres')
  await expect(origin).toContainText(`Direction given: ${EVIDENCE_DIRECTION}`)
  await page.screenshot({ path: testInfo.outputPath('follow-up-origin.png'), fullPage: true })

  // ---- AC02: "Decide later" is one click, and the question is handled.
  await panel.getByRole('button', { name: 'Decide later', exact: true }).click()
  await expect(panel.getByText('Marked: Decide later', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Confirmed', exact: true })).toBeDisabled()
  await expect(
    panel.getByRole('textbox', { name: 'What is missing to decide (optional)' }),
  ).toBeVisible()
  await expect(panel.getByRole('radiogroup', { name: 'Decision status' })).toHaveCount(0)
  await expect(row(page, 'Q4')).toContainText('Confirmed')
  await panel.getByRole('button', { name: /Next pending/ }).click()
  await expectQuestion(page, 2, LANGUAGE_QUESTION)

  // ---- AC11: a digit only picks; Enter confirms and moves on.
  await expect(panel.getByTestId('clarify-question-q-lang')).toBeFocused()
  await page.keyboard.press('1')
  await expect(panel.getByRole('checkbox', { name: 'TypeScript', exact: true })).toBeChecked()
  await expectQuestion(page, 2, LANGUAGE_QUESTION)
  await expect(
    panel.getByRole('button', { name: 'Confirm this answer', exact: true }),
  ).toBeEnabled()
  await expect(row(page, 'Q2')).toContainText('Needs confirmation')
  await page.keyboard.press('Enter')
  await expectQuestion(page, 3, GENERATED_QUESTION)
  await expect(row(page, 'Q2')).toContainText('Confirmed')
  // Enter confirmed one answer and went on; it submitted nothing.
  expect(new URL(page.url()).pathname).toBe(`/clarify/${nodeRunId}`)
  expect((await currentRound()).status).toBe('awaiting_human')
  // AC04: a question added to a category says so, with the direction that asked for it.
  await expect(origin).toContainText('From the questions you asked for under “Operations”')
  await expect(origin).toContainText(`Direction given: ${OPERATIONS_DIRECTION}`)

  // ---- AC02: a skip remembers what it replaced; "Not applicable" takes a note.
  const strong = panel.getByRole('radio', { name: 'Strong', exact: true })
  await strong.check()
  // The last open question has nowhere to move on to: only the plain confirmation.
  await expect(panel.getByRole('button', { name: /Confirm and next/ })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Decide later', exact: true }).click()
  await expect(panel.getByText('Marked: Decide later', { exact: true })).toBeVisible()
  await expect(strong).not.toBeChecked()
  await panel.getByRole('button', { name: 'Answer instead', exact: true }).click()
  await expect(strong).toBeChecked()
  await expect(panel.getByText(/^Marked:/)).toHaveCount(0)
  await expect(
    panel.getByRole('button', { name: 'Confirm this answer', exact: true }),
  ).toBeEnabled()
  await expect(row(page, 'Q3')).toContainText('Needs confirmation')
  await panel.getByRole('button', { name: 'Not applicable', exact: true }).click()
  await expect(panel.getByText('Marked: Not applicable', { exact: true })).toBeVisible()
  await expect(strong).not.toBeChecked()
  await panel
    .getByRole('textbox', { name: 'Why it does not apply (optional)' })
    .fill(NOT_APPLICABLE_NOTE)
  // The note explains the skip; it does not turn the question back into one to confirm.
  await expect(panel.getByRole('button', { name: 'Confirmed', exact: true })).toBeDisabled()
  await expect(row(page, 'Q3')).toContainText('Confirmed')

  // ---- AC06: everything is handled, so the workspace says what is worth another look.
  await expect(page.getByText(REVIEW_COMPLETE)).toBeVisible()
  await expect(suggestionsOpen).toHaveText('3 things worth another look')
  await suggestionsOpen.click()
  await expect(panel.getByRole('heading', { name: TASK_NAME, exact: true })).toBeVisible()
  const steps = panel.getByRole('region', { name: 'Suggested next steps', exact: true })
  await expect(steps.getByRole('listitem')).toHaveText([
    /“Compliance” has no questions yet\s*Ask AI to add/,
    /1 questions were deferred\s*Revisit/,
    /1 decisions have no rationale\s*Add one/,
  ])
  await steps.getByRole('button', { name: 'Revisit', exact: true }).click()
  await expectQuestion(page, 4, GENERATED_QUESTION)
  await expect(panel.getByText('Marked: Decide later', { exact: true })).toBeVisible()
  await suggestionsOpen.click()
  await steps.getByRole('button', { name: 'Ask AI to add', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Compliance', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Generate questions', exact: true })).toBeEnabled()

  // ---- AC03: the skips are in the saved draft and survive a refresh.
  await expect(page.getByTestId('clarify-draft-indicator')).toHaveAttribute(
    'data-draft-status',
    'saved',
  )
  await page.reload()
  await expect(page.getByText(REVIEW_COMPLETE)).toBeVisible()
  await row(page, 'Q3').click()
  await expectQuestion(page, 3, GENERATED_QUESTION)
  await expect(panel.getByText('Marked: Not applicable', { exact: true })).toBeVisible()
  await expect(
    panel.getByRole('textbox', { name: 'Why it does not apply (optional)' }),
  ).toHaveValue(NOT_APPLICABLE_NOTE)
  await row(page, 'Q4').click()
  await expectQuestion(page, 4, GENERATED_QUESTION)
  await expect(panel.getByText('Marked: Decide later', { exact: true })).toBeVisible()
  await row(page, 'Q1').click()
  await expect(panel.getByRole('textbox', { name: 'My rationale (optional)' })).toHaveValue(
    DB_RATIONALE,
  )
  await expect(panel.getByRole('radio', { name: 'Decided', exact: true })).toBeChecked()

  // ---- AC07: the review reads by category, with what needs a second look up front.
  await page.getByTestId('mindmap-review-open').click()
  const review = page.getByTestId('mindmap-review')
  const summary = page.getByTestId('mindmap-review-summary')
  const reviewSummary =
    /^4 questions\s*4 confirmed\s*1 unmarked\s*1 not applicable\s*1 deferred\s*1 without rationale$/
  await expect(summary).toHaveText(reviewSummary)
  const architecture = review.getByRole('region', { name: 'Architecture', exact: true })
  const operations = review.getByRole('region', { name: 'Operations', exact: true })
  // A follow-up is read right under the question it was asked from.
  await expect(architecture.getByRole('heading', { level: 5 })).toHaveText([
    `Q1 · ${DB_QUESTION}`,
    `Q4 · ${GENERATED_QUESTION}`,
    `Q2 · ${LANGUAGE_QUESTION}`,
  ])
  await expect(operations.getByRole('heading', { level: 5 })).toHaveText([
    `Q3 · ${GENERATED_QUESTION}`,
  ])
  await expect(architecture).toContainText(DB_RATIONALE)
  await expect(architecture).toContainText('Decide later')
  await expect(operations).toContainText('Not applicable')
  await expect(operations).toContainText('Why it does not apply')
  await expect(operations).toContainText(NOT_APPLICABLE_NOTE)
  const filter = review.getByRole('radiogroup', { name: 'Show', exact: true })
  await expect(filter.getByRole('radio', { name: 'All', exact: true })).toBeChecked()
  await filter.getByRole('radio', { name: 'Needs attention (2)', exact: true }).click()
  // What is left: the deferred question and the answer without a rationale.
  await expect(review.getByRole('heading', { level: 5 })).toHaveText([
    `Q4 · ${GENERATED_QUESTION}`,
    `Q2 · ${LANGUAGE_QUESTION}`,
  ])
  await expect(operations).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('review-needs-attention.png') })
  await filter.getByRole('radio', { name: 'All', exact: true }).click()
  await expect(review.getByRole('heading', { level: 5 })).toHaveCount(4)
  const next = review.getByRole('radiogroup', { name: 'After this submission', exact: true })
  await expect(next).toBeInViewport()
  await expect(
    next.getByRole('radio', { name: 'Generate a result from these decisions', exact: true }),
  ).toBeChecked()

  // ---- AC02 / AC03: a round with skips submits, and seals them as what they are.
  const submit = page.getByTestId('mindmap-review-submit')
  await expect(submit).toHaveText('Confirm and generate result')
  await expect(submit).toBeEnabled()
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/api/clarify/${nodeRunId}/answers`),
  )
  await submit.click()
  const submission = await submitted
  expect(submission.ok()).toBe(true)
  const payload = submission.request().postDataJSON() as {
    directive: string
    questionSetKey: string
    answers: SubmittedAnswer[]
  }
  expect(payload.directive).toBe('stop')
  expect(payload.questionSetKey).toMatch(/^v2:/)
  expect(payload.answers).toHaveLength(4)
  expect(payload.answers.every((answer) => answer.confirmedBasis?.startsWith('v2:'))).toBe(true)
  expect(payload.answers.find((answer) => answer.questionId === filed.id)).toMatchObject({
    selectedOptionIndices: [],
    customText: '',
    decision: { status: 'not-applicable', rationale: NOT_APPLICABLE_NOTE },
  })
  expect(payload.answers.find((answer) => answer.questionId === child.id)).toMatchObject({
    selectedOptionIndices: [],
    customText: '',
    decision: { status: 'deferred' },
  })
  await expect(page).toHaveURL((url) => url.pathname === `/tasks/${task.id}`)
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${task.id}`)).status, {
      timeout: 180_000,
    })
    .toBe('done')

  // ---- AC03: the prompt the agent finally received tells the skips apart.
  const prompt = readFileSync(promptOut, 'utf8')
  await testInfo.attach('final-prompt', { body: prompt, contentType: 'text/plain' })
  expect(prompt).toContain('## Clarify Q&A')
  expect(prompt).toContain('User marked this question as not applicable.')
  expect(prompt).toContain('User deliberately left this question undecided for now.')
  expect(prompt).not.toContain('User did not answer this question.')
  const answered = clarifyAnswersIn(prompt)
  const answersTo = (title: string) =>
    answered.filter((entry) => entry.title === title).map((entry) => entry.answer)
  expect(answersTo(DB_QUESTION)).toContainEqual(
    expect.stringMatching(/^User chose: "Postgres".*Order states need relational integrity\./),
  )
  expect(answersTo(LANGUAGE_QUESTION)).toContainEqual(
    expect.stringMatching(/^User selected: "TypeScript"/),
  )
  expect(answersTo(GENERATED_QUESTION)).toContainEqual(
    expect.stringMatching(
      /^User marked this question as not applicable\..*Backups are owned by the platform team\./,
    ),
  )
  expect(answersTo(GENERATED_QUESTION)).toContainEqual(
    expect.stringMatching(/^User deliberately left this question undecided for now\./),
  )

  // ---- AC13: the sealed round leads to its summary and to the task result.
  expect((await currentRound()).status).toBe('answered')
  await page.goto(`${daemon.baseUrl}/clarify/${nodeRunId}`)
  await expect(
    page.getByText('This round was submitted. Confirmed answers are available to read.'),
  ).toBeVisible()
  await expect(page.getByTestId('mindmap-review-open')).toHaveText('View decision summary')
  const result = page.getByTestId('clarify-view-task')
  await expect(result).toHaveText('View task result')
  // AC06: a sealed round suggests nothing.
  await expect(suggestionsOpen).toHaveCount(0)
  // AC05: the gap is still shown, with no way to fill it.
  await row(page, 'Compliance').click()
  await expect(panel.getByRole('heading', { name: 'Compliance', exact: true })).toBeVisible()
  await expect(panel.getByText('No questions yet', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Generate questions' })).toHaveCount(0)
  // AC03: a sealed skip reads as what it is, with its note under the right label.
  await row(page, 'Q3').click()
  await expectQuestion(page, 3, GENERATED_QUESTION)
  await expect(panel.getByText('Not applicable', { exact: true })).toBeVisible()
  await expect(panel.getByText('Why it does not apply', { exact: true })).toBeVisible()
  await expect(panel.getByText(NOT_APPLICABLE_NOTE, { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Answer instead' })).toHaveCount(0)
  await expect(panel.getByText('Follow up:', { exact: true })).toHaveCount(0)
  await page.getByTestId('mindmap-review-open').click()
  await expect(
    review.getByRole('heading', { name: 'Decision summary for this round' }),
  ).toBeVisible()
  await expect(summary).toHaveText(reviewSummary)
  await review.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(review).toHaveCount(0)
  await result.click()
  await expect(page).toHaveURL((url) => url.pathname === `/tasks/${task.id}`)
  // The task question board is not part of this journey: a round submitted here in one
  // go leaves no board entries. How the board shows a sealed skip is covered where such
  // entries exist (backend rfc490-mindmap-followup-targets, frontend
  // rfc490-task-question-board).
})
