// RFC-490 (design §6.5, proposal G5 / AC06): once every question is handled the
// workspace says how many things are still worth another look and lists them in the
// root panel, each with one action. This file covers what rfc490-workspace-panel does
// not: the list shows six entries and folds the rest behind "N more", the two remaining
// kinds of step lead where they say (a provisional decision without a validation
// arrangement, decisions without a rationale), the list is recomputed from the answers
// on screen, and it keeps out of the way while a follow-up is being generated. Which
// steps exist, and in what order, is covered in rfc490-mindmap-guidance.test.ts.
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { MindmapWorkspace } from '../src/components/clarify/mindmap/MindmapWorkspace'
import { QuestionForm } from '../src/components/clarify/QuestionForm'

vi.mock('../src/components/clarify/mindmap/MindmapCanvas', () => ({
  MindmapCanvas: () => <div role="img" aria-label="Test map" />,
}))

const make = (id: string, title: string): ClarifyQuestion =>
  ClarifyQuestionSchema.parse({
    id,
    title,
    kind: 'single',
    options: [
      { label: 'Streaming replica', description: 'Needs a standby instance', recommended: true },
      { label: 'Nightly backup', description: 'Cheapest option' },
    ],
    mindmap: { categoryPath: ['Performance'] },
  })
// Q1 is provisional with a reason but no arrangement; Q2 and Q3 were answered (not
// with the recommended option) without a word of explanation.
const questions = [
  make('prov', 'Recovery target'),
  make('bare1', 'Replica lag'),
  make('bare2', 'Backup window'),
]
const confirmed = (question: ClarifyQuestion, patch: Partial<ClarifyAnswer> = {}) => {
  const value: ClarifyAnswer = {
    questionId: question.id,
    selectedOptionIndices: [1],
    selectedOptionLabels: [],
    customText: '',
    ...patch,
  }
  return { ...value, confirmedBasis: clarifyAnswerBasis(question, value) }
}
const handled: Record<string, ClarifyAnswer> = {
  prov: confirmed(questions[0]!, {
    decision: { status: 'provisional', rationale: 'No baseline yet' },
  }),
  bare1: confirmed(questions[1]!),
  bare2: confirmed(questions[2]!),
}
// "Performance" was asked about; the other eight were configured and never came up.
const gaps = [
  'Availability',
  'Capacity',
  'Cost',
  'Compliance',
  'Observability',
  'Operations',
  'Rollout',
  'Support',
]
const categoryPaths = [['Performance'], ...gaps.map((name) => [name])]

function Harness(props: { pending?: boolean }) {
  const [answers, setAnswers] = useState(handled)
  return (
    <MindmapWorkspace
      title="Report service"
      questions={questions}
      answers={answers}
      locked={new Set()}
      disabled={false}
      roundStatus="awaiting_human"
      followupPending={props.pending === true}
      followupRunning={props.pending ? 'bare1' : undefined}
      categoryPaths={categoryPaths}
      onChange={(id, value) => setAnswers((old) => ({ ...old, [id]: value }))}
      onFollowup={async () => {}}
      onCancelFollowup={async () => {}}
      renderQuestion={(question, index) => (
        <QuestionForm
          key={question.id}
          question={question}
          index={index + 1}
          value={answers[question.id]!}
          onChange={(value) => setAnswers((old) => ({ ...old, [question.id]: value }))}
          hideHeading
          hideInactiveCustom
        />
      )}
    />
  )
}
const pane = () => screen.getByRole('region', { name: 'Answer and confirm' })
const steps = () => within(pane()).getByRole('region', { name: 'Suggested next steps' })
const listed = () =>
  within(steps())
    .getAllByRole('listitem')
    .map((item) => item.textContent)
const gap = (name: string) => `“${name}” has no questions yetAsk AI to add`
const toRoot = () => fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))

test('the list shows six steps and folds the rest behind "N more"', () => {
  render(<Harness />)
  // Eight gaps, one provisional decision without an arrangement, one merged entry
  // for the two unexplained decisions.
  fireEvent.click(screen.getByRole('button', { name: '10 things worth another look' }))
  expect(within(steps()).getByRole('heading', { name: 'Suggested next steps' })).toBeTruthy()
  expect(
    within(steps()).getByText('These are reminders only; they never block submission.'),
  ).toBeTruthy()
  expect(listed()).toEqual(gaps.slice(0, 6).map(gap))
  fireEvent.click(within(steps()).getByRole('button', { name: '4 more' }))
  expect(listed()).toEqual([
    ...gaps.map(gap),
    'Q1 is provisional without an owner or review timeAdd the arrangement',
    '2 decisions have no rationaleAdd one',
  ])
  // Nothing left to unfold.
  expect(within(steps()).queryByRole('button', { name: /more$/ })).toBeNull()
  // Each step has exactly one action.
  for (const item of within(steps()).getAllByRole('listitem'))
    expect(within(item).getAllByRole('button')).toHaveLength(1)
})

