// RFC-372 UX regressions found with the daily AW real-model task: false hierarchy,
// duplicated/truncated reading, shared follow-up text and misleading completion.
//
// RFC-490 rewrote the interactions these cases go through, not what they protect:
//   - the panorama reader is a panel beside the canvas (a region named "Answer and
//     confirm"), no longer a modal dialog, so cases that looked inside `role="dialog"`
//     look inside that region and Escape is pressed inside the workspace;
//   - a follow-up is opened from the single "Follow up:" row ("Write my own…" opens
//     the empty form) and sent with "Generate follow-ups" / "Generate questions";
//     the "Deepen this question" toggle and its `aria-expanded` are gone;
//   - the outline search also matches options and answers, hence its new label.
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
import { indexMindmapNavigation } from '../src/lib/clarify/mindmap/navigation'

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
/** RFC-490: the reader, beside the canvas in the panorama and full width when focused. */
const pane = () => screen.getByRole('region', { name: 'Answer and confirm' })
const noPane = () => expect(screen.queryByRole('region', { name: 'Answer and confirm' })).toBeNull()
const SEARCH = 'Search categories, questions, options or answers'
/** RFC-490: every way the reader can change a question. A sealed or submitted one
 *  offers none of them (before RFC-490 the pair was "Deepen this question" + confirm). */
function expectNoWriteEntry() {
  for (const name of [
    'Confirm this answer',
    /Confirm and next/,
    'Write my own…',
    'Check the evidence',
    'Consider the cost',
    'Compare alternatives',
    'Generate follow-ups',
    'Not applicable',
    'Decide later',
    'Answer instead',
  ])
    expect(screen.queryByRole('button', { name })).toBeNull()
  expect(screen.queryByText('Follow up:')).toBeNull()
  expect(screen.queryByLabelText('My rationale (optional)')).toBeNull()
}

// Dense rows must keep the actual multi-level category/question tree and usable
// disclosure focus, instead of trading correctness for a smaller screenshot.
test('outline rails continue only through ancestors with later siblings and stay bounded at depth 100', () => {
  const make = (id: string, parentQuestionId?: string) =>
    ClarifyQuestionSchema.parse({
      id,
      title: id,
      kind: 'single',
      options: ['A', 'B'],
      mindmap: { categoryPath: ['Performance', 'Database'], parentQuestionId },
    })
  const source = [make('a'), make('a1', 'a'), make('deep', 'a1'), make('a2', 'a'), make('b')]
  const index = indexMindmapNavigation(projectClarifyMindmap(source, {}, new Set(), 'Root'))
  expect(index.byRowId.get('g:["Performance","Database"]')?.depth).toBe(2)
  expect(index.byRowId.get('q:a1')?.guideDepths).toEqual([2])
  expect(index.byRowId.get('q:deep')?.guideDepths).toEqual([2, 3])
  expect(index.byRowId.get('q:a2')?.guideDepths).toEqual([2])
  expect(index.byRowId.get('q:b')?.guideDepths).toEqual([])
  expect(index.byRowId.get('q:a2')?.position).toBe(index.byRowId.get('q:a2')?.siblings)
  const deep = Array.from({ length: 100 }, (_, i) => make(`d${i}`, i ? `d${i - 1}` : undefined))
  const deepIndex = indexMindmapNavigation(projectClarifyMindmap(deep, {}, new Set(), 'Root'))
  expect(deepIndex.byRowId.get('q:d99')?.depth).toBe(102)
  expect(deepIndex.rows.every((row) => row.guideDepths.length <= 4)).toBe(true)
})

