// RFC-490 (design §4.4, §2.2, §6.4; proposal P4, P6, AC05, AC13, AC14): what the
// /clarify/$nodeRunId route itself contributes to the mindmap changes.
//   - It reads the categories configured on the frozen clarify node and hands them to
//     the workspace for the first round only, so a category nobody asked about shows
//     as a gap; later rounds are their own map and show none.
//   - It hands over the task's launch inputs, readable from the map's root.
//   - It is the single write entry for answers: a real answer wins over a skip mark
//     left on the draft, before anything is stored.
//   - A sealed or fully handled mindmap round links to the task, where the result is.
//   - It trims the per-question chrome in mindmap mode only (single-candidate handler
//     row, inactive free-text box); the ordinary questionnaire keeps both.
// The harness follows clarify-detail-route.test.tsx.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { clarifyAnswerBasis, type ClarifyAnswer, type ClarifyRound } from '@agent-workflow/shared'
import { api } from '../src/api/client'
import * as clarifyDraftStore from '../src/lib/clarify/draftStore'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { ClarifyDetailPage } from '../src/routes/clarify.detail'
import '../src/i18n'

// The canvas needs a layout worker and a 2D context; the outline and the panel are
// what these cases use.
vi.mock('../src/components/clarify/mindmap/MindmapCanvas', () => ({
  MindmapCanvas: () => <div role="img" aria-label="Test map" />,
}))

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  // Drafts go to memory, not to IndexedDB or the network.
  vi.spyOn(clarifyDraftStore, 'getClarifyDraft').mockResolvedValue(null)
  vi.spyOn(clarifyDraftStore, 'setClarifyDraft').mockResolvedValue(undefined)
  vi.spyOn(clarifyDraftStore, 'deleteClarifyDraft').mockResolvedValue(undefined)
})
afterEach(() => {
  // Unmount queries before restoring fetch (see clarify-detail-route.test.tsx).
  cleanup()
  vi.restoreAllMocks()
})

type Question = ClarifyRound['questions'][number]
const option = (label: string) => ({
  label,
  description: '',
  recommended: false,
  recommendationReason: '',
})
const question = (id: string, title: string, categoryPath?: string[]): Question => ({
  id,
  title,
  kind: 'single',
  recommended: false,
  options: [option('Postgres'), option('MySQL')],
  ...(categoryPath ? { mindmap: { categoryPath } } : {}),
})
/** A first-round mindmap round with one question under "Performance". */
function round(overrides: Partial<ClarifyRound> = {}): ClarifyRound {
  return {
    id: 'sess_1',
    taskId: 'task_a',
    kind: 'self',
    askingNodeId: 'designer',
    askingNodeRunId: 'nr_src',
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    intermediaryNodeRunId: 'nr_clarify',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: 0,
    questions: [question('q1', 'Pick DB', ['Performance'])],
    status: 'awaiting_human',
    terminatedAs: null,
    createdAt: 1_700_000_000_000,
    answeredAt: null,
    answeredBy: null,
    directive: null,
    sessionMode: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    ...overrides,
  }
}
/** GET /api/tasks/:id — the frozen snapshot carries the clarify node `c1`. */
function task(
  extra: {
    categories?: (string | string[])[]
    agents?: string[]
    inputs?: Record<string, string>
    declared?: { key: string; label: string }[]
  } = {},
) {
  return {
    name: 'fixture-task',
    ...(extra.inputs ? { inputs: extra.inputs } : {}),
    workflowSnapshot: {
      inputs: (extra.declared ?? []).map((input) => ({ kind: 'text', ...input })),
      nodes: [
        ...(extra.agents ?? ['designer']).map((id) => ({
          id,
          kind: 'agent-single',
          agentName: id,
        })),
        {
          id: 'c1',
          kind: 'clarify',
          interactionMode: 'mindmap',
          mindmap: { categories: extra.categories ?? [], instructions: '' },
        },
      ],
    },
  }
}
/** The board entry that makes the per-question handler row render for q1. */
const asker = {
  id: 'e-ask',
  questionId: 'q1',
  questionTitle: 'Pick DB',
  originNodeRunId: 'nr_clarify',
  sourceKind: 'self',
  roleKind: 'self',
  sourceNodeId: 'designer',
  defaultTargetNodeId: 'designer',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'designer',
  phase: 'pending',
  confirmation: 'open',
  staged: false,
  autoDispatchDeferred: false,
  sealed: false,
  answerSummary: null,
}