test('a list that fits is shown whole, with nothing to unfold', () => {
  function Short() {
    return (
      <MindmapWorkspace
        title="Report service"
        questions={questions}
        answers={handled}
        locked={new Set()}
        disabled={false}
        roundStatus="awaiting_human"
        followupPending={false}
        categoryPaths={[['Performance'], ['Availability']]}
        onChange={() => {}}
        onFollowup={async () => {}}
        onCancelFollowup={async () => {}}
        renderQuestion={() => null}
      />
    )
  }
  render(<Short />)
  fireEvent.click(screen.getByRole('button', { name: '3 things worth another look' }))
  expect(listed()).toEqual([
    gap('Availability'),
    'Q1 is provisional without an owner or review timeAdd the arrangement',
    '2 decisions have no rationaleAdd one',
  ])
  expect(within(steps()).queryByRole('button', { name: /more$/ })).toBeNull()
})

test('"Add the arrangement" opens the provisional question with its remaining notes unfolded', () => {
  render(<Harness />)
  fireEvent.click(screen.getByTestId('mindmap-suggestions-open'))
  fireEvent.click(within(steps()).getByRole('button', { name: '4 more' }))
  fireEvent.click(within(steps()).getByRole('button', { name: 'Add the arrangement' }))
  expect(within(pane()).getByRole('heading', { name: 'Recovery target' })).toBeTruthy()
  const more = pane().querySelector<HTMLDetailsElement>('details.mindmap-decision__more')!
  expect(more.open).toBe(true)
  expect(within(more).getByLabelText('Who will validate')).toBeTruthy()
  expect(within(more).getByLabelText('When or under what conditions to revisit')).toBeTruthy()
  // Coming back to the root starts from the short list again.
  toRoot()
  expect(listed()).toHaveLength(6)
  expect(within(steps()).getByRole('button', { name: '4 more' })).toBeTruthy()
})

test('"Add one" opens the first decision that has no rationale', () => {
  render(<Harness />)
  fireEvent.click(screen.getByTestId('mindmap-suggestions-open'))
  fireEvent.click(within(steps()).getByRole('button', { name: '4 more' }))
  fireEvent.click(within(steps()).getByRole('button', { name: 'Add one' }))
  expect(within(pane()).getByRole('heading', { name: 'Replica lag' })).toBeTruthy()
  expect(within(pane()).getByLabelText('My rationale (optional)')).toBeTruthy()
})

test('the steps follow the answers: what was dealt with is gone the next time', () => {
  render(<Harness />)
  fireEvent.click(screen.getByTestId('mindmap-suggestions-open'))
  fireEvent.click(within(steps()).getByRole('button', { name: '4 more' }))
  fireEvent.click(within(steps()).getByRole('button', { name: 'Add the arrangement' }))
  fireEvent.change(within(pane()).getByLabelText('Who will validate'), {
    target: { value: 'Lin' },
  })
  fireEvent.change(within(pane()).getByLabelText('When or under what conditions to revisit'), {
    target: { value: 'After the first load test' },
  })
  // The edit withdrew the confirmation, so the round is not "all handled" any more
  // and the reminder steps aside.
  expect(screen.queryByTestId('mindmap-suggestions-open')).toBeNull()
  fireEvent.click(within(pane()).getByRole('button', { name: 'Confirm this answer' }))
  expect(screen.getByTestId('mindmap-suggestions-open').textContent).toBe(
    '9 things worth another look',
  )
  toRoot()
  fireEvent.click(within(steps()).getByRole('button', { name: '3 more' }))
  expect(listed()).toEqual([...gaps.map(gap), '2 decisions have no rationaleAdd one'])
})

test('the reminder keeps out of the way while a follow-up is being generated', () => {
  render(<Harness pending />)
  expect(screen.getByText('Generating questions…')).toBeTruthy()
  expect(screen.queryByTestId('mindmap-suggestions-open')).toBeNull()
  expect(screen.queryByRole('button', { name: /worth another look/ })).toBeNull()
})
