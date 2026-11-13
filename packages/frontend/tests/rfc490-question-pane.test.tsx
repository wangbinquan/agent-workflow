// RFC-490 (design §4.3, §4.4, §6.1, §6.2, §6.3, §6.6): the panel puts the thinking steps
// in the answering path. The rationale and maturity sit under the options, a question
// can be skipped in one click, a generated question says where it came from, follow-ups
// have one name and one entry, and Enter means "confirm and go on" without ever
// sharing a keystroke with picking an option.
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  clarifySkipStatus,
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  withoutStaleClarifySkip,
  type ClarifyAnswer,
  type ClarifyFollowupTarget,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { MindmapWorkspace } from '../src/components/clarify/mindmap/MindmapWorkspace'
import { QuestionForm } from '../src/components/clarify/QuestionForm'
import { composeMindmapFollowup } from '../src/lib/clarify/mindmap/followup'

vi.mock('../src/components/clarify/mindmap/MindmapCanvas', () => ({
  MindmapCanvas: () => <div role="img" aria-label="Test map" />,
}))

const parse = (value: Record<string, unknown>): ClarifyQuestion =>
  ClarifyQuestionSchema.parse({
    kind: 'single',
    options: [
      { label: 'Add targeted indexes', description: 'Review every plan before release' },
      { label: 'Rewrite as pre-aggregation', description: 'More work, steadier latency' },
    ],
    ...value,
  })
const path = ['Performance', 'Slow queries']
const parent = parse({
  id: 'p',
  title: 'How are slow queries optimised?',
  mindmap: { categoryPath: path },
})
// Asked from the parent, with the words that asked for it.
const child = parse({
  id: 'c',
  title: 'What gates an index change?',
  mindmap: {
    categoryPath: path,
    parentQuestionId: 'p',
    requestId: 'r1',
    requestBasis: 'v2:a',
    requestTarget: 'question',
    requestInstruction: composeMindmapFollowup(
      'Review every plan before release',
      'How do we stop index changes from slowing writes?',
    ),
  },
})
// Added to the category without a direction.
const inCategory = parse({
  id: 'g',
  title: 'How large is the replica?',
  mindmap: { categoryPath: path, requestId: 'r2', requestBasis: 'v2:b', requestTarget: 'category' },
})
// Added for the whole topic, with a direction.
const forRoot = parse({
  id: 'w',
  title: 'Who owns the runbook?',
  mindmap: {
    categoryPath: ['Operations'],
    requestId: 'r3',
    requestBasis: 'v2:c',
    requestTarget: 'root',
    requestInstruction: 'Anything about on-call',
  },
})
// Generated before origins were saved, and a child the model asked itself.
const legacy = parse({
  id: 'l',
  title: 'Is the cache shared?',
  mindmap: { categoryPath: path, requestId: 'r0', requestBasis: 'v2:d' },
})
const nested = parse({
  id: 'n',
  title: 'Which plans are reviewed?',
  mindmap: { categoryPath: path, parentQuestionId: 'c' },
})
const questions = [parent, child, inCategory, forRoot, legacy, nested]
const blank = (questionId: string): ClarifyAnswer => ({
  questionId,
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText: '',
})

