// RFC-128 P4 (T9) — centralized answer pane.
//
// Locks:
//   1. groupAnswerableQuestions oracle — clarify-backed 待指派 (pending) questions grouped by
//      originNodeRunId in stable order, deduped. RFC-136: SEALED pending questions are now
//      included as re-answers (resubmitQuestionIds) — the pane prefills the committed answer
//      and resubmission overwrites in place (用户 2026-07-02 拍板).
//   2. isAnswerFilled oracle.
//   3. The dialog flattens the task's answerable questions (grouped by round) into
//      QuestionForm blocks; the SINGLE submit button seals each round's filled subset via
//      POST /api/clarify/:id/answers with defer:true + questionIds cap.
//   4. Submit is disabled until ≥1 answer is filled.
//   5. No answerable questions → empty state.
//   6. RFC-137 / RFC-162 — the pane answers self and cross rounds UNIFORMLY: NO
//      per-question scope UI is rendered for ANY round (fresh or re-answer) and submit
//      bodies never carry questionScopes. RFC-162 removed the scope concept entirely, so
//      there is no scope anywhere to send; the asker's own handler entry (self/questioner)
//      reruns to consume the answer. These locks guard against a picker or a questionScopes
//      body field being reintroduced here.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ClarifyRound } from '@agent-workflow/shared'
import { api } from '@/api/client'
import {
  CentralizedAnswerDialog,
  flattenCentralizedNavKeys,
  groupAnswerableQuestions,
} from '@/components/clarify/CentralizedAnswerDialog'
import { isAnswerFilled } from '@/lib/clarify/answers'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  // Catch-all so the post-submit invalidation refetch resolves quietly (the queries
  // under test are seeded with staleTime:Infinity, so this only serves stray refetches).
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  // jsdom lacks scrollIntoView; QuestionFormHandle.focus() calls it. 2026-07-10 the pane
  // auto-focuses the FIRST question on open, so EVERY renderDialog with questions now hits
  // focus() — patch file-wide (was previously only in the keyboard-nav describe).
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Default = an unsealed CROSS (designer-mainline) question — what the pane handles.
const entry = (over: Partial<TaskQuestionEntry>): TaskQuestionEntry => ({
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'Pick a strategy?',
  originNodeRunId: 'nr_a',
  sourceKind: 'cross',
  roleKind: 'questioner',
  sourceNodeId: 'questioner',
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

function round(over: Partial<ClarifyRound> & { intermediaryNodeRunId: string }): ClarifyRound {
  return {
    id: `rnd_${over.intermediaryNodeRunId}`,
    taskId: 'task-1',
    kind: 'cross',
    askingNodeId: 'questioner',
    askingNodeRunId: 'nr_src',
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    iteration: 0,
    questions: [
      {
        id: 'q1',
        title: 'Pick DB',
        kind: 'single',
        recommended: false,
        options: [
          { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
          { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
        ],
      },
    ],
    status: 'awaiting_human',
    directive: null,
    sessionMode: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt: 0,
    answeredAt: null,
    answeredBy: null,
    draftAnswers: null,
    ...over,
  }
}

/** A single-choice question with two options (digit '1' picks option 0). */
function singleQ(id: string, title = `Q ${id}`): ClarifyRound['questions'][number] {
  return {
    id,
    title,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function renderDialog(
  entries: TaskQuestionEntry[],
  rounds: ClarifyRound[],
  snapshot: unknown = { nodes: [] },
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  qc.setQueryData(['tasks', 'task-1', 'snapshot'], { workflowSnapshot: snapshot })
  for (const r of rounds) {
    qc.setQueryData(['clarify', 'detail', r.intermediaryNodeRunId], r)
  }
  return render(
    <QueryClientProvider client={qc}>
      <CentralizedAnswerDialog taskId="task-1" open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe('groupAnswerableQuestions (oracle)', () => {
  test('keeps clarify-backed pending questions — self AND cross (RFC-128 P5-BC), grouped by round; RFC-136: sealed pending 纳入为重答', () => {
    const groups = groupAnswerableQuestions([
      entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
      entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_b' }),
      entry({ id: 'c', questionId: 'q3', originNodeRunId: 'nr_a' }),
      // RFC-136: sealed pending → INCLUDED as a re-answer (was excluded pre-136).
      entry({ id: 'd', questionId: 'q4', originNodeRunId: 'nr_a', sealed: true }),
      // manual (no clarify round) → excluded
      entry({ id: 'e', questionId: 'q5', originNodeRunId: null, sourceKind: 'manual' }),
      // RFC-128 P5-BC: self-clarify is NOW included (park + dispatch path, no longer stranded).
      entry({
        id: 'f',
        questionId: 'q6',
        originNodeRunId: 'nr_self',
        sourceKind: 'self',
        roleKind: 'self',
      }),
    ])
    expect(groups).toEqual([
      { originNodeRunId: 'nr_a', questionIds: ['q1', 'q3', 'q4'], resubmitQuestionIds: ['q4'] },
      { originNodeRunId: 'nr_b', questionIds: ['q2'], resubmitQuestionIds: [] },
      { originNodeRunId: 'nr_self', questionIds: ['q6'], resubmitQuestionIds: [] },
    ])
  })

  test('dedupes a questionId that appears under multiple role rows in one round', () => {
    const groups = groupAnswerableQuestions([
      entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a', roleKind: 'questioner' }),
      entry({ id: 'b', questionId: 'q1', originNodeRunId: 'nr_a', roleKind: 'designer' }),
    ])
    expect(groups).toEqual([
      { originNodeRunId: 'nr_a', questionIds: ['q1'], resubmitQuestionIds: [] },
    ])
  })

  // RFC-128 P4/P5 (用户 2026-07-01) — the pool tightens to 待指派 (pending) only. A non-pending
  // entry (staged/processing/awaiting_confirm/done) is EXCLUDED regardless of seal state: the
  // control channel (defer → 待指派 → board dispatch) only applies BEFORE dispatch. RFC-136 keeps
  // this phase gate — a sealed STAGED question is still out (先移出待下发才能重答).
  test('只纳 pending 待指派：非 pending 条目（无论 seal 与否）被排除', () => {
    const groups = groupAnswerableQuestions([
      entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a', phase: 'pending' }),
      entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_b', phase: 'staged' }),
      entry({ id: 'c', questionId: 'q3', originNodeRunId: 'nr_c', phase: 'processing' }),
      entry({ id: 'd', questionId: 'q4', originNodeRunId: 'nr_d', phase: 'awaiting_confirm' }),
      entry({ id: 'e', questionId: 'q5', originNodeRunId: 'nr_e', phase: 'done' }),
      // sealed + staged → still excluded (重答范围仅待指派，D1).
      entry({ id: 'f', questionId: 'q6', originNodeRunId: 'nr_f', phase: 'staged', sealed: true }),
    ])
    expect(groups).toEqual([
      { originNodeRunId: 'nr_a', questionIds: ['q1'], resubmitQuestionIds: [] },
    ])
  })

  // RFC-136 — 半 staged 题不进池：cross 双角色条目只移回一行（另一行仍待下发）时，后端
  // 重 seal 守卫必 409（半新半旧）——把这种题放进面板等于可编辑但必失败的死路 UI。
  test('sealed 题存在非 pending 兄弟条目 → 整题不纳入（防 409 死路）', () => {
    const groups = groupAnswerableQuestions([
      // q1：questioner 行已移回 pending，designer 行仍 staged → 整题排除。
      entry({
        id: 'a',
        questionId: 'q1',
        originNodeRunId: 'nr_a',
        phase: 'pending',
        sealed: true,
        roleKind: 'questioner',
      }),
      entry({
        id: 'b',
        questionId: 'q1',
        originNodeRunId: 'nr_a',
        phase: 'staged',
        sealed: true,
        roleKind: 'designer',
      }),
      // q2：全部行 pending → 正常纳入为重答。
      entry({
        id: 'c',
        questionId: 'q2',
        originNodeRunId: 'nr_a',
        phase: 'pending',
        sealed: true,
        roleKind: 'questioner',
      }),
    ])
    expect(groups).toEqual([
      { originNodeRunId: 'nr_a', questionIds: ['q2'], resubmitQuestionIds: ['q2'] },
    ])
  })
})

// RFC-128 (用户 2026-07-01) — cross-round keyboard-nav order oracle. Locks: flatten in group
// (round) order; within a round follow the REPORTED render order; fall back to group.questionIds
// when a round hasn't reported yet.
describe('flattenCentralizedNavKeys (oracle)', () => {
  test('flattens rounds in group order + questions in reported render order (across boundaries)', () => {
    const groups = [
      { originNodeRunId: 'nr_a', questionIds: ['q1', 'q2'], resubmitQuestionIds: [] },
      { originNodeRunId: 'nr_b', questionIds: ['q3'], resubmitQuestionIds: [] },
    ]
    const reported = new Map<string, string[]>([
      ['nr_a', ['q1', 'q2']],
      ['nr_b', ['q3']],
    ])
    expect(flattenCentralizedNavKeys(groups, reported)).toEqual(['nr_a:q1', 'nr_a:q2', 'nr_b:q3'])
  })

  test('reported render order OVERRIDES group storage order; unreported round falls back to group', () => {
    const groups = [{ originNodeRunId: 'nr_a', questionIds: ['q1', 'q2'], resubmitQuestionIds: [] }]
    // Reported order is reversed vs storage → nav follows what the reviewer sees.
    expect(flattenCentralizedNavKeys(groups, new Map([['nr_a', ['q2', 'q1']]]))).toEqual([
      'nr_a:q2',
      'nr_a:q1',
    ])
    // A just-mounted round that hasn't reported yet stays navigable via group.questionIds.
    expect(flattenCentralizedNavKeys(groups, new Map())).toEqual(['nr_a:q1', 'nr_a:q2'])
  })
})

describe('isAnswerFilled (oracle)', () => {
  test('true for an option pick or custom text; false for empty / undefined', () => {
    const base = {
      questionId: 'q',
      selectedOptionIndices: [],
      selectedOptionLabels: [],
      customText: '',
    }
    expect(isAnswerFilled(undefined)).toBe(false)
    expect(isAnswerFilled(base)).toBe(false)
    expect(isAnswerFilled({ ...base, selectedOptionIndices: [0] })).toBe(true)
    expect(isAnswerFilled({ ...base, customText: 'x' })).toBe(true)
  })
})

describe('CentralizedAnswerDialog', () => {
  test('no answerable questions → empty state, submit disabled', async () => {
    // RFC-136: a sealed PENDING entry is now answerable (re-answer), so the empty pool is
    // built from past-pending entries instead (dispatched questions never enter the pane).
    renderDialog([entry({ id: 'a', sealed: true, phase: 'processing' })], [])
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy())
    expect((screen.getByTestId('centralized-answer-submit') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  test('self-clarify rounds ARE included in the pane (RFC-128 P5-BC)', async () => {
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_x' }),
        entry({
          id: 'b',
          questionId: 'qs',
          originNodeRunId: 'nr_self',
          sourceKind: 'self',
          roleKind: 'self',
        }),
      ],
      [
        round({ intermediaryNodeRunId: 'nr_x' }),
        round({
          intermediaryNodeRunId: 'nr_self',
          kind: 'self',
          askingNodeId: 'designer',
          targetConsumerNodeId: null,
          questions: [
            {
              id: 'qs',
              title: 'Self question',
              kind: 'single',
              recommended: false,
              options: [
                { label: 'A', description: '', recommended: false, recommendationReason: '' },
                { label: 'B', description: '', recommended: false, recommendationReason: '' },
              ],
            },
          ],
        }),
      ],
    )
    await waitFor(() => screen.getByTestId('centralized-round-nr_x'))
    // RFC-128 P5-BC: the self-clarify round NOW renders a block (it parks + board-dispatches).
    await waitFor(() => screen.getByTestId('centralized-round-nr_self'))
    // RFC-137: NO round renders scope UI — self and cross answer identically here.
    await waitFor(() => screen.getByTestId('clarify-question-qs'))
    expect(screen.queryByTestId('centralized-scope-qs')).toBeNull()
    expect(screen.queryByTestId('centralized-scope-q1')).toBeNull()
  })

  // 2026-07-02 (用户拍板) — 分组头显示提问节点的节点名（snapshot title → agentName → id 回退，
  // resolveNodeNameFromSnapshot），不再裸渲染 askingNodeId。id 取与任何 i18n 文案词都不撞的
  // 'node-x9'（en-US 文案本身含 "questioner" 一词）。
  test('分组头显示提问节点的节点名（snapshot 解析），不显示裸节点 ID', async () => {
    renderDialog(
      [entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' })],
      [round({ intermediaryNodeRunId: 'nr_a', askingNodeId: 'node-x9' })],
      {
        nodes: [{ id: 'node-x9', kind: 'agent-single', agentName: 'asker', title: '审查者' }],
      },
    )
    await waitFor(() => screen.getByTestId('centralized-round-nr_a'))
    const title = screen
      .getByTestId('centralized-round-nr_a')
      .querySelector('.card__title') as HTMLElement
    expect(title.textContent).toContain('审查者')
    expect(title.textContent).not.toContain('node-x9')
  })

  test('快照查无提问节点 → 分组头回退显示原节点 ID（防御路径）', async () => {
    renderDialog(
      [entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' })],
      [round({ intermediaryNodeRunId: 'nr_a' })],
      { nodes: [] },
    )
    await waitFor(() => screen.getByTestId('centralized-round-nr_a'))
    const title = screen
      .getByTestId('centralized-round-nr_a')
      .querySelector('.card__title') as HTMLElement
    expect(title.textContent).toContain('questioner')
  })
})

// RFC-136（用户 2026-07-02 拍板）— 已答（sealed）待指派题纳入面板为重答：预填**已提交答案**
// （忽略遗留草稿，D5）、显示「重新提交将覆盖」提示、提交体 questionIds 含重答题。
// RFC-137：面板不再渲染任何 scope UI（重答只读行也删）、提交体恒不含 questionScopes——
// D6「reseal 保持原 scope」由服务端锁定（question_scopes_json 原值），与前端无关。
describe('CentralizedAnswerDialog — RFC-136 重答', () => {
  test('reseal 题预填已提交答案（忽略 server draft）+ 显示重答提示', async () => {
    renderDialog(
      [entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a', sealed: true })],
      [
        round({
          intermediaryNodeRunId: 'nr_a',
          status: 'answered',
          answers: [
            {
              questionId: 'q1',
              selectedOptionIndices: [1],
              selectedOptionLabels: ['MySQL'],
              customText: 'committed detail',
            },
          ],
          // 遗留草稿（提交前的旧编辑态）——D5 要求被忽略，预填以已提交答案为基线。
          draftAnswers: {
            q1: { selectedOptionIndices: [0], customText: 'stale draft' },
          } as ClarifyRound['draftAnswers'],
        }),
      ],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    expect(screen.getByTestId('centralized-resubmit-hint-q1')).toBeTruthy()
    const radios = within(screen.getByTestId('clarify-question-q1')).getAllByRole('radio')
    // 已提交答案选项 1（MySQL）被预选；草稿的选项 0 未生效。
    expect((radios[1] as HTMLInputElement).checked).toBe(true)
    expect((radios[0] as HTMLInputElement).checked).toBe(false)
  })

  test('RFC-137：cross 重答题与 fresh 题均无任何 scope UI（含已提交 questioner scope 的轮）', async () => {
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a', sealed: true }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a', sealed: false }),
      ],
      [
        round({
          intermediaryNodeRunId: 'nr_a',
          questions: [singleQ('q1'), singleQ('q2')],
          answers: [
            {
              questionId: 'q1',
              selectedOptionIndices: [0],
              selectedOptionLabels: ['A'],
              customText: '',
            },
          ],
        }),
      ],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    // 重答题：无只读 scope 行、无 segmented；重答提示保留。
    expect(screen.queryByTestId('centralized-scope-readonly-q1')).toBeNull()
    expect(screen.queryByTestId('centralized-scope-q1')).toBeNull()
    expect(screen.getByTestId('centralized-resubmit-hint-q1')).toBeTruthy()
    // fresh 题：同样无任何 scope UI。
    expect(screen.queryByTestId('centralized-scope-q2')).toBeNull()
    expect(screen.queryByTestId('centralized-scope-readonly-q2')).toBeNull()
  })

  test('提交体：fresh+reseal 混合 → questionIds 含两者、恒不含 questionScopes（RFC-137）', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true } as never)
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a', sealed: true }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a', sealed: false }),
      ],
      [
        round({
          intermediaryNodeRunId: 'nr_a',
          questions: [singleQ('q1'), singleQ('q2')],
          answers: [
            {
              questionId: 'q1',
              selectedOptionIndices: [0],
              selectedOptionLabels: ['A'],
              customText: '',
            },
          ],
        }),
      ],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q2'))
    // 改 reseal 题的选项 + 回答 fresh 题。
    fireEvent.click(within(screen.getByTestId('clarify-question-q1')).getAllByRole('radio')[1]!)
    fireEvent.click(within(screen.getByTestId('clarify-question-q2')).getAllByRole('radio')[0]!)
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const body = post.mock.calls[0]?.[1] as {
      defer: boolean
      questionIds: string[]
      resubmitQuestionIds?: string[]
      questionScopes?: Record<string, string>
      answers: Array<{ questionId: string; selectedOptionIndices: number[] }>
    }
    expect(body.defer).toBe(true)
    expect([...body.questionIds].sort()).toEqual(['q1', 'q2'])
    // D7（Codex 实现门 P2）：重答按题显式声明——服务端只对声明的题放行覆盖。
    expect(body.resubmitQuestionIds).toEqual(['q1'])
    // RFC-162：scope 概念已删——面板恒不发 questionScopes（键都不出现），self/cross 同形。
    expect('questionScopes' in body).toBe(false)
    expect(body.answers.find((a) => a.questionId === 'q1')?.selectedOptionIndices).toEqual([1])
  })

  test('预填的重答答案立即计入提交集（不交互即可重新提交原答案）', async () => {
    renderDialog(
      [entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a', sealed: true })],
      [
        round({
          intermediaryNodeRunId: 'nr_a',
          answers: [
            {
              questionId: 'q1',
              selectedOptionIndices: [0],
              selectedOptionLabels: ['A'],
              customText: '',
            },
          ],
        }),
      ],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
  })
})

describe('CentralizedAnswerDialog — submit 流程', () => {
  test('flattens 2 rounds, single submit seals each round subset (defer + questionIds, no questionScopes)', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true } as never)
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_b' }),
      ],
      [
        round({ intermediaryNodeRunId: 'nr_a' }),
        round({
          intermediaryNodeRunId: 'nr_b',
          questions: [
            {
              id: 'q2',
              title: 'Pick lang',
              kind: 'single',
              recommended: false,
              options: [
                { label: 'TS', description: '', recommended: false, recommendationReason: '' },
                { label: 'Go', description: '', recommended: false, recommendationReason: '' },
              ],
            },
          ],
        }),
      ],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    await waitFor(() => screen.getByTestId('clarify-question-q2'))
    expect(screen.getByTestId('centralized-round-nr_a')).toBeTruthy()
    expect(screen.getByTestId('centralized-round-nr_b')).toBeTruthy()

    // Submit disabled before any answer is filled.
    expect((screen.getByTestId('centralized-answer-submit') as HTMLButtonElement).disabled).toBe(
      true,
    )

    // Fill the first option of each question.
    fireEvent.click(within(screen.getByTestId('clarify-question-q1')).getAllByRole('radio')[0]!)
    fireEvent.click(within(screen.getByTestId('clarify-question-q2')).getAllByRole('radio')[0]!)

    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    const calls = Object.fromEntries(post.mock.calls.map((c) => [c[0], c[1]]))
    expect(calls['/api/clarify/nr_a/answers']).toMatchObject({
      defer: true,
      directive: 'continue',
      questionIds: ['q1'],
    })
    expect(calls['/api/clarify/nr_b/answers']).toMatchObject({
      defer: true,
      directive: 'continue',
      questionIds: ['q2'],
    })
    // RFC-162: neither cross-round body carries questionScopes (scope removed entirely).
    expect('questionScopes' in (calls['/api/clarify/nr_a/answers'] as object)).toBe(false)
    expect('questionScopes' in (calls['/api/clarify/nr_b/answers'] as object)).toBe(false)
    // Only filled answers are submitted (subset cap matches answers).
    expect((calls['/api/clarify/nr_a/answers'] as { answers: unknown[] }).answers).toHaveLength(1)
  })

  // RFC-162 回归锁：把 RFC-128 P5-BC 的选择器重新引入面板（或恢复发送 questionScopes）
  // 会让本 case 变红。scope 概念已删，self/cross 在面板里完全同形。
  test('RFC-137/RFC-162: cross round renders NO scope picker; submit body carries NO questionScopes', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true } as never)
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_x' })],
      [round({ intermediaryNodeRunId: 'nr_x' })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    // No per-question scope UI for a cross fresh question.
    expect(screen.queryByTestId('centralized-scope-q1')).toBeNull()
    expect(screen.queryByTestId('centralized-scope-readonly-q1')).toBeNull()
    fireEvent.click(within(screen.getByTestId('clarify-question-q1')).getAllByRole('radio')[0]!)
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const body = post.mock.calls[0]![1] as Record<string, unknown>
    expect(body).toMatchObject({ defer: true, questionIds: ['q1'] })
    // Unsent scopes resolve server-side to the 'designer' default → the handler entry
    // targets the designer node (处理节点默认=设计节点).
    expect('questionScopes' in body).toBe(false)
  })
})

