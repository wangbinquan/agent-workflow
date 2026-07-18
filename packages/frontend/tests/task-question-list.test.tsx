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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  autoDispatchDeferred: false,
  sealed: false,
  answerSummary: null,
  ...over,
})

// RFC-128 P4/P5: the board no longer renders a per-card <Link> (the /clarify jump entry was
// removed). The harness still mounts a router context (with the /clarify route registered) for
// stability — TanStack tolerates an unused router and the focus-jump harness reuses this shape.
async function wrap(
  entries: TaskQuestionEntry[],
  nodeOptions: { id: string; label: string }[] = [
    { id: 'designer', label: 'designer' },
    { id: 'fixer', label: 'fixer' },
  ],
) {
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
        <TaskQuestionList taskId="task-1" nodeOptions={nodeOptions} />
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
// can drive `focusTargetNode` and assert the board filters to that handler node
// — incl. pushing the SAME node twice (a new key must still re-apply the filter).
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
        focusTargetNode={focus}
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
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValue([
        entry({ id: 'e1', phase: 'staged', staged: true, sealed: true }),
      ] as never)
    // sealed:true — 「加入待下发」only shows once the answer is sealed (待下发 gate, below);
    // an unsealed pending card hides the button (the server would reject the stage anyway).
    await wrap([entry({ id: 'e1', phase: 'pending', staged: false, sealed: true })])
    // Target the stage button by its stable testid rather than a role query.
    fireEvent.click(screen.getByTestId('tq-stage-e1'))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/e1/stage', { staged: true }),
    )
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/tasks/task-1/questions'))
  })

  // RFC-162: retired — collapse (and its `tq-collapse-notice` knowledge text) plus the
  // 'collapsed-to-questioner' / 'collapsed-to-designer' reassign actions were DELETED. Reassign
  // 归一 no longer MOVES the asker's card: it ADDS / REMOVES a designer handler (action is now
  // added-designer / removed-designer / moved-manual) and the board simply invalidates +
  // re-renders — NO notice. The old RFC-138 / RFC-140 collapse-notice cases are gone; the
  // surviving 「改派下拉 → POST /reassign {targetNodeId}」behaviour is locked below instead,
  // together with a regression lock that the deleted notice never reappears.
  test('改派下拉 → POST /reassign {targetNodeId}；改派后不再出现 collapse 知会文案（RFC-162）', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ ok: true, action: 'removed-designer' } as never)
    // reassign 成功 → invalidate → refetch：返回更新后的题池（该 designer 卡回退成单卡）。
    const get = vi.spyOn(api, 'get').mockResolvedValue([
      entry({
        id: 'e1',
        phase: 'pending',
        sourceKind: 'cross',
        roleKind: 'questioner',
        sourceNodeId: 'asker',
        defaultTargetNodeId: 'asker',
        effectiveTargetNodeId: 'asker',
      }),
    ] as never)
    await wrap(
      [
        entry({
          id: 'e1',
          phase: 'pending',
          sourceKind: 'cross',
          roleKind: 'designer',
          sourceNodeId: 'asker',
          defaultTargetNodeId: 'designer',
          effectiveTargetNodeId: 'designer',
        }),
      ],
      [
        { id: 'asker', label: 'asker' },
        { id: 'designer', label: 'designer' },
      ],
    )
    const card = screen.getByTestId('tq-card-e1')
    fireEvent.click(within(card).getAllByRole('combobox')[0]!)
    const opt = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent ?? '').includes('asker'),
    )
    expect(opt).toBeDefined()
    fireEvent.mouseDown(opt!)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/e1/reassign', {
        targetNodeId: 'asker',
      }),
    )
    // RFC-162: collapse UI deleted — no knowledge notice ever renders after a reassign.
    expect(screen.queryByTestId('tq-collapse-notice')).toBeNull()
    void get
  })

  // RFC-140 W2 — auto-split defer 徽标：已点过批量下发、等续跑结束后自动补发的 staged 卡。
  test('RFC-140: an auto-dispatch-deferred staged card shows the queued badge', async () => {
    await wrap([
      entry({ id: 'e1', phase: 'staged', staged: true, autoDispatchDeferred: true, sealed: true }),
      entry({ id: 'e2', phase: 'staged', staged: true, sealed: true }),
    ])
    expect(screen.getByTestId('tq-auto-dispatch-chip-e1')).toBeTruthy()
    expect(screen.queryByTestId('tq-auto-dispatch-chip-e2')).toBeNull()
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
    // RFC-163: 未下发条目按 (origin, questionId) 收拢成一张卡——这里每条代表一个**独立问题**
    // （各配独立 questionId），断言的是逐卡改派可用性，非分组行为（分组见 grouping describe）。
    await wrap([
      entry({ id: 'p-self', questionId: 'q-ps', phase: 'pending', roleKind: 'self' }),
      entry({ id: 'p-q', questionId: 'q-pq', phase: 'pending', roleKind: 'questioner' }),
      entry({ id: 'st-d', questionId: 'q-std', phase: 'staged', roleKind: 'designer' }),
      entry({ id: 'st-self', questionId: 'q-sts', phase: 'staged', roleKind: 'self' }),
      entry({ id: 'pr', questionId: 'q-pr', phase: 'processing', roleKind: 'designer' }),
      entry({ id: 'ac', questionId: 'q-ac', phase: 'awaiting_confirm', roleKind: 'questioner' }),
      entry({ id: 'dn', questionId: 'q-dn', phase: 'done', roleKind: 'designer' }),
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

  // 2026-07-02 badge-dimension fix (用户拍板, task …QMGP5): the node filter groups by the
  // HANDLER node (effectiveTargetNodeId = override ?? default), NOT the asking source node.
  test('D13: node filter chips group by HANDLER (effective target) + click narrows the board', async () => {
    await wrap([
      // RFC-163: 各条代表独立问题（独立 questionId）——本测锁 filter chip 维度，非分组。
      entry({ id: 'a1', questionId: 'q-a1', effectiveTargetNodeId: 'nodeA', phase: 'pending' }),
      entry({ id: 'a2', questionId: 'q-a2', effectiveTargetNodeId: 'nodeA', phase: 'processing' }),
      entry({ id: 'b1', questionId: 'q-b1', effectiveTargetNodeId: 'nodeB', phase: 'pending' }),
      // RFC-128: a fully-done node STILL gets a chip (the filter lists ALL handler nodes).
      entry({
        id: 'c1',
        questionId: 'q-c1',
        effectiveTargetNodeId: 'nodeC',
        phase: 'done',
        roleKind: 'designer',
      }),
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

  // Regression lock for the …QMGP5 case: a question ASKED by the designer but reassigned
  // (override) to a downstream handler must count on the HANDLER's chip and land in the
  // HANDLER's filter view — the asker's chip must not include it. A manual question
  // (sourceNodeId null) gets a chip via its target instead of vanishing.
  test('改派条目归到承接节点的 chip/视图（非提问节点）；manual 也有归属', async () => {
    await wrap([
      // asked by designer, handled by designer (normal self question)
      entry({ id: 'd1', sourceNodeId: 'designer', effectiveTargetNodeId: 'designer' }),
      // asked by designer, REASSIGNED to fixer → counts on fixer, not designer
      entry({
        id: 'r1',
        sourceNodeId: 'designer',
        overrideTargetNodeId: 'fixer',
        effectiveTargetNodeId: 'fixer',
        phase: 'processing',
      }),
      // manual question: no source node, targeted at fixer
      entry({
        id: 'm1',
        sourceKind: 'manual',
        roleKind: 'designer',
        sourceNodeId: null,
        originNodeRunId: null,
        defaultTargetNodeId: 'fixer',
        effectiveTargetNodeId: 'fixer',
      }),
    ])
    expect(screen.getByTestId('tq-node-filter-designer').textContent).toContain('1')
    expect(screen.getByTestId('tq-node-filter-fixer').textContent).toContain('2')
    // fixer view = the reassigned + the manual entry; the designer-handled one is out
    fireEvent.click(screen.getByTestId('tq-node-filter-fixer'))
    expect(screen.getByTestId('tq-card-r1')).toBeTruthy()
    expect(screen.getByTestId('tq-card-m1')).toBeTruthy()
    expect(screen.queryByTestId('tq-card-d1')).toBeNull()
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

// 用户 2026-07-02 拍板（推翻 RFC-133 §4 逐卡勾选、恢复 RFC-128 §11.1 语义）——「进待下发=
// 已确定，批量下发=全下」：一键下发当前视图（尊重节点 filter）的**全部** staged 条目；
// 卡片不再渲染任何选择控件（tq-select-* 全删）。
describe('TaskQuestionList batch-dispatch（全下、无逐卡勾选）', () => {
  test('点批量下发 → POST 全部 staged ids（无需任何勾选步骤）', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    await wrap([
      entry({ id: 's1', phase: 'staged', roleKind: 'designer' }),
      entry({ id: 's2', phase: 'staged', roleKind: 'designer' }),
    ])
    const btn = screen.getByTestId('tq-batch-dispatch') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/dispatch', {
        entryIds: ['s1', 's2'],
      }),
    )
  })

  test('任何相位的卡片都不再渲染勾选控件（tq-select-* / checkbox 全删）', async () => {
    await wrap([
      // RFC-163: 独立 questionId——本测锁「无勾选控件」，非分组。
      entry({ id: 's1', questionId: 'q-s1', phase: 'staged', roleKind: 'designer' }),
      entry({ id: 'p1', questionId: 'q-p1', phase: 'pending' }),
      entry({ id: 'c1', questionId: 'q-c1', phase: 'awaiting_confirm' }),
      entry({ id: 'd1', questionId: 'q-d1', phase: 'done', roleKind: 'designer' }),
    ])
    for (const id of ['s1', 'p1', 'c1', 'd1']) {
      expect(within(screen.getByTestId(`tq-card-${id}`)).queryByRole('checkbox')).toBeNull()
      expect(screen.queryByTestId(`tq-select-${id}`)).toBeNull()
    }
  })

  test('有节点 filter 时发该 filter 视图中的全部 staged（不含视图外的）', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    await wrap([
      // RFC-163: 三条独立问题（独立 questionId）——本测锁「filter 视图范围的批量下发」；
      // 组内跨节点整组下发另见 grouping describe（P1 保全组）。
      entry({
        id: 'a1',
        questionId: 'q-a1',
        effectiveTargetNodeId: 'nodeA',
        phase: 'staged',
        roleKind: 'designer',
      }),
      entry({
        id: 'a2',
        questionId: 'q-a2',
        effectiveTargetNodeId: 'nodeA',
        phase: 'staged',
        roleKind: 'designer',
      }),
      entry({
        id: 'b1',
        questionId: 'q-b1',
        effectiveTargetNodeId: 'nodeB',
        phase: 'staged',
        roleKind: 'designer',
      }),
    ])
    // 过滤到 nodeA → 发 nodeA 视图的全部 staged（a1+a2），不含 b1。
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

  test('409 in-flight 带 details.nodeId → 错误提示含节点 label（nodeOptions 映射）', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiError(409, 'task-question-node-dispatch-in-flight', 'node busy', {
        nodeId: 'fixer',
        runId: 'r1',
        runStatus: 'pending',
      }),
    )
    await wrap([entry({ id: 's1', phase: 'staged', roleKind: 'designer' })])
    fireEvent.click(screen.getByTestId('tq-batch-dispatch'))
    await waitFor(() => expect(document.querySelector('.error-box')).toBeTruthy())
    // RFC-133: the banner names the blocker node (label resolved via nodeOptions).
    expect(document.querySelector('.error-box')?.textContent ?? '').toContain('fixer')
  })

  test('409 in-flight 无 details → 回退静态文案（仍显示 ErrorBanner）', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiError(409, 'task-question-node-dispatch-in-flight', 'node busy'),
    )
    await wrap([entry({ id: 's1', phase: 'staged', roleKind: 'designer' })])
    fireEvent.click(screen.getByTestId('tq-batch-dispatch'))
    await waitFor(() => expect(document.querySelector('.error-box')).toBeTruthy())
  })
})

describe('TaskQuestionList focusTargetNode (D13 canvas-badge jump)', () => {
  test('a fresh focusTargetNode.key filters the board to that handler node — incl. the same node twice', async () => {
    await wrapFocus([
      // RFC-163: 两条独立问题（独立 questionId）——本测锁画布 badge 聚焦，非分组。
      entry({ id: 'a1', questionId: 'q-a1', effectiveTargetNodeId: 'nodeA', phase: 'pending' }),
      entry({ id: 'b1', questionId: 'q-b1', effectiveTargetNodeId: 'nodeB', phase: 'pending' }),
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

  test('deferred but every question sealed AND past pending → no entry button', async () => {
    await wrapDeferred([
      entry({ id: 'e1', phase: 'awaiting_confirm', sealed: true, sourceKind: 'cross' }),
    ])
    expect(screen.queryByTestId('tq-open-answer-pane')).toBeNull()
  })

  // RFC-136（用户 2026-07-02 拍板）— 已答（sealed）的待指派题现在可重答：入口按钮对
  // 「全部已答但仍在待指派」的池子也显示（移出待下发的题要能改答案）。
  test('RFC-136: 全部 sealed 但仍 pending（待指派）→ 入口按钮显示', async () => {
    await wrap([
      entry({ id: 'e1', phase: 'pending', sealed: true, originNodeRunId: 'nr_a' }),
      entry({ id: 'e2', phase: 'pending', sealed: true, originNodeRunId: 'nr_b' }),
    ])
    expect(screen.getByTestId('tq-open-answer-pane')).toBeTruthy()
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

  test('RFC-132 PR-F: an unsealed pending question always shows the entry button (flag gone)', async () => {
    // The unified model made every task deferred-dispatch — the centralized-answer entry
    // (previously gated on the per-task deferred prop) is always available.
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
    expect(screen.getByTestId('tq-open-answer-pane')).toBeTruthy()
  })

  // RFC-128 P4/P5 — deleting the per-card answer Link must NOT touch the other card actions:
  // 改派 Select (combobox) / tq-stage / confirm all remain. (2026-07-02 用户拍板: the per-card
  // 复制 button was itself removed, so it left this list — see the 复制-removal lock below.)
  test('删 tq-answer 后其它卡片操作仍在：改派 Select / tq-stage / confirm', async () => {
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
    // pending card keeps reassign Select (combobox) + stage — but exposes NO answer Link.
    expect(within(p1).queryByRole('combobox')).toBeTruthy()
    expect(within(p1).getByTestId('tq-stage-p1')).toBeTruthy()
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

// 2026-07-02 (用户拍板) — 问题列表的来源节点 / 处理节点 / 节点 filter chip 显示节点名
// （nodeOptions label，tasks.detail 经 resolveNodeNameFromSnapshot 解析），不再裸渲染节点 ID；
// nodeOptions 查无此节点时回退原 id（快照缺节点的防御路径）。
describe('TaskQuestionList 节点名显示（非节点 ID）', () => {
  const NAMED_OPTIONS = [
    { id: 'node-1', label: '设计师' },
    { id: 'node-2', label: '修复者' },
  ]

  test('卡片 meta 的来源节点与处理节点显示节点名，不显示裸节点 ID', async () => {
    await wrap(
      [
        // processing → 处理节点为只读文本（非改派下拉），走 labelFor 文本路径。
        entry({
          id: 'e1',
          phase: 'processing',
          sourceNodeId: 'node-1',
          defaultTargetNodeId: 'node-2',
          effectiveTargetNodeId: 'node-2',
        }),
      ],
      NAMED_OPTIONS,
    )
    const meta = screen.getByTestId('tq-card-e1').querySelector('.task-questions__meta')
    expect(meta?.textContent).toContain('设计师')
    expect(meta?.textContent).toContain('修复者')
    expect(meta?.textContent).not.toContain('node-1')
    expect(meta?.textContent).not.toContain('node-2')
  })

  test('节点 filter chip 显示节点名（计数不变）', async () => {
    await wrap(
      [
        entry({
          id: 'e1',
          phase: 'pending',
          sourceNodeId: 'node-1',
          effectiveTargetNodeId: 'node-2',
        }),
      ],
      NAMED_OPTIONS,
    )
    const chip = screen.getByTestId('tq-node-filter-node-2')
    expect(chip.textContent).toContain('修复者')
    expect(chip.textContent).toContain('1')
    expect(chip.textContent).not.toContain('node-2')
  })

  test('nodeOptions 查无此节点 → 回退显示原 id（防御路径）', async () => {
    await wrap(
      [
        entry({
          id: 'e1',
          phase: 'processing',
          sourceNodeId: 'ghost-src',
          effectiveTargetNodeId: 'ghost-tgt',
        }),
      ],
      NAMED_OPTIONS,
    )
    const meta = screen.getByTestId('tq-card-e1').querySelector('.task-questions__meta')
    expect(meta?.textContent).toContain('ghost-src')
    expect(meta?.textContent).toContain('ghost-tgt')
  })

  test('manual 问题（无来源节点）仍显示「手动」占位，不受节点名解析影响', async () => {
    await wrap(
      [
        entry({
          id: 'm1',
          phase: 'processing',
          sourceKind: 'manual',
          roleKind: 'designer',
          sourceNodeId: null,
          originNodeRunId: null,
          effectiveTargetNodeId: 'node-2',
        }),
      ],
      NAMED_OPTIONS,
    )
    const meta = screen.getByTestId('tq-card-m1').querySelector('.task-questions__meta')
    expect(meta?.textContent).toContain('修复者')
    expect(meta?.textContent).not.toContain('node-2')
  })
})

// 2026-07-02 (用户拍板) —「复制待指派问题」功能整体移除：待指派卡不再渲染 tq-copy-* 按钮，
// 唯一的手动问题入口是工具栏的「+ 新增问题」（QuestionAuthorForm 的 initial 预填 prop 一并删除）。
describe('TaskQuestionList 复制功能移除 (2026-07-02)', () => {
  test('待指派卡片不再有复制按钮（tq-copy-* 全删）', async () => {
    await wrap([
      entry({ id: 'e1', phase: 'pending', sealed: true }),
      entry({ id: 'e2', phase: 'pending', sealed: false }),
      entry({ id: 's1', phase: 'staged', roleKind: 'designer' }),
    ])
    for (const id of ['e1', 'e2', 's1']) {
      expect(screen.queryByTestId(`tq-copy-${id}`)).toBeNull()
    }
    // 「+ 新增问题」入口保留。
    expect(screen.getByTestId('tq-add-question')).toBeTruthy()
  })
})

// RFC-163（用户 2026-07-10「下发前一问一卡、下发后各处理节点拆开」）— 分组卡组件锁。
// 改派后同一问题的 asker + 未下发 designer 收拢成一张卡（handler 行 +1、卡数不变），组级 stage
// 让整组一起进待下发，批量下发展开整组 id（含 off-filter 兄弟——Codex 设计门 P1 保全组），下发
// 后各自拆卡独立确认。任何 refactor 破坏这些立即变红。
describe('TaskQuestionList RFC-163 分组卡（下发前一问一卡）', () => {
  test('asker + 未下发 designer（改派后）→ 一张卡、两行 handler、卡数不变', async () => {
    await wrap([
      entry({ id: 's', roleKind: 'self', phase: 'pending', sealed: true }),
      entry({
        id: 'd',
        roleKind: 'designer',
        effectiveTargetNodeId: 'fixer',
        phase: 'pending',
        sealed: true,
      }),
    ])
    // 一张卡（rep = asker），designer 无独立卡。
    const card = screen.getByTestId('tq-card-s')
    expect(screen.queryByTestId('tq-card-d')).toBeNull()
    expect(card.classList.contains('task-questions__card--grouped')).toBe(true)
    // 卡内两行 handler：提问节点 + 增派修订，各显各的节点。
    const rows = within(card).getByTestId('tq-handlers-s')
    expect(within(rows).getByTestId('tq-handler-s').textContent).toContain('designer')
    expect(within(rows).getByTestId('tq-handler-d').textContent).toContain('fixer')
    // 卡级改派 Select 在场（锚定 asker）。
    expect(within(card).queryByRole('combobox')).toBeTruthy()
  })

  test('组级 stage：分组卡「加入待下发」→ 对每个 handler 各 POST 一次 /stage', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    const get = vi.spyOn(api, 'get').mockResolvedValue([
      entry({ id: 's', roleKind: 'self', phase: 'staged', staged: true, sealed: true }),
      entry({
        id: 'd',
        roleKind: 'designer',
        effectiveTargetNodeId: 'fixer',
        phase: 'staged',
        staged: true,
        sealed: true,
      }),
    ] as never)
    await wrap([
      entry({ id: 's', roleKind: 'self', phase: 'pending', sealed: true }),
      entry({
        id: 'd',
        roleKind: 'designer',
        effectiveTargetNodeId: 'fixer',
        phase: 'pending',
        sealed: true,
      }),
    ])
    fireEvent.click(screen.getByTestId('tq-stage-s'))
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/s/stage', { staged: true })
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/d/stage', { staged: true })
    })
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/tasks/task-1/questions'))
  })

  test('批量下发展开整组：staged 组的 entryIds 含 asker+designer（filter 到 asker 节点也不裁掉 off-filter designer——P1 保全组）', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    await wrap([
      entry({ id: 's', roleKind: 'self', phase: 'staged', staged: true, sealed: true }),
      entry({
        id: 'd',
        roleKind: 'designer',
        effectiveTargetNodeId: 'fixer',
        phase: 'staged',
        staged: true,
        sealed: true,
      }),
    ])
    // filter 到 asker 的节点（designer 的 fixer 不在 filter 上）→ 组按任一 handler 命中、整组保留。
    fireEvent.click(screen.getByTestId('tq-node-filter-designer'))
    expect(screen.getByTestId('tq-card-s')).toBeTruthy()
    fireEvent.click(screen.getByTestId('tq-batch-dispatch'))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/dispatch', {
        entryIds: ['s', 'd'],
      }),
    )
  })

  test('下发后拆开：processing/awaiting_confirm 的 asker 与 designer 各自单卡、各带独立确认', async () => {
    await wrap([
      entry({ id: 's', roleKind: 'self', phase: 'awaiting_confirm', answerSummary: 'ans' }),
      entry({
        id: 'd',
        roleKind: 'designer',
        effectiveTargetNodeId: 'fixer',
        phase: 'awaiting_confirm',
      }),
    ])
    const cardS = screen.getByTestId('tq-card-s')
    const cardD = screen.getByTestId('tq-card-d')
    expect(cardS.classList.contains('task-questions__card--grouped')).toBe(false)
    expect(cardD.classList.contains('task-questions__card--grouped')).toBe(false)
    // 各自有确认按钮（ConfirmButton 渲染为 button）。
    expect(within(cardS).getByRole('button', { name: /确认|Confirm/i })).toBeTruthy()
    expect(within(cardD).getByRole('button', { name: /确认|Confirm/i })).toBeTruthy()
  })

  test('源码锁：未下发列渲染必须走 groupBoardEntries（不得回退 per-entry 直渲染）', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'components', 'tasks', 'TaskQuestionList.tsx'),
      'utf8',
    )
    expect(src).toContain('groupBoardEntries')
    // 旧 per-entry 渲染的签名式样不得复活（列直接按 entry 过滤再逐条 Card）。
    expect(src).not.toContain('entries.filter((e) => e.phase === phase)')
  })
})