function Harness(props: {
  only?: ClarifyQuestion[]
  initial?: Record<string, ClarifyAnswer>
  status?: string
  onChange?: (id: string, value: ClarifyAnswer) => void
  followup?: (target: ClarifyFollowupTarget, instruction: string) => Promise<void>
}) {
  const round = props.only ?? questions
  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>({
    ...Object.fromEntries(round.map((q) => [q.id, blank(q.id)])),
    ...props.initial,
  })
  const readonly = (props.status ?? 'awaiting_human') !== 'awaiting_human'
  // What the route's single write entry does (clarify.detail.tsx `updateAnswer`).
  const change = (id: string, next: ClarifyAnswer) => {
    let value = withoutStaleClarifySkip(next)
    const question = round.find((item) => item.id === id)!
    if (value.confirmedBasis && value.confirmedBasis !== clarifyAnswerBasis(question, value)) {
      const { confirmedBasis: _stale, ...rest } = value
      value = rest
    }
    props.onChange?.(id, value)
    setAnswers((old) => ({ ...old, [id]: value }))
  }
  return (
    <MindmapWorkspace
      title="Report service"
      questions={round}
      answers={answers}
      locked={readonly ? new Set(round.map((q) => q.id)) : new Set()}
      disabled={readonly}
      roundStatus={props.status ?? 'awaiting_human'}
      followupPending={false}
      onChange={change}
      onFollowup={props.followup ?? (async () => {})}
      onCancelFollowup={async () => {}}
      renderQuestion={(question, index) => (
        <QuestionForm
          key={question.id}
          question={question}
          index={index + 1}
          value={answers[question.id]!}
          onChange={(value) => change(question.id, value)}
          hideHeading
          hideInactiveCustom
          intentResetToken={clarifySkipStatus(answers[question.id]) ?? ''}
          disabled={readonly}
        />
      )}
    />
  )
}
const pane = () => screen.getByRole('region', { name: 'Answer and confirm' })
function open(title: RegExp) {
  if (!screen.queryByRole('region', { name: 'Answer and confirm' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Focused answers' }))
  fireEvent.click(screen.getByRole('treeitem', { name: title }))
  return within(pane())
}
const form = () => pane().querySelector<HTMLElement>('.clarify-question')!
const heading = (name: string) => within(pane()).getByRole('heading', { name })
const lastChange = (spy: ReturnType<typeof vi.fn>) => spy.mock.lastCall![1] as ClarifyAnswer
const origin = () =>
  within(within(pane()).getByRole('complementary', { name: 'Where this question came from' }))
/** A line of the origin card: its label and what follows it. */
const line = (label: RegExp) => origin().getByText(label).parentElement!.textContent
const noOrigin = () =>
  expect(
    within(pane()).queryByRole('complementary', { name: 'Where this question came from' }),
  ).toBeNull()

test('rationale and maturity sit under the answer; a provisional choice opens the remaining notes', () => {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)
  const view = open(/How are slow queries optimised/)
  // Nothing to justify before there is an answer.
  expect(view.queryByLabelText('My rationale (optional)')).toBeNull()
  fireEvent.click(view.getByLabelText(/Add targeted indexes/))
  fireEvent.click(view.getByRole('button', { name: 'Confirm this answer' }))
  expect(isClarifyAnswerConfirmed(parent, lastChange(onChange))).toBe(true)
  // In view without opening anything; editing it withdraws the confirmation.
  const more = pane().querySelector<HTMLDetailsElement>('details.mindmap-decision__more')!
  expect(more.open).toBe(false)
  const rationale = view.getByLabelText('My rationale (optional)')
  expect(rationale.tagName).toBe('INPUT')
  fireEvent.change(rationale, { target: { value: 'Plans are reviewed anyway' } })
  expect(lastChange(onChange).decision).toEqual({ rationale: 'Plans are reviewed anyway' })
  expect(lastChange(onChange).confirmedBasis).toBeUndefined()
  fireEvent.click(view.getByRole('radio', { name: 'Provisional' }))
  expect(lastChange(onChange).decision).toEqual({
    status: 'provisional',
    rationale: 'Plans are reviewed anyway',
  })
  expect(more.open).toBe(true)
  expect(within(more).getByLabelText('Who will validate')).toBeTruthy()
  // The rationale is not repeated inside the folded notes.
  expect(within(more).queryByLabelText(/^My rationale/)).toBeNull()
})

test('a rationale written over several lines elsewhere is not squeezed into one line', () => {
  render(
    <Harness
      initial={{
        p: { ...blank('p'), selectedOptionIndices: [0], decision: { rationale: 'First\nSecond' } },
      }}
    />,
  )
  const field = open(/How are slow queries optimised/).getByLabelText('My rationale (optional)')
  expect(field.tagName).toBe('TEXTAREA')
  expect((field as HTMLTextAreaElement).value).toBe('First\nSecond')
})

test('a question is skipped in one click, already confirmed, and the note keeps it so', () => {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} initial={{ p: { ...blank('p'), customText: 'Draft' } }} />)
  const view = open(/How are slow queries optimised/)
  fireEvent.click(view.getByRole('button', { name: 'Not applicable' }))
  const skipped = lastChange(onChange)
  expect(skipped).toMatchObject({
    selectedOptionIndices: [],
    customText: '',
    decision: { status: 'not-applicable' },
  })
  expect(isClarifyAnswerValid(parent, skipped)).toBe(true)
  expect(isClarifyAnswerConfirmed(parent, skipped)).toBe(true)
  expect(view.getByText('Marked: Not applicable')).toBeTruthy()
  // The note explains the skip; maturity and the folded notes no longer apply.
  expect(view.queryByRole('radio', { name: 'Provisional' })).toBeNull()
  expect(pane().querySelector('details.mindmap-decision__more')).toBeNull()
  expect(view.getByRole('button', { name: 'Confirmed' }).hasAttribute('disabled')).toBe(true)
  expect(view.queryByRole('button', { name: 'Not applicable' })).toBeNull()
  fireEvent.change(view.getByLabelText('Why it does not apply (optional)'), {
    target: { value: 'Reports are read-only' },
  })
  expect(lastChange(onChange).decision).toEqual({
    status: 'not-applicable',
    rationale: 'Reports are read-only',
  })
  expect(isClarifyAnswerConfirmed(parent, lastChange(onChange))).toBe(true)
  expect(view.getByRole('button', { name: 'Confirmed' })).toBeTruthy()
  // Answering instead: the draft from before the skip is back, waiting to be confirmed.
  fireEvent.click(view.getByRole('button', { name: 'Answer instead' }))
  expect(lastChange(onChange)).toMatchObject({ customText: 'Draft' })
  expect(clarifySkipStatus(lastChange(onChange))).toBeUndefined()
  expect(lastChange(onChange).confirmedBasis).toBeUndefined()
  fireEvent.click(view.getByRole('button', { name: 'Decide later' }))
  expect(lastChange(onChange).decision).toEqual({ status: 'deferred' })
  expect(view.getByLabelText('What is missing to decide (optional)')).toBeTruthy()
})

