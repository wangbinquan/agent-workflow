// RFC-372 UX regressions found with the daily AW real-model task: false hierarchy,
// duplicated/truncated reading, shared follow-up text and misleading completion.
import { useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  type ClarifyFollowupTarget,
  type ClarifyAnswer,
} from '@agent-workflow/shared'
import { MindmapWorkspace } from '../src/components/clarify/mindmap/MindmapWorkspace'
import { MindmapOutline } from '../src/components/clarify/mindmap/MindmapOutline'
import { projectClarifyMindmap } from '../src/lib/clarify/mindmap/projection'
import { QuestionForm } from '../src/components/clarify/QuestionForm'

vi.mock('../src/components/clarify/mindmap/MindmapCanvas', () => ({
  MindmapCanvas: () => <div role="img" aria-label="Test map" />,
}))
const questions = ['Main decision', 'Network timeout recovery', 'Idempotency retention'].map(
  (title, i) =>
    ClarifyQuestionSchema.parse({
      id: `q${i}`,
      title,
      kind: 'single',
      options: [
        {
          label: 'Preserve committed result',
          description: 'Keep the complete booking and replay its original response. '.repeat(8),
          recommended: true,
          recommendationReason: 'Atomic persistence protects retries.',
        },
        'Create another booking',
      ],
      mindmap: {
        categoryPath: ['Data consistency', 'Concurrency'],
        ...(i ? { parentQuestionId: `q${i - 1}` } : {}),
      },
    }),
)
const initial = Object.fromEntries(
  questions.map((question, i) => {
    const answer: ClarifyAnswer = {
      questionId: question.id,
      selectedOptionIndices: i ? [] : [0],
      selectedOptionLabels: i ? [] : ['Preserve committed result'],
      customText: '',
    }
    return [
      question.id,
      i ? answer : { ...answer, confirmedBasis: clarifyAnswerBasis(question, answer) },
    ]
  }),
)
function Harness({
  followup = async () => {},
  status = 'awaiting_human',
  pending = false,
  sealed = false,
  cancel = async () => {},
}: {
  followup?: (id: ClarifyFollowupTarget, hint: string) => Promise<void>
  status?: string
  pending?: boolean
  sealed?: boolean
  cancel?: () => Promise<void>
}) {
  const [answers, setAnswers] = useState(initial)
  return (
    <MindmapWorkspace
      title="Room booking"
      questions={questions}
      answers={answers}
      locked={status === 'answered' || sealed ? new Set(questions.map((q) => q.id)) : new Set()}
      disabled={status !== 'awaiting_human'}
      roundStatus={status}
      followupPending={pending}
      onChange={(id, value) => setAnswers((old) => ({ ...old, [id]: value }))}
      onFollowup={followup}
      onCancelFollowup={cancel}
      renderQuestion={(question, index) => (
        <QuestionForm
          key={question.id}
          question={question}
          index={index + 1}
          value={answers[question.id]!}
          onChange={(value) => setAnswers((old) => ({ ...old, [question.id]: value }))}
          hideHeading
          disabled={status !== 'awaiting_human'}
        />
      )}
    />
  )
}
function renderFocused(element: Parameters<typeof render>[0]) {
  const result = render(element)
  fireEvent.click(screen.getByRole('radio', { name: 'Focused answers' }))
  return result
}
const select = (name: string) =>
  fireEvent.click(screen.getByRole('treeitem', { name: new RegExp(name) }))

test('outline retains category and question ancestry, distinct own status and expandable descendants', () => {
  renderFocused(<Harness />)
  const parent = screen.getByRole('treeitem', { name: /Main decision/ })
  const child = screen.getByRole('treeitem', { name: /Network timeout recovery/ })
  const deep = screen.getByRole('treeitem', { name: /Idempotency retention/ })
  expect([parent, child, deep].map((row) => row.getAttribute('aria-level'))).toEqual([
    '3',
    '4',
    '5',
  ])
  expect(child.getAttribute('data-parent-id')).toBe('q:q0')
  expect(deep.getAttribute('data-parent-id')).toBe('q:q1')
  expect(within(parent).getByText('Confirmed')).toBeTruthy()
  expect(within(parent).getByText('2 child questions pending')).toBeTruthy()
  fireEvent.keyDown(parent, { key: 'ArrowLeft' })
  expect(parent.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('treeitem', { name: /Network timeout recovery/ })).toBeNull()
  fireEvent.keyDown(parent, { key: 'ArrowRight' })
  fireEvent.keyDown(parent, { key: 'ArrowRight' })
  expect(
    screen
      .getByRole('treeitem', { name: /Network timeout recovery/ })
      .getAttribute('aria-selected'),
  ).toBe('true')
  expect(document.activeElement).toBe(
    screen.getByRole('treeitem', { name: /Network timeout recovery/ }),
  )
})

