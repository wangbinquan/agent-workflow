// RFC-120 — TaskQuestionList board: renders entries into phase columns and wires
// the stage / confirm actions to the REST endpoints. Asserts on data-testid +
// roles (not translated text) so it's i18n-agnostic.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useRef, useState } from 'react'
import { api } from '@/api/client'
import { TaskQuestionList, type TaskQuestionEntry } from '../src/components/tasks/TaskQuestionList'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
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

// The board renders a <Link to="/clarify/$nodeRunId"> per card, so it needs a
// router context with that route registered (TaskOutputPanel test pattern).
async function wrap(entries: TaskQuestionEntry[]) {
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

// RFC-120 D13 — harness for the canvas-badge focus signal. Holds {nodeId, key}
// state (like tasks.detail) with buttons that mint a FRESH key each push, so we
// can drive `focusSourceNode` and assert the board filters to that node — incl.
// pushing the SAME node twice (a new key must still re-apply the filter).
function FocusHarness() {
  const [focus, setFocus] = useState<{ nodeId: string; key: number } | null>(null)
  const keyRef = useRef(0)
  const push = (nodeId: string) => {
    keyRef.current += 1
    setFocus({ nodeId, key: keyRef.current })
  }
  return (
    <>
      <button type="button" data-testid="push-nodeA" onClick={() => push('nodeA')}>
        A
      </button>
      <button type="button" data-testid="push-nodeB" onClick={() => push('nodeB')}>
        B
      </button>
      <TaskQuestionList
        taskId="task-1"
        nodeOptions={[
          { id: 'nodeA', label: 'nodeA' },
          { id: 'nodeB', label: 'nodeB' },
        ]}
        focusSourceNode={focus}
      />
    </>
  )
}

async function wrapFocus(entries: TaskQuestionEntry[]) {
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
        <FocusHarness />
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

describe('TaskQuestionList board', () => {
  test('renders entries as cards on the board', async () => {
    await wrap([
      entry({ id: 'e1', phase: 'pending' }),
      entry({ id: 'e2', phase: 'awaiting_confirm' }),
      entry({ id: 'e3', phase: 'done', roleKind: 'designer' }),
    ])
    expect(screen.getByTestId('task-questions-board')).toBeTruthy()
    expect(screen.getByTestId('tq-card-e1')).toBeTruthy()
    expect(screen.getByTestId('tq-card-e2')).toBeTruthy()
    expect(screen.getByTestId('tq-card-e3')).toBeTruthy()
  })

  test('stage button posts to /stage with staged:true', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    await wrap([entry({ id: 'e1', phase: 'pending', staged: false })])
    const card = screen.getByTestId('tq-card-e1')
    fireEvent.click(within(card).getByRole('button'))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/e1/stage', { staged: true }),
    )
  })

  test('awaiting_confirm card shows a confirm control; designer card shows a reassign select', async () => {
    await wrap([
      entry({ id: 'e2', phase: 'awaiting_confirm' }),
      entry({
        id: 'e3',
        phase: 'pending',
        roleKind: 'designer',
        effectiveTargetNodeId: 'designer',
      }),
    ])
    // confirm card has at least one button (the ConfirmButton)
    expect(within(screen.getByTestId('tq-card-e2')).getAllByRole('button').length).toBeGreaterThan(
      0,
    )
    // designer card renders the reassign Select (a combobox/button trigger)
    expect(within(screen.getByTestId('tq-card-e3')).getAllByRole('button').length).toBeGreaterThan(
      0,
    )
  })

  test('empty list renders the empty state', async () => {
    await wrap([])
    expect(screen.queryByTestId('task-questions-board')).toBeNull()
  })

  test('每张卡片给出回答路径 → 链到该问题的 /clarify/$nodeRunId 反问页', async () => {
    await wrap([entry({ id: 'e1', phase: 'pending', originNodeRunId: 'run-xyz' })])
    const link = within(screen.getByTestId('tq-card-e1')).getByTestId('tq-answer-e1')
    expect(link.getAttribute('href')).toBe('/clarify/run-xyz')
  })

  test('已答卡片：答案紧贴问题、排在节点信息(meta)之前（用户反馈布局）', async () => {
    await wrap([entry({ id: 'e1', phase: 'awaiting_confirm', answerSummary: 'my answer' })])
    const card = screen.getByTestId('tq-card-e1')
    const answer = card.querySelector('.task-questions__answer')
    const meta = card.querySelector('.task-questions__meta')
    expect(answer?.textContent).toContain('my answer')
    expect(meta).toBeTruthy()
    // DOM 顺序：答案必须在 meta(来源/目标节点信息) 之前——节点信息不得插在问与答之间。
    expect(answer!.compareDocumentPosition(meta!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('D13: source-node filter chips + click narrows the board to that node', async () => {
    await wrap([
      entry({ id: 'a1', sourceNodeId: 'nodeA', phase: 'pending' }),
      entry({ id: 'a2', sourceNodeId: 'nodeA', phase: 'processing' }),
      entry({ id: 'b1', sourceNodeId: 'nodeB', phase: 'pending' }),
    ])
    // per-node count chips (non-terminal): nodeA=2, nodeB=1
    expect(screen.getByTestId('tq-node-filter-nodeA').textContent).toContain('2')
    expect(screen.getByTestId('tq-node-filter-nodeB').textContent).toContain('1')
    // all three cards visible initially
    expect(screen.getByTestId('tq-card-a1')).toBeTruthy()
    expect(screen.getByTestId('tq-card-b1')).toBeTruthy()
    // click nodeA → only nodeA's cards remain
    fireEvent.click(screen.getByTestId('tq-node-filter-nodeA'))
    expect(screen.getByTestId('tq-card-a1')).toBeTruthy()
    expect(screen.queryByTestId('tq-card-b1')).toBeNull()
  })
})

describe('TaskQuestionList focusSourceNode (D13 canvas-badge jump)', () => {
  test('a fresh focusSourceNode.key filters the board to that node — incl. the same node twice', async () => {
    await wrapFocus([
      entry({ id: 'a1', sourceNodeId: 'nodeA', phase: 'pending' }),
      entry({ id: 'b1', sourceNodeId: 'nodeB', phase: 'pending' }),
    ])
    // Initially unfiltered: both cards visible.
    expect(screen.getByTestId('tq-card-a1')).toBeTruthy()
    expect(screen.getByTestId('tq-card-b1')).toBeTruthy()

    // Push nodeA → board narrows to nodeA.
    fireEvent.click(screen.getByTestId('push-nodeA'))
    expect(screen.getByTestId('tq-card-a1')).toBeTruthy()
    expect(screen.queryByTestId('tq-card-b1')).toBeNull()

    // Push nodeB → board switches to nodeB.
    fireEvent.click(screen.getByTestId('push-nodeB'))
    expect(screen.getByTestId('tq-card-b1')).toBeTruthy()
    expect(screen.queryByTestId('tq-card-a1')).toBeNull()

    // Reset the filter via the in-board "All nodes" chip (does NOT touch focus
    // state), then push nodeA AGAIN. The effect keys off `.key`, so the same
    // node with a fresh key must re-apply the filter (a nodeId-keyed effect
    // would no-op here and leave the board unfiltered).
    const allNodesChip = within(screen.getByTestId('tq-node-filter')).getAllByRole('button')[0]
    fireEvent.click(allNodesChip!)
    expect(screen.getByTestId('tq-card-b1')).toBeTruthy()
    fireEvent.click(screen.getByTestId('push-nodeA'))
    expect(screen.getByTestId('tq-card-a1')).toBeTruthy()
    expect(screen.queryByTestId('tq-card-b1')).toBeNull()
  })
})