test('SVG disclosure folds without opening or selecting a question and leaves a reachable focused row', () => {
  render(<Harness />)
  const parent = screen.getByRole('treeitem', { name: /Main decision/ })
  const toggle = within(parent).getByRole('button', { name: 'Collapse children Main decision' })
  const selection = document.querySelector('[role="treeitem"][aria-selected="true"]')
  expect(toggle.querySelector('svg')).toBeTruthy()
  fireEvent.click(toggle)
  // RFC-490: "nothing opened" is now "no reader panel" (it used to be "no dialog").
  noPane()
  expect(screen.queryByRole('treeitem', { name: /Network timeout recovery/ })).toBeNull()
  expect(document.querySelector('[role="treeitem"][aria-selected="true"]')).toBe(selection)
  expect(document.activeElement).toBe(parent)
  expect(parent.tabIndex).toBe(0)
  expect(document.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1)
  fireEvent.keyDown(parent, { key: 'ArrowRight' })
  expect(screen.getByRole('treeitem', { name: /Network timeout recovery/ })).toBeTruthy()
  noPane()
  fireEvent.keyDown(parent, { key: 'Enter' })
  expect(within(pane()).getByRole('heading', { name: 'Main decision' })).toBeTruthy()
  // RFC-490: Enter opens the reader beside the map; it is not a dialog, and the row
  // that opened it keeps the keyboard.
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(parent)
})