// RFC-128 (用户 2026-07-01) — cross-round keyboard navigation. Regression: the pane's QuestionForm
// previously got NO `ref` + NO `onAdvance`, so the digit/Enter hotkeys (which call onAdvance) were a
// silent no-op. This wires a GLOBAL ref Map + advanceFromQuestion so Enter / a single-choice digit
// key advances focus to the next question — including across round boundaries.
//
// 用户拍板 (2026-07-01): the "last question → auto-focus submit" convenience (and its whole
// pending/flush deferred-focus machinery — the source of a 4-round focus-timing edge) is REMOVED.
// Advancing off the LAST question is now a NO-OP: focus stays put, submit is NEVER auto-focused (the
// reviewer clicks / Tabs to submit). These lock cross-round advance + the 末问 no-op in BOTH submit
// states (already-enabled / just-enabled-this-keydown).
describe('CentralizedAnswerDialog — cross-round keyboard navigation', () => {
  // jsdom doesn't implement Element.prototype.scrollIntoView; QuestionForm's focus() handle calls
  // it, so patch it (per the QuestionForm focus test) — otherwise focus() throws.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  // 用户 2026-07-10 —「点开处理待指派问题弹框时，默认 focus 第一个问题，好使用快捷键答题」。
  // 打开弹框后（groups → 各轮 detail → QuestionForm 挂载的多段异步之后）自动聚焦平铺导航序
  // 的第一题 root（tabIndex=0），数字/Enter 热键即刻可用；且只聚焦一次（后续注册不再抢焦）。
  test('打开弹框自动聚焦第一题（跨轮取全局第一）→ 数字热键即刻可用', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
        entry({ id: 'c', questionId: 'q3', originNodeRunId: 'nr_b' }),
      ],
      [
        round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] }),
        round({ intermediaryNodeRunId: 'nr_b', questions: [singleQ('q3')] }),
      ],
    )
    const q1 = await screen.findByTestId('clarify-question-q1')
    // 自动聚焦经 rAF 异步落焦 → waitFor。全局第一题=第一轮的 q1（非 q2/q3）。
    await waitFor(() => expect(document.activeElement).toBe(q1))
    // 快捷键即刻可用：数字 1 直接选中第一个选项（无需先点击/Tab）。
    fireEvent.keyDown(q1, { key: '1' })
    await waitFor(() =>
      expect((within(q1).getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true),
    )
  })

  test('Enter advances focus across rounds; the LAST question is a NO-OP (submit NOT auto-focused)', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
        entry({ id: 'c', questionId: 'q3', originNodeRunId: 'nr_b' }),
      ],
      [
        round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] }),
        round({ intermediaryNodeRunId: 'nr_b', questions: [singleQ('q3')] }),
      ],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    await waitFor(() => screen.getByTestId('clarify-question-q3'))

    const q1 = screen.getByTestId('clarify-question-q1')
    const q2 = screen.getByTestId('clarify-question-q2')
    const q3 = screen.getByTestId('clarify-question-q3')
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement

    // Fill one answer so the submit button is ENABLED. This makes the last-question NO-OP assertion
    // meaningful: submit COULD receive focus (it's enabled), yet advancing off the last question
    // must NOT move focus onto it (用户拍板 2026-07-01 — no auto-focus submit).
    fireEvent.click(within(q1).getAllByRole('radio')[0]!)
    await waitFor(() => expect(submit.disabled).toBe(false))

    q1.focus()
    fireEvent.keyDown(q1, { key: 'Enter' })
    expect(document.activeElement).toBe(q2) // same-round advance (nr_a: q1 → q2)

    fireEvent.keyDown(q2, { key: 'Enter' })
    expect(document.activeElement).toBe(q3) // cross-round advance (nr_a → nr_b)

    // LAST question → NO-OP: focus stays on q3, submit is NOT auto-focused (even though enabled).
    fireEvent.keyDown(q3, { key: 'Enter' })
    expect(document.activeElement).toBe(q3)
    expect(document.activeElement).not.toBe(submit)
  })

  test('single-choice digit key picks the option AND advances to the next question', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
      ],
      [round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    const q1 = screen.getByTestId('clarify-question-q1')
    const q2 = screen.getByTestId('clarify-question-q2')

    q1.focus()
    // Digit '1' picks option 0 of the single-choice question AND advances (QuestionForm contract).
    fireEvent.keyDown(q1, { key: '1' })
    expect((within(q1).getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true)
    expect(document.activeElement).toBe(q2)
  })

  // 用户拍板 (2026-07-01) — 末问 NO-OP with submit ALREADY enabled (synchronous path). A digit pick on
  // an earlier question enables submit; a subsequent digit pick on the LAST question must NOT hop
  // focus onto submit — it stays on the last question. Inverts the removed synchronous auto-focus.
  test('digit key on the LAST question (submit already enabled) picks the option but does NOT focus submit', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
      ],
      [round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q2'))
    const q1 = screen.getByTestId('clarify-question-q1')
    const q2 = screen.getByTestId('clarify-question-q2')
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement

    // Enable submit by filling q1 (mouse), so the last-question no-op is a meaningful assertion.
    fireEvent.click(within(q1).getAllByRole('radio')[0]!)
    await waitFor(() => expect(submit.disabled).toBe(false))

    // Digit-pick the LAST question → it gets checked, but focus stays on q2 (NO-OP), not submit.
    q2.focus()
    fireEvent.keyDown(q2, { key: '1' })
    expect((within(q2).getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true)
    expect(document.activeElement).toBe(q2)
    expect(document.activeElement).not.toBe(submit)
  })

  // 用户拍板 (2026-07-01) — 末问 NO-OP on the DEFERRED path: a digit pick on the last (here: only)
  // question is the FIRST filled answer, so submit is disabled at advance time and enables a tick
  // later. The removed deferred-flush would have stolen focus to submit once it enabled — it must
  // NOT any more (this WAS the exact 4-round focus-timing edge). Focus stays on the question.
  test('ONE-question dialog: digit pick enables submit but focus does NOT flush to it (deferred path removed)', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' })],
      [round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1')] })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    const q1 = screen.getByTestId('clarify-question-q1')
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true) // nothing filled yet → disabled

    q1.focus()
    fireEvent.keyDown(q1, { key: '1' }) // picks (first filled answer) + advances past the last question
    expect((within(q1).getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true)
    // The submit button enables (filledTotal 0→1) but NO deferred flush focuses it — focus stays put.
    await waitFor(() => expect(submit.disabled).toBe(false))
    expect(document.activeElement).toBe(q1)
    expect(document.activeElement).not.toBe(submit)
  })
})
