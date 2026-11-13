// RFC-490 (design §2.5, proposal G2 / AC03): a question that was skipped and sealed has
// no option and no free text, so its card on the task question board used to show
// nothing where the answer goes. The board entry now carries `answerSkip`; the card
// shows the localized skip ("Not applicable" / "Decide later") and, after " · ", the
// note the user left, if any. An ordinary answered card is exactly what it was.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { TaskQuestionList, type TaskQuestionEntry } from '../src/components/tasks/TaskQuestionList'
import i18n from '../src/i18n'

afterEach(() => {
  cleanup()
})

const entry = (over: Partial<TaskQuestionEntry>): TaskQuestionEntry => ({
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'How are slow queries optimised?',
  originNodeRunId: 'origin-1',
  sourceKind: 'self',
  roleKind: 'self',
  sourceNodeId: 'designer',
  defaultTargetNodeId: 'designer',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'designer',
  // Sealed and waiting for the asker's confirmation: the card shows its answer.
  phase: 'awaiting_confirm',
  confirmation: 'open',
  staged: false,
  autoDispatchDeferred: false,
  sealed: true,
  answerSummary: null,
  ...over,
})

/** The same router + seeded query harness as task-question-list.test.tsx. */
async function board(entries: TaskQuestionEntry[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <QueryClientProvider client={qc}>
        <TaskQuestionList taskId="task-1" nodeOptions={[{ id: 'designer', label: 'designer' }]} />
      </QueryClientProvider>
    ),
  })
  const clarify = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify/$nodeRunId',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, clarify]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(<RouterProvider router={router as never} />)
}
const answerOf = (id: string) =>
  screen.getByTestId(`tq-card-${id}`).querySelector<HTMLElement>('.task-questions__answer')

test('a skipped question shows which skip it was instead of an empty answer', async () => {
  await board([
    entry({ id: 'na', questionId: 'q1', answerSkip: 'not-applicable' }),
    entry({ id: 'later', questionId: 'q2', answerSkip: 'deferred', answerSummary: '' }),
  ])
  const notApplicable = answerOf('na')
  expect(notApplicable).not.toBeNull()
  expect(notApplicable!.textContent).toBe('Not applicable')
  expect(notApplicable!.getAttribute('data-answer-skip')).toBe('not-applicable')
  // An empty note is no note: no dangling separator.
  const later = answerOf('later')
  expect(later!.textContent).toBe('Decide later')
  expect(later!.getAttribute('data-answer-skip')).toBe('deferred')
})

test('the note left with the skip follows it after a separator', async () => {
  await board([
    entry({
      id: 'na',
      questionId: 'q1',
      answerSkip: 'not-applicable',
      answerSummary: 'Reports are read-only',
    }),
    entry({
      id: 'later',
      questionId: 'q2',
      answerSkip: 'deferred',
      answerSummary: 'Waiting for the load test',
    }),
  ])
  expect(answerOf('na')!.textContent).toBe('Not applicable · Reports are read-only')
  expect(answerOf('later')!.textContent).toBe('Decide later · Waiting for the load test')
  // Still the answer line: right under the question, before the node information.
  const card = screen.getByTestId('tq-card-na')
  const meta = card.querySelector('.task-questions__meta')!
  expect(
    answerOf('na')!.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})

test('the skip is named in the reader’s language', async () => {
  await i18n.changeLanguage('zh-CN')
  await board([
    entry({
      id: 'na',
      questionId: 'q1',
      answerSkip: 'not-applicable',
      answerSummary: '只有单地域',
    }),
    entry({ id: 'later', questionId: 'q2', answerSkip: 'deferred' }),
  ])
  expect(answerOf('na')!.textContent).toBe('不适用 · 只有单地域')
  expect(answerOf('later')!.textContent).toBe('暂不决定')
})

test('an ordinary answered card is unchanged, and an unanswered one still has no answer line', async () => {
  await board([
    entry({ id: 'answered', questionId: 'q1', answerSummary: 'Add targeted indexes' }),
    entry({ id: 'open', questionId: 'q2', phase: 'pending', sealed: false }),
  ])
  const answered = answerOf('answered')
  expect(answered!.textContent).toBe('Add targeted indexes')
  expect(answered!.hasAttribute('data-answer-skip')).toBe(false)
  expect(answerOf('open')).toBeNull()
})