test('picking an option on a skipped question simply answers it', () => {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)
  const view = open(/How are slow queries optimised/)
  fireEvent.click(view.getByRole('button', { name: 'Decide later' }))
  fireEvent.change(view.getByLabelText('What is missing to decide (optional)'), {
    target: { value: 'No load test yet' },
  })
  fireEvent.click(view.getByLabelText(/Rewrite as pre-aggregation/))
  // The real answer wins: no skip mark, the note stays as the user's wording.
  expect(lastChange(onChange)).toMatchObject({
    selectedOptionIndices: [1],
    decision: { rationale: 'No load test yet' },
  })
  expect(lastChange(onChange).decision?.status).toBeUndefined()
  expect(view.queryByText(/^Marked:/)).toBeNull()
  expect(view.getByRole('button', { name: 'Decide later' })).toBeTruthy()
  expect(view.getByRole('button', { name: 'Confirm this answer' }).hasAttribute('disabled')).toBe(
    false,
  )
})

test('the free-text box appears with "Other", and a skip does not leave "Other" chosen', () => {
  render(<Harness />)
  const view = open(/How are slow queries optimised/)
  expect(view.queryByTestId('clarify-custom-textarea')).toBeNull()
  fireEvent.click(view.getByTestId('clarify-custom-radio'))
  expect(view.getByTestId('clarify-custom-textarea')).toBeTruthy()
  expect((view.getByTestId('clarify-custom-radio') as HTMLInputElement).checked).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Not applicable' }))
  expect((view.getByTestId('clarify-custom-radio') as HTMLInputElement).checked).toBe(false)
  expect(view.queryByTestId('clarify-custom-textarea')).toBeNull()
})