test('search reveals a folded descendant with its real ancestry and restores tree navigation', () => {
  renderFocused(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Collapse children Main decision' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Search categories or questions' }), {
    target: { value: 'retention' },
  })
  const result = screen.getByRole('option', { name: /Idempotency retention/ })
  expect(within(result).getByText('Data consistency / Concurrency / Q1 / Q2')).toBeTruthy()
  fireEvent.click(result)
  fireEvent.change(screen.getByRole('textbox', { name: 'Search categories or questions' }), {
    target: { value: '' },
  })
  expect(screen.getByRole('treeitem', { name: /Network timeout recovery/ })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Idempotency retention' })).toBeTruthy()
  expect(screen.getByText(/Follow-up to Q2/)).toBeTruthy()
})

test('reading owns one full heading; changing question resets only its scroll, not edits', () => {
  const { container } = renderFocused(<Harness />)
  select('Main decision')
  expect(screen.getAllByRole('heading', { name: 'Main decision' })).toHaveLength(1)
  const reading = container.querySelector('.mindmap-question__reading')!
  reading.scrollTop = 300
  fireEvent.click(screen.getByLabelText(/Create another booking/))
  expect(reading.scrollTop).toBe(300)
  expect(screen.getByRole('button', { name: 'Confirm this answer' }).hasAttribute('disabled')).toBe(
    false,
  )
  select('Network timeout recovery')
  expect(reading.scrollTop).toBe(0)
  select('Main decision')
  expect((screen.getByLabelText(/Create another booking/) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: 'Focused answers' }))
  expect(screen.getAllByRole('heading', { name: 'Main decision' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /Back to mindmap/ }))
  expect(screen.queryByRole('heading', { name: 'Main decision' })).toBeNull()
  select('Main decision')
  expect((screen.getByLabelText(/Create another booking/) as HTMLInputElement).checked).toBe(true)
})

