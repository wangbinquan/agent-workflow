// RFC-490 (design §2.2, proposal C9): the centralized answer dialog on the task page is
// the second place an answer can be written from. It has no way to skip a question,
// but a question that was skipped in the mindmap and sealed can come back to it as a
// re-answer (RFC-136). The one ruling applies there too: once the user gives a real
// answer, the skip mark left on it is dropped before the answer is submitted, and the
// note the user wrote stays. The harness follows centralized-answer-pane.test.tsx.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ClarifyAnswer, ClarifyRound } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { CentralizedAnswerDialog } from '@/components/clarify/CentralizedAnswerDialog'
import * as clarifyDraftStore from '@/lib/clarify/draftStore'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  // Serves the refetches that follow a submit; the queries under test are seeded.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  vi.spyOn(clarifyDraftStore, 'getClarifyDraft').mockResolvedValue(null)
  vi.spyOn(clarifyDraftStore, 'setClarifyDraft').mockResolvedValue(undefined)
  vi.spyOn(clarifyDraftStore, 'deleteClarifyDraft').mockResolvedValue(undefined)
  // The dialog focuses its first question on open, which scrolls it into view.
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** A sealed question that is back in "to assign": the dialog offers it as a re-answer. */
const sealedEntry: TaskQuestionEntry = {
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'Which regions?',
  originNodeRunId: 'nr_a',
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
  sealed: true,
  answerSummary: null,
  answerSkip: 'not-applicable',
}
const option = (label: string) => ({
  label,
  description: '',
  recommended: false,
  recommendationReason: '',
})
/** The round the question was skipped in: a mindmap round, sealed with the skip. */
function skippedRound(decision: NonNullable<ClarifyAnswer['decision']>): ClarifyRound {
  return {
    id: 'rnd_nr_a',
    taskId: 'task-1',
    kind: 'self',
    askingNodeId: 'designer',
    askingNodeRunId: 'nr_src',
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    intermediaryNodeRunId: 'nr_a',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: 0,
    questions: [
      {
        id: 'q1',
        title: 'Which regions?',
        kind: 'single',
        recommended: false,
        options: [option('One region'), option('Two regions')],
        mindmap: { categoryPath: ['Reliability'] },
      },
    ],
    answers: [
      {
        questionId: 'q1',
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: '',
        decision,
      },
    ],
    // Submitted from the mindmap; the question was moved back to "to assign" since.
    status: 'answered',
    terminatedAs: null,
    directive: null,
    sessionMode: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt: 0,
    answeredAt: 1_700_000_100_000,
    answeredBy: null,
    draftAnswers: null,
  }
}

function open(round: ClarifyRound, onClose: () => void = () => {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['task-questions', 'task-1'], [sealedEntry])
  qc.setQueryData(['tasks', 'task-1', 'snapshot'], { workflowSnapshot: { nodes: [] } })
  qc.setQueryData(['clarify', 'detail', round.intermediaryNodeRunId], round)
  return render(
    <QueryClientProvider client={qc}>
      <CentralizedAnswerDialog taskId="task-1" open onClose={onClose} />
    </QueryClientProvider>,
  )
}
interface Submitted {
  defer: boolean
  questionIds: string[]
  resubmitQuestionIds?: string[]
  answers: ClarifyAnswer[]
}
const submitButton = () => screen.getByTestId('centralized-answer-submit') as HTMLButtonElement