test('typing into "Other" undoes a skip without the box closing when it is emptied again', () => {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)
  const view = open(/How are slow queries optimised/)
  fireEvent.click(view.getByRole('button', { name: 'Decide later' }))
  fireEvent.click(view.getByTestId('clarify-custom-radio'))
  fireEvent.change(view.getByTestId('clarify-custom-textarea'), { target: { value: 'a' } })
  // The first character is a real answer: the skip is gone.
  expect(clarifySkipStatus(lastChange(onChange))).toBeUndefined()
  fireEvent.change(view.getByTestId('clarify-custom-textarea'), { target: { value: '' } })
  // Still "Other", still a box to type in: undoing the skip did not take the pick away.
  expect((view.getByTestId('clarify-custom-radio') as HTMLInputElement).checked).toBe(true)
  expect(view.getByTestId('clarify-custom-textarea')).toBeTruthy()
})

test('switching questions leaves exactly one answer form in the panel', () => {
  // The renderer keys its element by question id, and so does the decision block; as
  // siblings they shared a key and the previous question's form stayed on the page.
  render(<Harness initial={{ p: { ...blank('p'), selectedOptionIndices: [0] } }} />)
  open(/How are slow queries optimised/)
  expect(pane().querySelectorAll('.clarify-question')).toHaveLength(1)
  for (const title of [/What gates an index change/, /How large is the replica/, /How are slow/]) {
    open(title)
    expect(pane().querySelectorAll('.clarify-question')).toHaveLength(1)
  }
  expect(form().getAttribute('data-question-id')).toBe('p')
})

test('a follow-up shows what it was asked from: the parent, my answer to it and my words', () => {
  render(<Harness initial={{ p: { ...blank('p'), selectedOptionIndices: [0] } }} />)
  open(/What gates an index change/)
  expect(origin().getByText(/Follow-up to Q1 · How are slow queries optimised\?/)).toBeTruthy()
  expect(line(/Your answer:/)).toContain('Add targeted indexes')
  expect(line(/Quoted:/)).toContain('Review every plan before release')
  expect(line(/Direction given:/)).toContain('How do we stop index changes from slowing writes?')
  fireEvent.click(origin().getByRole('button', { name: 'View Q1' }))
  expect(heading('How are slow queries optimised?')).toBeTruthy()
})

test('a question added to a category or to the whole topic says so; older data shows what it has', () => {
  render(
    <Harness
      initial={{
        c: { ...blank('c'), decision: { status: 'deferred' } },
      }}
    />,
  )
  open(/How large is the replica/)
  expect(
    origin().getByText('From the questions you asked for under “Performance / Slow queries”'),
  ).toBeTruthy()
  // No direction was written, so none is shown.
  expect(origin().queryByText(/Direction given:/)).toBeNull()
  open(/Who owns the runbook/)
  expect(origin().getByText('From the questions you asked for on the whole topic')).toBeTruthy()
  expect(line(/Direction given:/)).toContain('Anything about on-call')
  // A question the model asked under another one: the parent and my answer, nothing else.
  open(/Which plans are reviewed/)
  expect(origin().getByText(/Follow-up to Q2 · What gates an index change\?/)).toBeTruthy()
  expect(line(/Your answer:/)).toContain('Decide later')
  expect(origin().queryByText(/Direction given:/)).toBeNull()
  // An unanswered parent is shown as such.
  open(/What gates an index change/)
  expect(line(/Your answer:/)).toContain('Not answered yet')
  // Generated before origins were saved, without a parent: nothing to show.
  open(/Is the cache shared/)
  noOrigin()
  // Asked by the model at the start: no origin either.
  open(/How are slow queries optimised/)
  noOrigin()
})

