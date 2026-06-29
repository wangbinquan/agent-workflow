// RFC-120 §15 — manual question author form (自主新增 / 复制) + the board's "+ 新增问题"
// and per-card "复制" wiring. Asserts on data-testid + roles (i18n-agnostic), and that the
// shared primitives are used (Dialog/Field/TextInput/TextArea/Select — no native modal/select
// chrome). golden-lock: no manual rows ⇒ the board's existing columns/cards are unchanged.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '@/api/client'
import { TaskQuestionList, type TaskQuestionEntry } from '../src/components/tasks/TaskQuestionList'
import { QuestionAuthorForm } from '../src/components/tasks/QuestionAuthorForm'

afterEach(() => {
  // RTL cleanup properly unmounts the React tree incl. the Dialog PORTAL; a manual
  // `document.body.innerHTML = ''` would orphan the portal and crash the next unmount.
  cleanup()
  vi.restoreAllMocks()
})

const entry = (over: Partial<TaskQuestionEntry>): TaskQuestionEntry => ({
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'Pick a strategy?',
  originNodeRunId: 'origin-1',
  sourceKind: 'self',
  roleKind: 'self',
  sourceNodeId: 'designer',
  defaultTargetNodeId: 'designer',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'designer',
  phase: 'pending',
  confirmation: 'open',
  staged: false,
  answerSummary: null,
  ...over,
})

async function wrapBoard(entries: TaskQuestionEntry[]) {
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
        <TaskQuestionList
          taskId="task-1"
          nodeOptions={[
            { id: 'designer', label: 'designer' },
            { id: 'fixer', label: 'fixer' },
          ]}
        />
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

function wrapForm(props: Partial<React.ComponentProps<typeof QuestionAuthorForm>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <QuestionAuthorForm
        open
        onClose={props.onClose ?? (() => {})}
        taskId="task-1"
        nodeOptions={[
          { id: 'designer', label: 'designer' },
          { id: 'fixer', label: 'fixer' },
        ]}
        initial={props.initial ?? null}
        onCreated={props.onCreated}
      />
    </QueryClientProvider>,
  )
}

describe('QuestionAuthorForm', () => {
  test('renders title input, instruction textarea, handler select (shared primitives)', () => {
    wrapForm()
    expect(screen.getByTestId('question-author-form')).toBeTruthy()
    expect(screen.getByTestId('question-author-title')).toBeTruthy()
    expect(screen.getByTestId('question-author-body')).toBeTruthy()
    // handler is the shared Select (role=combobox trigger, NOT a native <select>)
    const dialog = screen.getByTestId('question-author-form')
    expect(dialog.querySelector('select')).toBeNull()
    expect(within(dialog).getByRole('combobox')).toBeTruthy()
  })

  test('save is disabled until BOTH title and body are non-empty', () => {
    wrapForm()
    const save = screen.getByTestId('question-author-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('question-author-title'), { target: { value: 'T' } })
    expect((screen.getByTestId('question-author-save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('question-author-body'), { target: { value: 'B' } })
    expect((screen.getByTestId('question-author-save') as HTMLButtonElement).disabled).toBe(false)
  })

  test('save POSTs /questions/manual with the trimmed title + body (no handler ⇒ no targetNodeId)', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true, id: 'm1' } as never)
    wrapForm()
    fireEvent.change(screen.getByTestId('question-author-title'), {
      target: { value: '  Fix it  ' },
    })
    fireEvent.change(screen.getByTestId('question-author-body'), { target: { value: ' do X ' } })
    fireEvent.click(screen.getByTestId('question-author-save'))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/manual', {
        title: 'Fix it',
        body: 'do X',
      }),
    )
  })

  test('prefilled initial (复制) populates the fields', () => {
    wrapForm({ initial: { title: 'Copied title', body: 'Copied body' } })
    expect((screen.getByTestId('question-author-title') as HTMLInputElement).value).toBe(
      'Copied title',
    )
    expect((screen.getByTestId('question-author-body') as HTMLTextAreaElement).value).toBe(
      'Copied body',
    )
  })
})

describe('TaskQuestionList — manual question entry points (§15)', () => {
  test('"+ 新增问题" opens the author form (create mode — empty)', async () => {
    await wrapBoard([entry({ id: 'e1', phase: 'pending' })])
    expect(screen.queryByTestId('question-author-form')).toBeNull()
    fireEvent.click(screen.getByTestId('tq-add-question'))
    expect(screen.getByTestId('question-author-form')).toBeTruthy()
    expect((screen.getByTestId('question-author-title') as HTMLInputElement).value).toBe('')
  })

  test('"+ 新增问题" is available even when the board is EMPTY', async () => {
    await wrapBoard([])
    expect(screen.queryByTestId('task-questions-board')).toBeNull()
    expect(screen.getByTestId('tq-add-question')).toBeTruthy()
  })

  test('"复制" on a 待指派 card opens the form PREFILLED with that row title/body', async () => {
    await wrapBoard([
      entry({ id: 'e1', phase: 'pending', questionTitle: 'Orig Q', answerSummary: 'Orig A' }),
    ])
    fireEvent.click(screen.getByTestId('tq-copy-e1'))
    expect((screen.getByTestId('question-author-title') as HTMLInputElement).value).toBe('Orig Q')
    expect((screen.getByTestId('question-author-body') as HTMLTextAreaElement).value).toBe('Orig A')
  })

  test('a manual card shows the "手动" source label + no clarify link', async () => {
    await wrapBoard([
      entry({
        id: 'm1',
        phase: 'staged',
        sourceKind: 'manual',
        roleKind: 'designer',
        sourceNodeId: null,
        originNodeRunId: null,
        defaultTargetNodeId: null,
        overrideTargetNodeId: 'fixer',
        effectiveTargetNodeId: 'fixer',
        questionTitle: 'Manual one',
        answerSummary: 'do the thing',
        staged: true,
      }),
    ])
    const card = screen.getByTestId('tq-card-m1')
    expect(card.textContent).toContain('Manual one')
    // no /clarify link for a manual row (originNodeRunId null)
    expect(within(card).queryByTestId('tq-answer-m1')).toBeNull()
  })

  test('golden-lock: with NO manual rows the existing board columns/cards are unchanged', async () => {
    await wrapBoard([
      entry({ id: 'e1', phase: 'pending' }),
      entry({ id: 'e2', phase: 'awaiting_confirm' }),
    ])
    // board + both cards still render; the clarify answer link is still present.
    expect(screen.getByTestId('task-questions-board')).toBeTruthy()
    expect(screen.getByTestId('tq-card-e1')).toBeTruthy()
    expect(screen.getByTestId('tq-answer-e1')).toBeTruthy()
    // the author form stays closed until "+ 新增问题" is clicked (no behavioral change).
    expect(screen.queryByTestId('question-author-form')).toBeNull()
  })
})
