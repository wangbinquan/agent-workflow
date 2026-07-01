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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useRef, useState } from 'react'
import { api, ApiError } from '@/api/client'
import { TaskQuestionList, type TaskQuestionEntry } from '../src/components/tasks/TaskQuestionList'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

afterEach(() => {
  // cleanup() unmounts React trees (incl. portal Dialogs) before the next test —
  // a manual `document.body.innerHTML = ''` fights React's portal removal (removeChild).
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
  sealed: false,
  answerSummary: null,
  ...over,
})

// RFC-128 P4/P5: the board no longer renders a per-card <Link> (the /clarify jump entry was
// removed). The harness still mounts a router context (with the /clarify route registered) for
// stability — TanStack tolerates an unused router and the focus-jump harness reuses this shape.
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
    // sealed:true — 「加入待下发」only shows once the answer is sealed (待下发 gate, below);
    // an unsealed pending card hides the button (the server would reject the stage anyway).
    await wrap([entry({ id: 'e1', phase: 'pending', staged: false, sealed: true })])
    // A pending card now has both a "复制" and a stage button (RFC-120 §15), so target
    // the stage button by its stable testid rather than the (ambiguous) sole role.
    fireEvent.click(screen.getByTestId('tq-stage-e1'))
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
        // A designer entry only exists once its source question is sealed, so it carries the
        // 加入待下发 button (which the button-count assertion below relies on).
        sealed: true,
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

  // RFC-127 T4 回归锁：「改派(指定处理 agent)」对**任意角色**(self/questioner/designer)开放，
  // 限在**未下发态**(待指派 pending / 待下发 staged) —— 借壳顶替让 self/questioner 也能改派。
  // 已下发(processing/awaiting_confirm)/终态(done) 一律只读显示目标。后端 reassignTaskQuestion
  // 同样以 `dispatched_at IS NULL` + 非终态拒绝已下发改派，前端把入口收敛到未下发态与之对齐。
  // (Reverses RFC-120's "下拉只在 pending designer 卡" lock — staged & self/questioner now
  // show it; Select trigger 是 role="combobox"，components/Select.tsx。)
  test('改派下拉对任意角色开放于未下发态(pending/staged)；已下发/终态只读', async () => {
    await wrap([
      entry({ id: 'p-self', phase: 'pending', roleKind: 'self' }),
      entry({ id: 'p-q', phase: 'pending', roleKind: 'questioner' }),
      entry({ id: 'st-d', phase: 'staged', roleKind: 'designer' }),
      entry({ id: 'st-self', phase: 'staged', roleKind: 'self' }),
      entry({ id: 'pr', phase: 'processing', roleKind: 'designer' }),
      entry({ id: 'ac', phase: 'awaiting_confirm', roleKind: 'questioner' }),
      entry({ id: 'dn', phase: 'done', roleKind: 'designer' }),
    ])
    // 未下发态(pending/staged) × 任意角色 → 改派下拉(combobox)在场。
    for (const id of ['p-self', 'p-q', 'st-d', 'st-self']) {
      expect(within(screen.getByTestId(`tq-card-${id}`)).queryByRole('combobox')).toBeTruthy()
    }
    // 已下发(processing/awaiting_confirm) + 终态(done) → 只读，无改派下拉。
    for (const id of ['pr', 'ac', 'dn']) {
      expect(within(screen.getByTestId(`tq-card-${id}`)).queryByRole('combobox')).toBeNull()
    }
  })

  test('empty list renders the empty state', async () => {
    await wrap([])
    expect(screen.queryByTestId('task-questions-board')).toBeNull()
  })

  // RFC-128 P4/P5 (用户 2026-07-01) — the per-card "去回答/查看" Link to /clarify/$nodeRunId is
  // REMOVED (全删：回答 + 查看都删). The centralized answer pane is the single answer entry now;
  // answered content shows via the card's answerSummary. Regression lock for the deletion (reverses
  // the old "每张卡片给出回答路径 → 链到 /clarify 反问页" assertion).
  test('每张卡片不再有跳按轮次反问页的入口（tq-answer Link 全删）', async () => {
    await wrap([
      entry({ id: 'e1', phase: 'pending', originNodeRunId: 'run-xyz' }),
      entry({
        id: 'e2',
        phase: 'awaiting_confirm',
        originNodeRunId: 'run-abc',
        answerSummary: 'my answer',
      }),
    ])
    // Neither an unanswered (pending) nor an answered (awaiting_confirm) card exposes the Link.
    expect(screen.queryByTestId('tq-answer-e1')).toBeNull()
    expect(screen.queryByTestId('tq-answer-e2')).toBeNull()
    // No anchor to any /clarify round page remains anywhere on the board.
    expect(document.querySelector('a[href^="/clarify/"]')).toBeNull()
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
      // RFC-128: a fully-done source STILL gets a chip (the filter lists ALL source nodes).
      entry({ id: 'c1', sourceNodeId: 'nodeC', phase: 'done', roleKind: 'designer' }),
    ])
    // RFC-128: per-node count chips count ALL phases (incl. done): nodeA=2, nodeB=1, nodeC=1.
    expect(screen.getByTestId('tq-node-filter-nodeA').textContent).toContain('2')
    expect(screen.getByTestId('tq-node-filter-nodeB').textContent).toContain('1')
    expect(screen.getByTestId('tq-node-filter-nodeC').textContent).toContain('1')
    // all three cards visible initially
    expect(screen.getByTestId('tq-card-a1')).toBeTruthy()
    expect(screen.getByTestId('tq-card-b1')).toBeTruthy()
    // click nodeA → only nodeA's cards remain
    fireEvent.click(screen.getByTestId('tq-node-filter-nodeA'))
    expect(screen.getByTestId('tq-card-a1')).toBeTruthy()
    expect(screen.queryByTestId('tq-card-b1')).toBeNull()
  })

  // RFC-124 source-lock — board action buttons are visually unified: every `.btn`
  // inside a card is `btn--sm` (incl. ConfirmButton size="sm"); no full-size `.btn`
  // and no `btn--xs` survive. Locks the "按钮样式不统一" fix from this RFC.
  test('RFC-124: all in-card action buttons are unified to btn--sm', async () => {
    await wrap([entry({ id: 'e1', phase: 'awaiting_confirm', answerSummary: 'a' })])
    const card = screen.getByTestId('tq-card-e1')
    const btns = Array.from(card.querySelectorAll('.btn'))
    expect(btns.length).toBeGreaterThan(0)
    for (const b of btns) {
      expect(b.className).toContain('btn--sm')
      expect(b.className).not.toContain('btn--xs')
    }
  })
})