test('a parent lists the questions asked from it and leads to them', () => {
  render(<Harness />)
  const view = open(/How are slow queries optimised/)
  const list = view.getByRole('heading', { name: 'Follow-up questions (1)' }).parentElement!
  fireEvent.click(within(list).getByRole('button', { name: /Q2 · What gates an index change/ }))
  expect(heading('What gates an index change?')).toBeTruthy()
})

test('follow-ups have one row of entries and one name, and the form can be put away', () => {
  const followup = vi.fn(async () => {})
  render(
    <Harness followup={followup} initial={{ p: { ...blank('p'), selectedOptionIndices: [0] } }} />,
  )
  const view = open(/How are slow queries optimised/)
  const prompts = view.getByText('Follow up:').parentElement!
  expect(
    within(prompts)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Check the evidence', 'Consider the cost', 'Compare alternatives', 'Write my own…'])
  expect(view.queryByRole('button', { name: /Deepen/ })).toBeNull()
  expect(view.queryByLabelText('What needs more detail? (optional)')).toBeNull()
  fireEvent.click(within(prompts).getByRole('button', { name: 'Write my own…' }))
  expect(view.getByRole('heading', { name: 'Follow up on Q1' })).toBeTruthy()
  const direction = () =>
    view.getByLabelText('What needs more detail? (optional)') as HTMLTextAreaElement
  expect(direction().value).toBe('')
  fireEvent.click(within(prompts).getByRole('button', { name: 'Consider the cost' }))
  expect(direction().value).toContain('What costs, limitations or failure consequences')
  // Close puts the form away and keeps what was written; Escape does the same.
  fireEvent.click(view.getByRole('button', { name: 'Close' }))
  expect(view.queryByLabelText('What needs more detail? (optional)')).toBeNull()
  fireEvent.click(within(prompts).getByRole('button', { name: 'Write my own…' }))
  expect(direction().value).toContain('What costs')
  fireEvent.keyDown(direction(), { key: 'Escape' })
  expect(view.queryByLabelText('What needs more detail? (optional)')).toBeNull()
  expect(pane()).toBeTruthy()
  fireEvent.click(within(prompts).getByRole('button', { name: 'Write my own…' }))
  fireEvent.click(view.getByRole('button', { name: 'Generate follow-ups' }))
  expect(followup).toHaveBeenCalledWith('p', expect.stringContaining('What costs'))
})

test('confirm-and-next confirms and moves on; Enter does the same; a digit only picks', () => {
  const onChange = vi.fn()
  render(<Harness only={[parent, child, inCategory]} onChange={onChange} />)
  let view = open(/How are slow queries optimised/)
  expect(view.getByRole('button', { name: /Confirm and next/ }).hasAttribute('disabled')).toBe(true)
  // Enter on an unanswered question does nothing.
  fireEvent.keyDown(form(), { key: 'Enter' })
  expect(onChange).not.toHaveBeenCalled()
  // A digit picks and stays: picking and confirming never share a keystroke.
  fireEvent.keyDown(form(), { key: '2' })
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(lastChange(onChange).selectedOptionIndices).toEqual([1])
  expect(lastChange(onChange).confirmedBasis).toBeUndefined()
  expect(heading('How are slow queries optimised?')).toBeTruthy()
  fireEvent.keyDown(form(), { key: 'Enter' })
  expect(isClarifyAnswerConfirmed(parent, lastChange(onChange))).toBe(true)
  expect(lastChange(onChange).selectedOptionIndices).toEqual([1])
  expect(heading('What gates an index change?')).toBeTruthy()
  view = within(pane())
  fireEvent.click(view.getByLabelText(/Add targeted indexes/))
  fireEvent.click(view.getByRole('button', { name: /Confirm and next/ }))
  expect(heading('How large is the replica?')).toBeTruthy()
  // The last open question has nowhere to move on to: only the plain confirmation.
  view = within(pane())
  expect(view.queryByRole('button', { name: /Confirm and next/ })).toBeNull()
  fireEvent.click(view.getByLabelText(/Add targeted indexes/))
  fireEvent.click(view.getByRole('button', { name: 'Confirm this answer' }))
  expect(heading('How large is the replica?')).toBeTruthy()
  expect(
    screen.getByText('This round’s answers are confirmed. Review decisions before submitting.'),
  ).toBeTruthy()
})

test('Enter confirms from the rationale line, and keeps its own meaning everywhere else', () => {
  const onChange = vi.fn()
  render(<Harness only={[parent, child]} onChange={onChange} />)
  const view = open(/How are slow queries optimised/)
  fireEvent.click(view.getByTestId('clarify-custom-radio'))
  const custom = view.getByTestId('clarify-custom-textarea')
  fireEvent.change(custom, { target: { value: 'Partition by month' } })
  const before = onChange.mock.calls.length
  // In a multi-line field Enter is a new line.
  fireEvent.keyDown(custom, { key: 'Enter' })
  // On a button it presses that button, which is the button's own business.
  fireEvent.keyDown(view.getByRole('button', { name: 'Not applicable' }), { key: 'Enter' })
  fireEvent.keyDown(view.getByRole('radio', { name: 'Provisional' }), { key: 'Enter' })
  // While an input method is composing, Enter belongs to it.
  const rationale = view.getByLabelText('My rationale (optional)')
  fireEvent.keyDown(rationale, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(rationale, { key: 'Enter', shiftKey: true })
  expect(onChange.mock.calls.length).toBe(before)
  expect(heading('How are slow queries optimised?')).toBeTruthy()
  // Typed the reason, pressed Enter: confirmed and on to the next question.
  fireEvent.change(rationale, { target: { value: 'Old months are never rewritten' } })
  fireEvent.keyDown(rationale, { key: 'Enter' })
  expect(isClarifyAnswerConfirmed(parent, lastChange(onChange))).toBe(true)
  expect(lastChange(onChange)).toMatchObject({
    customText: 'Partition by month',
    decision: { rationale: 'Old months are never rewritten' },
  })
  expect(heading('What gates an index change?')).toBeTruthy()
})

test('a sealed question is only read: notes shown, no skip, no follow-up entries', () => {
  const answered = {
    ...blank('p'),
    selectedOptionIndices: [0],
    decision: { status: 'decided' as const, rationale: 'Reviewed with the DBA' },
  }
  const skipped = {
    ...blank('c'),
    decision: { status: 'not-applicable' as const, rationale: 'No DDL' },
  }
  render(
    <Harness
      status="answered"
      initial={{
        p: { ...answered, confirmedBasis: clarifyAnswerBasis(parent, answered) },
        c: { ...skipped, confirmedBasis: clarifyAnswerBasis(child, skipped) },
      }}
    />,
  )
  let view = open(/How are slow queries optimised/)
  expect(view.getByText('Reviewed with the DBA')).toBeTruthy()
  expect(view.queryByLabelText(/^My rationale/)).toBeNull()
  expect(view.queryByRole('button', { name: 'Not applicable' })).toBeNull()
  expect(view.queryByText('Follow up:')).toBeNull()
  // (The follow-up list below names its entries with their status, "Confirmed".)
  expect(view.queryByRole('button', { name: /^Confirm (this answer|and next)/ })).toBeNull()
  expect(view.queryByRole('button', { name: 'Confirmed' })).toBeNull()
  // A sealed skip reads as what it is, with its note under the right label.
  view = open(/What gates an index change/)
  expect(view.getByText('Not applicable')).toBeTruthy()
  expect(view.getByText('Why it does not apply')).toBeTruthy()
  expect(view.getByText('No DDL')).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Answer instead' })).toBeNull()
})