test('follow-up text and errors belong to the originating question while another answer remains editable', async () => {
  let reject!: (error: Error) => void
  const followup = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      }),
  )
  renderFocused(<Harness followup={followup} />)
  select('Main decision')
  fireEvent.click(screen.getByRole('button', { name: 'Deepen this question' }))
  const hint = screen.getByLabelText('What needs more detail? (optional)')
  fireEvent.change(hint, { target: { value: 'Retain this branch guidance' } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }))
  select('Network timeout recovery')
  fireEvent.click(screen.getByLabelText(/Create another booking/))
  fireEvent.click(screen.getByRole('button', { name: 'Deepen this question' }))
  expect(
    (screen.getByLabelText('What needs more detail? (optional)') as HTMLTextAreaElement).value,
  ).toBe('')
  expect(screen.getByRole('button', { name: 'Ask follow-up' }).hasAttribute('disabled')).toBe(true)
  await act(async () => {
    reject(new Error('missing mindmap category: q1'))
  })
  expect(screen.getByRole('heading', { name: 'Network timeout recovery' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View failed follow-up' }))
  expect(
    (screen.getByLabelText('What needs more detail? (optional)') as HTMLTextAreaElement).value,
  ).toBe('Retain this branch guidance')
  expect(screen.getByRole('alert').textContent).toContain('missing mindmap category')
  expect(followup).toHaveBeenCalledWith('q0', 'Retain this branch guidance')
})

test('submitted history states submission and keeps all answer/follow-up mutations unavailable', () => {
  renderFocused(<Harness status="answered" />)
  expect(
    screen.getByText('This round was submitted. Confirmed answers are available to read.'),
  ).toBeTruthy()
  select('Main decision')
  expect(screen.queryByRole('button', { name: 'Deepen this question' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Confirm this answer' })).toBeNull()
  expect((screen.getByLabelText(/Create another booking/) as HTMLInputElement).disabled).toBe(true)
})

test('filtering out a selected question and collapsing its ancestor retain a keyboard entry point', () => {
  renderFocused(<Harness />)
  select('Idempotency retention')
  fireEvent.change(screen.getByRole('textbox', { name: 'Search categories or questions' }), {
    target: { value: 'Main decision' },
  })
  expect(screen.getByRole('option', { name: /Main decision/ }).tabIndex).toBe(0)
  expect(screen.getByRole('heading', { name: 'Idempotency retention' })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search categories or questions' }), {
    target: { value: '' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Collapse children Main decision' }))
  expect(screen.getByRole('treeitem', { name: /Main decision/ }).tabIndex).toBe(0)
  expect(screen.getByRole('heading', { name: 'Idempotency retention' })).toBeTruthy()
})

test('returning to a question with its follow-up expanded starts at the title, not the old guidance', () => {
  const original = HTMLElement.prototype.getBoundingClientRect
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('mindmap-question__followup')
        ? ({ ...original.call(this), top: 450 } as DOMRect)
        : original.call(this)
    })
  try {
    const { container } = renderFocused(<Harness />)
    select('Main decision')
    fireEvent.click(screen.getByRole('button', { name: 'Deepen this question' }))
    const reading = container.querySelector('.mindmap-question__reading')!
    expect(reading.scrollTop).toBe(450)
    select('Network timeout recovery')
    select('Main decision')
    expect(
      screen.getByRole('button', { name: 'Deepen this question' }).getAttribute('aria-expanded'),
    ).toBe('true')
    expect(reading.scrollTop).toBe(0)
  } finally {
    rect.mockRestore()
  }
})

test('search keeps a mounted Tab entry when the matching ancestor lies beyond the virtual window', () => {
  const wide = Array.from({ length: 300 }, (_, i) =>
    ClarifyQuestionSchema.parse({
      ...questions[0],
      id: `wide-${i}`,
      title: `Decision ${i}`,
      mindmap: { categoryPath: [`Group ${i}`] },
    }),
  )
  const { container } = render(
    <MindmapOutline
      nodes={projectClarifyMindmap(wide, {}, new Set(), 'Wide map')}
      selectedId="q:wide-299"
      collapsed={new Set()}
      search="Group"
      onSearch={() => {}}
      onSelect={() => {}}
      onToggle={() => {}}
    />,
  )
  expect(screen.getAllByRole('option').length).toBeLessThan(40)
  expect(container.querySelector('[role="option"][tabindex="0"]')?.textContent).toContain('Group 0')
  expect(screen.queryByRole('option', { name: /Group 299/ })).toBeNull()
})

test('centralized answers already sealed in an awaiting round do not advertise a second submission', () => {
  renderFocused(<Harness sealed />)
  expect(
    screen.getByText('All questions have been handled. No further submission is needed.'),
  ).toBeTruthy()
  expect(screen.queryByText('This round is reviewed and ready to submit.')).toBeNull()
  expect(
    screen.queryByText('This round was submitted. Confirmed answers are available to read.'),
  ).toBeNull()
  select('Main decision')
  expect(screen.queryByRole('button', { name: 'Confirm this answer' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Deepen this question' })).toBeNull()
})

test('panorama opens a modal, retains edits on Escape, restores focus and shares answers with focus view', async () => {
  render(<Harness />)
  const row = screen.getByRole('treeitem', { name: /Main decision/ })
  fireEvent.keyDown(row, { key: 'ArrowDown' })
  expect(screen.queryByRole('dialog')).toBeNull()
  row.focus()
  fireEvent.keyDown(row, { key: 'Enter' })
  const dialog = screen.getByRole('dialog')
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  fireEvent.click(within(dialog).getByLabelText(/Create another booking/))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Deepen this question' }))
  fireEvent.change(within(dialog).getByLabelText('What needs more detail? (optional)'), {
    target: { value: 'Keep this instruction' },
  })
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(row)
  select('Main decision')
  expect((screen.getByLabelText(/Create another booking/) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByDisplayValue('Keep this instruction')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open in focused answers' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getAllByRole('heading', { name: 'Main decision' })).toHaveLength(1)
  expect((screen.getByLabelText(/Create another booking/) as HTMLInputElement).checked).toBe(true)
})

test('category guidance sends a category target, can close while generating and cancel on return', async () => {
  let resolve!: () => void
  const followup = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  )
  const cancel = vi.fn(async () => {
    resolve()
  })
  render(<Harness followup={followup} cancel={cancel} />)
  const category = screen.getByRole('treeitem', { name: /^Data consistency/ })
  fireEvent.click(category)
  const dialog = screen.getByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('What else should AI consider? (optional)'), {
    target: { value: 'Also consider database performance' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add questions in this direction' }))
  expect(followup).toHaveBeenCalledWith(['Data consistency'], 'Also consider database performance')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(cancel).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'View generating branch' }))
  expect(screen.getByDisplayValue('Also consider database performance')).toBeTruthy()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Concurrency/ }))
  expect(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel follow-up' }),
  ).toBeTruthy()
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel follow-up' }),
    )
  })
  expect(cancel).toHaveBeenCalledOnce()
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Add questions in this direction',
    }),
  )
  expect(followup).toHaveBeenLastCalledWith([], '')
  await act(async () => {
    resolve()
  })
})

test('sealed category and submitted history do not expose category generation', () => {
  render(<Harness sealed />)
  fireEvent.click(screen.getByRole('treeitem', { name: /^Data consistency/ }))
  expect(screen.queryByRole('button', { name: 'Add questions in this direction' })).toBeNull()
})