// 用户 2026-07-01 —「加入待下发」only makes sense once the question is answered (sealed):
// the server stage gate rejects staging an unsealed entry (ConflictError
// 'task-question-not-sealed', services/taskQuestions.ts isEntrySealed/stageTaskQuestion), so
// an unanswered 待指派 card must NOT show the 加入待下发 button (a shown-but-always-erroring
// button is worse than an absent one). 移出待下发 (unstage) stays available on a staged card
// regardless of seal so a mistaken stage can be undone. Locks TaskQuestionList `hasStage` in
// agreement with that server gate.
describe('TaskQuestionList 待下发 gate (加入 hidden until answered)', () => {
  test('未回答(unsealed)的待指派问题 → 不显示「加入待下发」按钮', async () => {
    await wrap([entry({ id: 'e1', phase: 'pending', staged: false, sealed: false })])
    // Card still renders (and can be reassigned) — only the 加入待下发 action is withheld.
    expect(screen.getByTestId('tq-card-e1')).toBeTruthy()
    expect(screen.queryByTestId('tq-stage-e1')).toBeNull()
  })

  test('已回答(sealed)的待指派问题 → 显示「加入待下发」按钮', async () => {
    await wrap([entry({ id: 'e1', phase: 'pending', staged: false, sealed: true })])
    expect(screen.getByTestId('tq-stage-e1')).toBeTruthy()
  })

  test('已在待下发(staged)的问题即便未 seal → 仍显示「移出待下发」按钮(可撤销)', async () => {
    // The unstage direction is ALWAYS allowed (server permits unstage on an unsealed entry)
    // so a mistaken stage can be undone even before the answer lands.
    await wrap([entry({ id: 's1', phase: 'staged', staged: true, sealed: false })])
    expect(screen.getByTestId('tq-stage-s1')).toBeTruthy()
  })
})