test('compact row preserves full titles, category progress and separate own versus descendant status', () => {
  render(<Harness />)
  const parent = screen.getByRole('treeitem', { name: /Main decision/ })
  expect(within(parent).getByText('Main decision').getAttribute('title')).toBe('Main decision')
  expect(within(parent).getByText('Confirmed')).toBeTruthy()
  expect(within(parent).getByText('2 child questions pending')).toBeTruthy()
  expect(within(parent).queryByText('Unanswered')).toBeNull()
  const group = screen.getByRole('treeitem', { name: /^Concurrency/ })
  expect(within(group).getByTitle('1 / 3 Confirmed')).toBeTruthy()
  expect(within(group).getByText('Unanswered')).toBeTruthy()
  expect(group.getAttribute('aria-level')).toBe('2')
})

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
  fireEvent.change(screen.getByRole('textbox', { name: SEARCH }), {
    target: { value: 'retention' },
  })
  const result = screen.getByRole('option', { name: /Idempotency retention/ })
  expect(within(result).getByText('Data consistency / Concurrency / Q1 / Q2')).toBeTruthy()
  fireEvent.click(result)
  fireEvent.change(screen.getByRole('textbox', { name: SEARCH }), {
    target: { value: '' },
  })
  expect(screen.getByRole('treeitem', { name: /Network timeout recovery/ })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Idempotency retention' })).toBeTruthy()
  // RFC-490: the ancestry is read from the origin card. It names the question this
  // one was asked from (it used to be a "Follow-up to Q2 · Show full path" fold) and
  // keeps the older ancestors one step away.
  const origin = within(
    screen.getByRole('complementary', { name: 'Where this question came from' }),
  )
  expect(origin.getByText('Follow-up to Q2 · Network timeout recovery')).toBeTruthy()
  expect(origin.getByText('Show full path')).toBeTruthy()
  expect(origin.getByText('Q1 · Main decision')).toBeTruthy()
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
  // RFC-490: "Write my own…" in the follow-up row opens the empty form (it used to be
  // the "Deepen this question" toggle); "Generate follow-ups" sends it.
  fireEvent.click(screen.getByRole('button', { name: 'Write my own…' }))
  const hint = screen.getByLabelText('What needs more detail? (optional)')
  fireEvent.change(hint, { target: { value: 'Retain this branch guidance' } })
  fireEvent.click(screen.getByRole('button', { name: 'Generate follow-ups' }))
  select('Network timeout recovery')
  fireEvent.click(screen.getByLabelText(/Create another booking/))
  fireEvent.click(screen.getByRole('button', { name: 'Write my own…' }))
  expect(
    (screen.getByLabelText('What needs more detail? (optional)') as HTMLTextAreaElement).value,
  ).toBe('')
  expect(screen.getByRole('button', { name: 'Generate follow-ups' }).hasAttribute('disabled')).toBe(
    true,
  )
  await act(async () => {
    reject(new Error('missing mindmap category: q1'))
  })
  expect(screen.getByRole('heading', { name: 'Network timeout recovery' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View failed follow-up' }))
  expect(
    (screen.getByLabelText('What needs more detail? (optional)') as HTMLTextAreaElement).value,
  ).toBe('Retain this branch guidance')
  expect(
    screen
      .getByText(/The follow-up did not finish\. Existing answers are kept/)
      .getAttribute('role'),
  ).toBe('alert')
  fireEvent.click(screen.getByText('Technical details', { exact: true }))
  expect(screen.getByText('missing mindmap category: q1', { exact: true })).toBeTruthy()
  expect(followup).toHaveBeenCalledWith('q0', 'Retain this branch guidance')
})

test('submitted history states submission and keeps all answer/follow-up mutations unavailable', () => {
  renderFocused(<Harness status="answered" />)
  expect(
    screen.getByText('This round was submitted. Confirmed answers are available to read.'),
  ).toBeTruthy()
  select('Main decision')
  expectNoWriteEntry()
  expect((screen.getByLabelText(/Create another booking/) as HTMLInputElement).disabled).toBe(true)
})

test('filtering out a selected question and collapsing its ancestor retain a keyboard entry point', () => {
  renderFocused(<Harness />)
  select('Idempotency retention')
  fireEvent.change(screen.getByRole('textbox', { name: SEARCH }), {
    target: { value: 'Main decision' },
  })
  expect(screen.getByRole('option', { name: /Main decision/ }).tabIndex).toBe(0)
  expect(screen.getByRole('heading', { name: 'Idempotency retention' })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: SEARCH }), {
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
    fireEvent.click(screen.getByRole('button', { name: 'Write my own…' }))
    const reading = container.querySelector('.mindmap-question__reading')!
    expect(reading.scrollTop).toBe(450)
    select('Network timeout recovery')
    select('Main decision')
    // RFC-490: there is no toggle to read `aria-expanded` from any more; the form
    // itself being back, under its own heading, is what "still expanded" means.
    expect(screen.getByRole('heading', { name: 'Follow up on Q1' })).toBeTruthy()
    expect(screen.getByLabelText('What needs more detail? (optional)')).toBeTruthy()
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
  expect(screen.queryByText('This round’s answers are confirmed and ready to submit.')).toBeNull()
  expect(
    screen.queryByText('This round was submitted. Confirmed answers are available to read.'),
  ).toBeNull()
  select('Main decision')
  expectNoWriteEntry()
})

// RFC-490 (C1) replaces "panorama opens a modal": a node now opens in a panel that
// shares the stage with the canvas. What this case protected is unchanged — edits and
// the follow-up direction survive closing with Escape, the keyboard goes back to where
// it came from, and the focused view reads the same answers — and it now also holds
// that the reader is not modal.
test('panorama opens a panel beside the map, retains edits on Escape, restores focus and shares answers with focus view', async () => {
  const { container } = render(<Harness />)
  const row = screen.getByRole('treeitem', { name: /Main decision/ })
  fireEvent.keyDown(row, { key: 'ArrowDown' })
  noPane()
  row.focus()
  fireEvent.keyDown(row, { key: 'Enter' })
  const panel = pane()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(panel.hasAttribute('aria-modal')).toBe(false)
  // The map is still there: same stage, shared with the panel, nothing hidden.
  const panes = container.querySelector('.mindmap-workspace__panes')!
  expect(panes.getAttribute('data-split')).toBe('side')
  expect(panes.contains(panel)).toBe(true)
  expect(panes.contains(screen.getByRole('img', { name: 'Test map' }))).toBe(true)
  expect(container.querySelector('.mindmap-workspace__map')!.hasAttribute('hidden')).toBe(false)
  // Opening from the outline leaves the keyboard on the row.
  expect(document.activeElement).toBe(row)
  fireEvent.click(within(panel).getByLabelText(/Create another booking/))
  fireEvent.click(within(panel).getByRole('button', { name: 'Write my own…' }))
  fireEvent.change(within(panel).getByLabelText('What needs more detail? (optional)'), {
    target: { value: 'Keep this instruction' },
  })
  // Escape is no longer caught on `window` by a dialog. From inside the panel it
  // closes the panel and hands the keyboard back to the row that opened it.
  const form = panel.querySelector<HTMLElement>('.clarify-question')!
  form.focus()
  expect(document.activeElement).toBe(form)
  fireEvent.keyDown(form, { key: 'Escape' })
  noPane()
  expect(document.activeElement).toBe(row)
  select('Main decision')
  expect((screen.getByLabelText(/Create another booking/) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByDisplayValue('Keep this instruction')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open in focused answers' }))
  // The focused view is the same reader without the split.
  expect(panes.hasAttribute('data-split')).toBe(false)
  expect(container.querySelector('.mindmap-workspace__map')!.hasAttribute('hidden')).toBe(true)
  expect(screen.getAllByRole('heading', { name: 'Main decision' })).toHaveLength(1)
  expect((screen.getByLabelText(/Create another booking/) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByDisplayValue('Keep this instruction')).toBeTruthy()
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
  fireEvent.change(within(pane()).getByLabelText('What else should AI consider? (optional)'), {
    target: { value: 'Also consider database performance' },
  })
  // RFC-490: the category submit reads "Generate questions".
  fireEvent.click(within(pane()).getByRole('button', { name: 'Generate questions' }))
  expect(followup).toHaveBeenCalledWith(['Data consistency'], 'Also consider database performance')
  // Closing the reader (Escape inside the workspace; it used to be the dialog's
  // Escape on `window`) leaves the generation running.
  fireEvent.keyDown(within(pane()).getByRole('heading', { name: 'Data consistency' }), {
    key: 'Escape',
  })
  noPane()
  expect(cancel).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'View generating branch' }))
  expect(within(pane()).getByDisplayValue('Also consider database performance')).toBeTruthy()
  // RFC-490: the generating branch offers the cancel inside its own form. From any
  // other branch it is the one in the workspace's progress row, which a side panel
  // no longer covers (the modal had to repeat it in its toolbar).
  expect(within(pane()).getByRole('button', { name: 'Cancel follow-up' })).toBeTruthy()
  fireEvent.click(within(pane()).getByRole('button', { name: /^Concurrency/ }))
  expect(within(pane()).getByRole('heading', { name: 'Concurrency' })).toBeTruthy()
  expect(within(pane()).queryByRole('button', { name: 'Cancel follow-up' })).toBeNull()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel follow-up' }))
  })
  expect(cancel).toHaveBeenCalledOnce()
  // No modal to leave first: the outline is reachable with the panel open.
  fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
  expect(within(pane()).getByRole('heading', { name: 'Room booking' })).toBeTruthy()
  fireEvent.click(within(pane()).getByRole('button', { name: 'Generate questions' }))
  expect(followup).toHaveBeenLastCalledWith([], '')
  await act(async () => {
    resolve()
  })
})