test('re-answering a skipped question with an option submits the answer without the skip mark', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true } as never)
  vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
  const onClose = vi.fn()
  open(skippedRound({ status: 'not-applicable', rationale: 'Single region only' }), onClose)
  const form = await screen.findByTestId('clarify-question-q1')
  // It is offered as a re-answer of what was sealed: nothing chosen, the skip's note.
  expect(screen.getByTestId('centralized-resubmit-hint-q1')).toBeTruthy()
  const radios = () => within(form).getAllByRole('radio') as HTMLInputElement[]
  expect(radios().map((radio) => radio.checked)).toEqual([false, false, false])
  expect((screen.getByLabelText('Why it does not apply') as HTMLTextAreaElement).value).toBe(
    'Single region only',
  )
  // A skip is not something this dialog submits: there is nothing filled in yet.
  expect(submitButton().disabled).toBe(true)
  fireEvent.click(radios()[0]!)
  expect(radios()[0]!.checked).toBe(true)
  // The skip is gone at once: the note is now simply the rationale of the answer.
  expect(screen.queryByLabelText('Why it does not apply')).toBeNull()
  expect((screen.getByLabelText('My rationale') as HTMLTextAreaElement).value).toBe(
    'Single region only',
  )
  await waitFor(() => expect(submitButton().disabled).toBe(false))
  fireEvent.click(submitButton())
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  const [path, sent] = post.mock.calls[0]! as [string, Submitted]
  expect(path).toBe('/api/clarify/nr_a/answers')
  expect(sent.defer).toBe(true)
  expect(sent.questionIds).toEqual(['q1'])
  expect(sent.resubmitQuestionIds).toEqual(['q1'])
  expect(sent.answers).toHaveLength(1)
  expect(sent.answers[0]).toMatchObject({
    questionId: 'q1',
    selectedOptionIndices: [0],
    customText: '',
  })
  // No status left, deferred or otherwise; the user's wording is kept.
  expect(sent.answers[0]!.decision).toEqual({ rationale: 'Single region only' })
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

test('free text counts as a real answer too; picking "Other" alone does not undo the skip', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true } as never)
  vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
  const onClose = vi.fn()
  open(skippedRound({ status: 'deferred', rationale: 'Waiting for the load test' }), onClose)
  const form = await screen.findByTestId('clarify-question-q1')
  expect(screen.getByLabelText('What is missing to decide')).toBeTruthy()
  fireEvent.click(within(form).getByTestId('clarify-custom-radio'))
  // Nothing was answered yet: it is still the deferred question it was.
  expect(screen.getByLabelText('What is missing to decide')).toBeTruthy()
  expect(submitButton().disabled).toBe(true)
  const box = within(form).getByTestId('clarify-custom-textarea') as HTMLTextAreaElement
  expect(box.disabled).toBe(false)
  fireEvent.change(box, { target: { value: 'Two regions from phase two on' } })
  expect(screen.queryByLabelText('What is missing to decide')).toBeNull()
  expect((screen.getByLabelText('My rationale') as HTMLTextAreaElement).value).toBe(
    'Waiting for the load test',
  )
  await waitFor(() => expect(submitButton().disabled).toBe(false))
  fireEvent.click(submitButton())
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  const sent = post.mock.calls[0]![1] as Submitted
  expect(sent.answers[0]).toMatchObject({
    questionId: 'q1',
    selectedOptionIndices: [],
    customText: 'Two regions from phase two on',
  })
  expect(sent.answers[0]!.decision).toEqual({ rationale: 'Waiting for the load test' })
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

test('a skip without a note leaves no decision behind once the question is answered', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true } as never)
  vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
  const onClose = vi.fn()
  open(skippedRound({ status: 'not-applicable' }), onClose)
  const form = await screen.findByTestId('clarify-question-q1')
  // The decision notes are shown because the sealed answer carries a status, and their
  // title names it: the question was skipped, not left unmarked.
  expect(screen.getByText('Decision context (optional) · Not applicable')).toBeTruthy()
  fireEvent.click(within(form).getAllByRole('radio')[1]!)
  // With the status gone there are no notes to show.
  expect(screen.queryByText(/Decision context/)).toBeNull()
  await waitFor(() => expect(submitButton().disabled).toBe(false))
  fireEvent.click(submitButton())
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  const sent = post.mock.calls[0]![1] as Submitted
  expect(sent.answers[0]).toMatchObject({ questionId: 'q1', selectedOptionIndices: [1] })
  expect(sent.answers[0]!.decision).toBeUndefined()
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})