// RFC-128 §11.1 — batch-dispatch (一键下发) of staged (待下发) questions. 语义「进待下发=
// 已确定，批量下发=全下」：staged 卡**去 checkbox**（删 tq-select-*），「批量下发」收集当前
// 视图(尊重 source filter)的**全部** staged 条目 id 下发。golden-lock: no staged ⇒ no bar.
// (Reverses RFC-120 §18 的「per-card checkbox → 下发所选」——现在无逐卡勾选、全下当前视图。)
describe('TaskQuestionList batch-dispatch (RFC-128 §11.1)', () => {
  test('点「批量下发」→ POST dispatch 带**全部** staged ids（无需勾选；staged 卡无 checkbox）', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    await wrap([
      entry({ id: 's1', phase: 'staged', roleKind: 'designer' }),
      entry({ id: 's2', phase: 'staged', roleKind: 'designer' }),
    ])
    // §11.1: staged 卡不再有勾选 checkbox（去 tq-select-*）。
    expect(screen.queryByTestId('tq-select-s1')).toBeNull()
    expect(screen.queryByTestId('tq-select-s2')).toBeNull()
    expect(within(screen.getByTestId('tq-card-s1')).queryByRole('checkbox')).toBeNull()
    // 批量下发按钮无需勾选即可用（仅 isPending 时禁用），点击即下发**全部** staged。
    const btn = screen.getByTestId('tq-batch-dispatch') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/dispatch', {
        entryIds: ['s1', 's2'],
      }),
    )
  })

  test('任何卡片都不渲染勾选控件（§11.1 去 checkbox：staged 也不例外）', async () => {
    await wrap([
      entry({ id: 's1', phase: 'staged', roleKind: 'designer' }),
      entry({ id: 'p1', phase: 'pending' }),
      entry({ id: 'c1', phase: 'awaiting_confirm' }),
      entry({ id: 'd1', phase: 'done', roleKind: 'designer' }),
    ])
    for (const id of ['s1', 'p1', 'c1', 'd1']) {
      expect(within(screen.getByTestId(`tq-card-${id}`)).queryByRole('checkbox')).toBeNull()
      expect(screen.queryByTestId(`tq-select-${id}`)).toBeNull()
    }
  })

  test('有 source filter 时批量下发只发该 filter 视图的 staged（尊重当前视图）', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    await wrap([
      entry({ id: 'a1', sourceNodeId: 'nodeA', phase: 'staged', roleKind: 'designer' }),
      entry({ id: 'a2', sourceNodeId: 'nodeA', phase: 'staged', roleKind: 'designer' }),
      entry({ id: 'b1', sourceNodeId: 'nodeB', phase: 'staged', roleKind: 'designer' }),
    ])
    // 过滤到 nodeA → 批量下发只发 nodeA 视图的 staged（a1,a2），不含 b1。
    fireEvent.click(screen.getByTestId('tq-node-filter-nodeA'))
    fireEvent.click(screen.getByTestId('tq-batch-dispatch'))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/dispatch', {
        entryIds: ['a1', 'a2'],
      }),
    )
  })

  test('golden-lock：无 staged 卡片 → 不渲染批量下发栏', async () => {
    await wrap([
      entry({ id: 'p1', phase: 'pending' }),
      entry({ id: 'c1', phase: 'awaiting_confirm' }),
    ])
    expect(screen.queryByTestId('tq-batch-dispatch-bar')).toBeNull()
    expect(screen.queryByTestId('tq-batch-dispatch')).toBeNull()
  })

  test('409 task-question-node-dispatch-in-flight → 显示错误提示（ErrorBanner）', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiError(409, 'task-question-node-dispatch-in-flight', 'node busy'),
    )
    await wrap([entry({ id: 's1', phase: 'staged', roleKind: 'designer' })])
    // §11.1: 无勾选步骤——直接点批量下发。
    fireEvent.click(screen.getByTestId('tq-batch-dispatch'))
    // ErrorBanner renders a .error-box notice (i18n-agnostic assertion)
    await waitFor(() => expect(document.querySelector('.error-box')).toBeTruthy())
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