test('sealed category and submitted history do not expose category generation', () => {
  for (const props of [{ sealed: true }, { status: 'answered' }]) {
    const { unmount } = render(<Harness {...props} />)
    fireEvent.click(screen.getByRole('treeitem', { name: /^Data consistency/ }))
    // The branch is open and readable; only the way to add to it is missing.
    expect(within(pane()).getByRole('heading', { name: 'Data consistency' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Generate questions' })).toBeNull()
    expect(screen.queryByLabelText('What else should AI consider? (optional)')).toBeNull()
    unmount()
  }
})

// RFC-372 review follow-up O6: "Guide questions in this branch" names a surface that
// can still guide; a sealed branch or submitted round is only read under its own name.
// RFC-490: that surface was the modal's title. The panel is always the region "Answer
// and confirm", so the same rule is now carried by its headings: the branch name heads
// the panel, and the guidance heading appears only where guidance can be given.
test('a category panel is headed by its branch, and by the guidance it offers only while it can guide', () => {
  const { unmount } = render(<Harness />)
  fireEvent.click(screen.getByRole('treeitem', { name: /^Data consistency/ }))
  expect(within(pane()).getByRole('heading', { name: 'Data consistency' })).toBeTruthy()
  expect(
    within(pane()).getByRole('heading', { name: 'Guide questions in this branch' }),
  ).toBeTruthy()
  unmount()

  for (const props of [{ sealed: true }, { status: 'answered' }]) {
    const { unmount: close } = render(<Harness {...props} />)
    fireEvent.click(screen.getByRole('treeitem', { name: /^Data consistency/ }))
    expect(within(pane()).getByRole('heading', { name: 'Data consistency' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Guide questions in this branch' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
    expect(within(pane()).getByRole('heading', { name: 'Room booking' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Data consistency' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Guide questions in this branch' })).toBeNull()
    close()
  }
})