function serve(session: ClarifyRound, extra: { task?: unknown; questions?: unknown } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const path = typeof url === 'string' ? url : url.toString()
    const body = path.includes(`/api/tasks/${session.taskId}/questions`)
      ? (extra.questions ?? [])
      : path.includes(`/api/tasks/${session.taskId}`)
        ? (extra.task ?? task())
        : path.includes(`/api/clarify/${session.intermediaryNodeRunId}`)
          ? session
          : path.includes('/api/clarify?')
            ? []
            : {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderRoute() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify/$nodeRunId',
    component: ClarifyDetailPage,
  })
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify',
    component: () => null,
  })
  const tasks = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <p data-testid="task-page">Task page</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detail, list, tasks]),
    history: createMemoryHistory({ initialEntries: ['/clarify/nr_clarify'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { qc, router }
}
/** Both side queries have answered and the page has rendered with them, so "it is not
 *  shown" below is not just "not yet". */
async function sideDataLoaded(qc: QueryClient) {
  await waitFor(() => {
    expect(qc.getQueryData(['task-questions', 'task_a'])).toBeDefined()
    expect(qc.getQueryData(['tasks', 'task_a', 'snapshot'])).toBeDefined()
  })
  // The header shows the task name once the snapshot has rendered …
  await screen.findByTestId('clarify-detail-task-name')
  // … and the question entries draw nothing by themselves: give them their turn.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
/** The round is on screen and its answers (draft or sealed) are loaded. */
async function ready() {
  const open = await screen.findByTestId('mindmap-review-open')
  await waitFor(() => expect(open.hasAttribute('disabled')).toBe(false))
  return open
}
const row = (name: RegExp) => screen.getByRole('treeitem', { name })
const pane = () => screen.getByRole('region', { name: 'Answer and confirm' })

describe('configured categories reach the workspace in the first round only', () => {
  const categories = ['Performance', ['Reliability', 'Recovery']]

  test('first round: a configured category without questions shows in the outline as a gap', async () => {
    serve(round(), { task: task({ categories }) })
    renderRoute()
    const gap = await screen.findByRole('treeitem', { name: /^Reliability/ })
    expect(within(gap).getByText('No questions yet')).toBeTruthy()
    expect(within(row(/^Recovery/)).getByText('No questions yet')).toBeTruthy()
    // The configured category that was asked about is the same row as before.
    expect(screen.getAllByRole('treeitem', { name: /^Performance/ })).toHaveLength(1)
    expect(within(row(/^Performance/)).queryByText('No questions yet')).toBeNull()
    expect(row(/Pick DB/)).toBeTruthy()
    // An empty category is not a question: the count is still the one question.
    expect(screen.getByText('1 questions')).toBeTruthy()
  })

  test('first round: a legacy category written as one string is one category, slash and all', async () => {
    serve(round(), { task: task({ categories: ['Service/API'] }) })
    renderRoute()
    const gap = await screen.findByRole('treeitem', { name: /^Service\/API/ })
    expect(within(gap).getByText('No questions yet')).toBeTruthy()
    expect(screen.queryByRole('treeitem', { name: /^API/ })).toBeNull()
  })

  test('a later round shows only what it asked: no gaps from the configuration', async () => {
    serve(round({ iteration: 1 }), { task: task({ categories }) })
    const { qc } = renderRoute()
    await ready()
    await sideDataLoaded(qc)
    // The snapshot is in: the header already uses it.
    expect(await screen.findByTestId('clarify-detail-task-name')).toBeTruthy()
    expect(row(/^Performance/)).toBeTruthy()
    expect(screen.queryByRole('treeitem', { name: /^Reliability/ })).toBeNull()
    expect(screen.queryByRole('treeitem', { name: /^Recovery/ })).toBeNull()
    expect(screen.queryByText('No questions yet')).toBeNull()
  })

  test('first round without configured categories is just the questions', async () => {
    serve(round(), { task: task() })
    const { qc } = renderRoute()
    await ready()
    await sideDataLoaded(qc)
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    expect(screen.queryByText('No questions yet')).toBeNull()
  })
})

describe('the task’s launch inputs are readable from the root of the map', () => {
  test('declared inputs carry their labels, undeclared ones their key, blank ones are left out', async () => {
    serve(round(), {
      task: task({
        declared: [
          { key: 'topic', label: 'Design topic' },
          { key: 'notes', label: 'Notes' },
        ],
        inputs: { topic: 'Reporting for 500 employees', notes: '   ', extra: 'Ad hoc value' },
      }),
    })
    renderRoute()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
    expect(await within(pane()).findByText('Task input')).toBeTruthy()
    expect(
      Array.from(pane().querySelectorAll('.mindmap-task-inputs dl > div'), (item) => [
        item.querySelector('dt')?.textContent,
        item.querySelector('dd')?.textContent,
      ]),
    ).toEqual([
      ['Design topic', 'Reporting for 500 employees'],
      ['extra', 'Ad hoc value'],
    ])
    // They belong to the root: a question's panel does not repeat them.
    fireEvent.click(row(/Pick DB/))
    expect(within(pane()).getByRole('heading', { name: 'Pick DB' })).toBeTruthy()
    expect(within(pane()).queryByText('Task input')).toBeNull()
  })

  test('a task launched without inputs shows no empty block', async () => {
    serve(round(), { task: task({ declared: [{ key: 'topic', label: 'Design topic' }] }) })
    const { qc } = renderRoute()
    await ready()
    await sideDataLoaded(qc)
    fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
    expect(await within(pane()).findByRole('heading', { name: 'fixture-task' })).toBeTruthy()
    expect(within(pane()).queryByText('Task input')).toBeNull()
  })
})

describe('the route normalises answers before they are stored (design §2.2)', () => {
  test('picking an option on a draft that was skipped stores the answer without the skip mark', async () => {
    const session = round()
    const skipped: ClarifyAnswer = {
      questionId: 'q1',
      selectedOptionIndices: [],
      selectedOptionLabels: [],
      customText: '',
      decision: { status: 'deferred', rationale: 'Waiting for the load test' },
    }
    session.draftAnswers = {
      q1: { ...skipped, confirmedBasis: clarifyAnswerBasis(session.questions[0]!, skipped) },
    }
    const put = vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    serve(session)
    renderRoute()
    await ready()
    fireEvent.click(row(/Pick DB/))
    // The skipped draft is what the page loaded: marked, and already confirmed.
    expect(within(pane()).getByText('Marked: Decide later')).toBeTruthy()
    expect(within(pane()).getByRole('button', { name: 'Confirmed' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(put).not.toHaveBeenCalled()
    fireEvent.click(within(pane()).getByLabelText(/Postgres/))
    // It is an ordinary answer again, waiting to be confirmed.
    expect(within(pane()).queryByText(/^Marked:/)).toBeNull()
    expect((within(pane()).getByLabelText(/Postgres/) as HTMLInputElement).checked).toBe(true)
    expect(
      within(pane()).getByRole('button', { name: 'Confirm this answer' }).hasAttribute('disabled'),
    ).toBe(false)
    // The note stays as the user's wording, now simply their rationale.
    expect(
      (within(pane()).getByLabelText('My rationale (optional)') as HTMLInputElement).value,
    ).toBe('Waiting for the load test')
    // The server copy is written after a short debounce; the suite's own wait ceiling
    // (tests/setup.ts) covers it on a slow runner.
    await waitFor(() => expect(put).toHaveBeenCalled())
    const [path, body] = put.mock.calls.at(-1)! as [string, Record<string, unknown>]
    expect(path).toBe('/api/clarify/nr_clarify/draft')
    expect(body).toMatchObject({
      roundId: 'sess_1',
      questionId: 'q1',
      selectedOptionIndices: [0],
      customText: '',
    })
    expect(body.decision).toEqual({ rationale: 'Waiting for the load test' })
    expect(body.confirmedBasis).toBeUndefined()
    // The local copy is the same normalised answer.
    const local = vi.mocked(clarifyDraftStore.setClarifyDraft).mock.calls.at(-1)![1]
    expect(local[0]).toMatchObject({ questionId: 'q1', selectedOptionIndices: [0] })
    expect(local[0]!.decision).toEqual({ rationale: 'Waiting for the load test' })
    await waitFor(() =>
      expect(screen.getByTestId('clarify-draft-indicator').dataset.draftStatus).toBe('saved'),
    )
  })
})

describe('a mindmap round with nothing left to submit links to the task', () => {
  const answers: ClarifyAnswer[] = [
    {
      questionId: 'q1',
      selectedOptionIndices: [0],
      selectedOptionLabels: ['Postgres'],
      customText: '',
      decision: { status: 'decided', rationale: 'Already operated by the team' },
    },
  ]

  test('a sealed round offers "View task result" next to its decision summary', async () => {
    serve(round({ status: 'answered', answeredAt: 1_700_000_100_000, answers }))
    renderRoute()
    const summary = await ready()
    expect(summary.textContent).toBe('View decision summary')
    const link = screen.getByTestId('clarify-view-task')
    expect(link.tagName).toBe('A')
    expect(link.textContent).toBe('View task result')
    expect(link.getAttribute('href')).toBe('/tasks/task_a')
    // Same footer, after the summary.
    expect(link.parentElement).toBe(summary.parentElement)
    expect(summary.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(link)
    expect(await screen.findByTestId('task-page')).toBeTruthy()
    expect(screen.queryByTestId('clarify-detail-page')).toBeNull()
  })

  test('so does an open round whose questions were all handled elsewhere', async () => {
    serve(round(), {
      questions: [{ ...asker, sealed: true, phase: 'done' }],
    })
    renderRoute()
    const link = await screen.findByTestId('clarify-view-task')
    expect(link.getAttribute('href')).toBe('/tasks/task_a')
    expect(screen.getByTestId('mindmap-review-open').textContent).toBe('View decision summary')
  })

  test('a round that can still be submitted has no such link', async () => {
    serve(round(), { questions: [asker] })
    const { qc } = renderRoute()
    const open = await ready()
    await sideDataLoaded(qc)
    expect(open.textContent).toBe('Review decisions and submit')
    expect(screen.queryByTestId('clarify-view-task')).toBeNull()
  })
})

describe('per-question chrome is trimmed in mindmap mode only', () => {
  test('ordinary questionnaire: the handler row and the disabled free-text box are still there', async () => {
    // One candidate node, the case the mindmap hides.
    serve(round({ questions: [question('q1', 'Pick DB')] }), { questions: [asker] })
    renderRoute()
    const handler = await screen.findByTestId('clarify-handler-q1')
    expect(handler.textContent).toContain('designer')
    const form = screen.getByTestId('clarify-question-q1')
    const box = within(form).getByTestId('clarify-custom-textarea') as HTMLTextAreaElement
    expect(box.disabled).toBe(true)
    expect(within(form).getByText('Pick DB')).toBeTruthy()
    // And it is the ordinary page in every other respect.
    expect(screen.getByTestId('clarify-keyboard-hint')).toBeTruthy()
    expect(screen.getByTestId('clarify-submit-continue')).toBeTruthy()
    expect(screen.queryByTestId('mindmap-review-open')).toBeNull()
    expect(screen.queryByTestId('clarify-view-task')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Answer and confirm' })).toBeNull()
  })

  test('ordinary questionnaire: a sealed round gets no task-result link either', async () => {
    serve(
      round({
        questions: [question('q1', 'Pick DB')],
        status: 'answered',
        answeredAt: 1_700_000_100_000,
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [1],
            selectedOptionLabels: ['MySQL'],
            customText: '',
          },
        ],
      }),
    )
    const { qc } = renderRoute()
    await screen.findByTestId('clarify-question-q1')
    await sideDataLoaded(qc)
    expect(screen.getByTestId('clarify-submit-group')).toBeTruthy()
    expect(screen.queryByTestId('clarify-view-task')).toBeNull()
  })

  test('mindmap: a single candidate node has no handler row, and the free-text box comes with "Other"', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    serve(round(), { questions: [asker] })
    const { qc } = renderRoute()
    await ready()
    await sideDataLoaded(qc)
    fireEvent.click(row(/Pick DB/))
    expect(within(pane()).getByRole('heading', { name: 'Pick DB' })).toBeTruthy()
    expect(screen.queryByTestId('clarify-handler-q1')).toBeNull()
    expect(within(pane()).queryByTestId('clarify-custom-textarea')).toBeNull()
    const other = () => within(pane()).getByTestId('clarify-custom-radio') as HTMLInputElement
    fireEvent.click(other())
    expect(other().checked).toBe(true)
    expect(
      (within(pane()).getByTestId('clarify-custom-textarea') as HTMLTextAreaElement).disabled,
    ).toBe(false)
    // Skipping the question drops the pending "Other" pick together with its box.
    fireEvent.click(within(pane()).getByRole('button', { name: 'Not applicable' }))
    expect(within(pane()).getByText('Marked: Not applicable')).toBeTruthy()
    expect(other().checked).toBe(false)
    expect(within(pane()).queryByTestId('clarify-custom-textarea')).toBeNull()
    // Let the queued draft write settle before the test ends.
    await waitFor(() =>
      expect(screen.getByTestId('clarify-draft-indicator').dataset.draftStatus).toBe('saved'),
    )
  })

  test('mindmap: with two candidate nodes the handler row is shown in the panel', async () => {
    serve(round(), { task: task({ agents: ['designer', 'reviewer'] }), questions: [asker] })
    renderRoute()
    await ready()
    fireEvent.click(row(/Pick DB/))
    const handler = await within(pane()).findByTestId('clarify-handler-q1')
    expect(within(handler).getAllByRole('combobox').length).toBeGreaterThan(0)
  })
})