// RFC-128 P4 (T9) — centralized answer pane entry button. Shown only on a deferred
// task that has ≥1 UNSEALED clarify question (the control channel is deferred-gated,
// like the manual-question tools). Clicking opens the pane (a portal Dialog).
async function wrapDeferred(entries: TaskQuestionEntry[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  // Seed the snapshot + each round so opening the pane needs no network.
  qc.setQueryData(['tasks', 'task-1', 'snapshot'], { workflowSnapshot: { nodes: [] } })
  for (const e of entries) {
    if (e.originNodeRunId === null) continue
    qc.setQueryData(['clarify', 'detail', e.originNodeRunId], {
      id: `rnd_${e.originNodeRunId}`,
      taskId: 'task-1',
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_src',
      askingShardKey: null,
      intermediaryNodeId: 'c1',
      intermediaryNodeRunId: e.originNodeRunId,
      intermediaryNodeTitle: null,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questions: [],
      status: 'awaiting_human',
      directive: null,
      sessionMode: null,
      designerRunTriggeredAt: null,
      abandonedAt: null,
      questionScopes: null,
      createdAt: 0,
      answeredAt: null,
      answeredBy: null,
      draftAnswers: null,
    })
  }
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <QueryClientProvider client={qc}>
        <TaskQuestionList
          taskId="task-1"
          nodeOptions={[{ id: 'designer', label: 'designer' }]}
          deferred
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

describe('TaskQuestionList centralized answer pane entry (RFC-128 T9)', () => {
  test('deferred + an unsealed CROSS pending question → entry button shows and opens the pane', async () => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
    await wrapDeferred([
      entry({
        id: 'e1',
        phase: 'pending',
        sealed: false,
        originNodeRunId: 'nr_a',
        sourceKind: 'cross',
        roleKind: 'questioner',
      }),
    ])
    fireEvent.click(screen.getByTestId('tq-open-answer-pane'))
    await waitFor(() => expect(screen.getByTestId('centralized-answer-dialog')).toBeTruthy())
  })

  test('deferred but every question sealed → no entry button', async () => {
    await wrapDeferred([
      entry({ id: 'e1', phase: 'awaiting_confirm', sealed: true, sourceKind: 'cross' }),
    ])
    expect(screen.queryByTestId('tq-open-answer-pane')).toBeNull()
  })

  test('deferred + an unsealed SELF-clarify pending question → entry button shows (RFC-128 P5-BC)', async () => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
    await wrapDeferred([
      entry({
        id: 'e1',
        phase: 'pending',
        sealed: false,
        originNodeRunId: 'nr_self',
        sourceKind: 'self',
        roleKind: 'self',
      }),
    ])
    // RFC-128 P5-BC: self-clarify is now answerable via the pane (park + dispatch path), so the
    // entry button shows for a self-only unsealed pool (was hidden under the P4 designer-mainline).
    fireEvent.click(screen.getByTestId('tq-open-answer-pane'))
    await waitFor(() => expect(screen.getByTestId('centralized-answer-dialog')).toBeTruthy())
  })

  test('non-deferred task with an unsealed pending question → no entry button', async () => {
    // `wrap` renders WITHOUT the deferred prop (default false).
    await wrap([
      entry({
        id: 'e1',
        phase: 'pending',
        sealed: false,
        originNodeRunId: 'nr_a',
        sourceKind: 'cross',
        roleKind: 'questioner',
      }),
    ])
    expect(screen.queryByTestId('tq-open-answer-pane')).toBeNull()
  })

  // RFC-128 P4/P5 — deleting the per-card answer Link must NOT touch the other card actions:
  // 改派 Select (combobox) / tq-stage / tq-copy (deferred) / confirm all remain.
  test('删 tq-answer 后其它卡片操作仍在：改派 Select / tq-stage / tq-copy / confirm', async () => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
    await wrapDeferred([
      entry({
        id: 'p1',
        phase: 'pending',
        originNodeRunId: 'nr_p',
        sourceKind: 'cross',
        roleKind: 'designer',
        // sealed:true so the 加入待下发 button is present (待下发 gate hides it while unsealed);
        // this test asserts tq-stage-p1 survives the tq-answer removal.
        sealed: true,
      }),
      entry({
        id: 'c1',
        phase: 'awaiting_confirm',
        originNodeRunId: 'nr_c',
        sourceKind: 'cross',
        roleKind: 'designer',
      }),
    ])
    const p1 = screen.getByTestId('tq-card-p1')
    // pending card keeps reassign Select (combobox) + stage + copy — but exposes NO answer Link.
    expect(within(p1).queryByRole('combobox')).toBeTruthy()
    expect(within(p1).getByTestId('tq-stage-p1')).toBeTruthy()
    expect(within(p1).getByTestId('tq-copy-p1')).toBeTruthy()
    expect(within(p1).queryByTestId('tq-answer-p1')).toBeNull()
    // awaiting_confirm card keeps its confirm control; still no answer Link.
    const c1 = screen.getByTestId('tq-card-c1')
    expect(within(c1).getAllByRole('button').length).toBeGreaterThan(0)
    expect(within(c1).queryByTestId('tq-answer-c1')).toBeNull()
  })

  // RFC-128 P4/P5 (用户 2026-07-01) — the pane + its entry button tighten to 待指派 (pending)
  // only. An unsealed but already-dispatched (processing) / confirmed (done) question no longer
  // feeds the pane, so with NO pending question the entry button hides (even while deferred).
  test('deferred + 未 seal 但只有 processing/done（无 pending）→ 无统一入口按钮', async () => {
    await wrapDeferred([
      entry({
        id: 'e1',
        phase: 'processing',
        sealed: false,
        originNodeRunId: 'nr_p',
        sourceKind: 'cross',
        roleKind: 'designer',
      }),
      entry({
        id: 'e2',
        phase: 'done',
        sealed: false,
        originNodeRunId: 'nr_d',
        sourceKind: 'cross',
        roleKind: 'designer',
      }),
    ])
    expect(screen.queryByTestId('tq-open-answer-pane')).toBeNull()
  })
})
