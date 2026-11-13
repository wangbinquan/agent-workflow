// RFC-490 (design §4.1, §4.4, §6.2, §6.4, §6.5): in the panorama a node opens in a
// panel beside the canvas instead of a modal, so the map stays usable; where the
// keyboard goes and what Escape does are part of that contract. Configured categories
// nobody asked about are visible and can take questions; a skipped question remembers
// what it held; and once everything is handled the workspace says what is still worth
// another look. The canvas itself is replaced here: its camera rule is covered in
// rfc490-mindmap-layout.test.ts and its wiring in rfc372-mindmap-canvas.test.tsx.
import { useState } from 'react'
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  type ClarifyAnswer,
  type ClarifyFollowupTarget,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { MindmapWorkspace } from '../src/components/clarify/mindmap/MindmapWorkspace'
import { QuestionForm } from '../src/components/clarify/QuestionForm'

vi.mock('../src/components/clarify/mindmap/MindmapCanvas', () => ({
  MindmapCanvas: (props: { onSelect(id: string): void; columns: number; panelOpen?: boolean }) => (
    <div
      role="img"
      aria-label="Test map"
      data-columns={props.columns}
      data-panel-open={String(props.panelOpen === true)}
    >
      <button onClick={() => props.onSelect('q:q0')}>Canvas Q0</button>
      <button onClick={() => props.onSelect('q:q1')}>Canvas Q1</button>
    </div>
  ),
}))
afterEach(() => vi.unstubAllGlobals())

/** The stage reports this size as soon as it is observed. Other observers (the
 *  outline's virtual list) are left with nothing to react to. */
function stageWidth(width: number, height = 600) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(
        private callback: (
          entries: { target: Element; contentRect: { width: number; height: number } }[],
        ) => void,
      ) {}
      observe(target: Element) {
        if (target.classList.contains('mindmap-workspace__stage'))
          this.callback([{ target, contentRect: { width, height } }])
      }
      unobserve() {}
      disconnect() {}
    },
  )
}

const make = (id: string, title: string, recommended = false): ClarifyQuestion =>
  ClarifyQuestionSchema.parse({
    id,
    title,
    kind: 'single',
    options: [
      { label: 'Streaming replica', description: 'Needs a standby instance', recommended },
      { label: 'Nightly backup', description: 'Cheapest option' },
    ],
    mindmap: { categoryPath: ['Performance'] },
  })
const questions = [make('q0', 'Recovery target', true), make('q1', 'Replica lag')]
const blank = (questionId: string): ClarifyAnswer => ({
  questionId,
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText: '',
})
const confirmed = (question: ClarifyQuestion, patch: Partial<ClarifyAnswer> = {}) => {
  const value = { ...blank(question.id), selectedOptionIndices: [0], ...patch }
  return { ...value, confirmedBasis: clarifyAnswerBasis(question, value) }
}

function Harness(props: {
  initial?: Record<string, ClarifyAnswer>
  status?: string
  categoryPaths?: string[][]
  taskInputs?: { label: string; value: string }[]
  followup?: (target: ClarifyFollowupTarget, instruction: string) => Promise<void>
}) {
  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>(
    props.initial ?? Object.fromEntries(questions.map((q) => [q.id, blank(q.id)])),
  )
  const readonly = (props.status ?? 'awaiting_human') !== 'awaiting_human'
  return (
    <MindmapWorkspace
      title="Report service"
      questions={questions}
      answers={answers}
      locked={readonly ? new Set(questions.map((q) => q.id)) : new Set()}
      disabled={readonly}
      roundStatus={props.status ?? 'awaiting_human'}
      followupPending={false}
      categoryPaths={props.categoryPaths}
      taskInputs={props.taskInputs}
      onChange={(id, value) => setAnswers((old) => ({ ...old, [id]: value }))}
      onFollowup={props.followup ?? (async () => {})}
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
          disabled={readonly}
        />
      )}
    />
  )
}
const pane = () => screen.getByRole('region', { name: 'Answer and confirm' })
const noPane = () => expect(screen.queryByRole('region', { name: 'Answer and confirm' })).toBeNull()
const row = (name: RegExp) => screen.getByRole('treeitem', { name })
const form = () => pane().querySelector<HTMLElement>('.clarify-question')
/** A real click lands on a focused control. */
const press = (element: HTMLElement) => {
  element.focus()
  fireEvent.click(element)
}

test('a canvas node opens beside the map, not in a modal, and another click switches it', () => {
  const { container } = render(<Harness />)
  noPane()
  const map = screen.getByRole('img', { name: 'Test map' })
  expect(map.getAttribute('data-panel-open')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q0' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(within(pane()).getByRole('heading', { name: 'Recovery target' })).toBeTruthy()
  // The map is still there, in the same stage, sharing it with the panel.
  const panes = container.querySelector('.mindmap-workspace__panes')!
  expect(panes.getAttribute('data-split')).toBe('side')
  expect(panes.contains(map)).toBe(true)
  expect(container.querySelector('.mindmap-workspace__map')!.hasAttribute('hidden')).toBe(false)
  expect(map.getAttribute('data-panel-open')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q1' }))
  expect(within(pane()).getByRole('heading', { name: 'Replica lag' })).toBeTruthy()
  expect(within(pane()).queryByRole('heading', { name: 'Recovery target' })).toBeNull()
  // The full-width reader is the same panel without the split.
  fireEvent.click(within(pane()).getByRole('button', { name: 'Open in focused answers' }))
  expect(panes.hasAttribute('data-split')).toBe(false)
  expect(container.querySelector('.mindmap-workspace__map')!.hasAttribute('hidden')).toBe(true)
  expect(within(pane()).getByRole('heading', { name: 'Replica lag' })).toBeTruthy()
  expect(within(pane()).queryByRole('button', { name: 'Open in focused answers' })).toBeNull()
})

test('a stage too narrow to share gives the panel the whole stage', async () => {
  stageWidth(700)
  const { container } = render(<Harness />)
  const map = await screen.findByRole('img', { name: 'Test map' })
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q0' }))
  expect(container.querySelector('.mindmap-workspace__panes')!.getAttribute('data-split')).toBe(
    'full',
  )
  // The canvas is told it has not been narrowed: it is simply not shown.
  expect(map.getAttribute('data-panel-open')).toBe('false')
  expect(within(pane()).queryByRole('button', { name: 'Open in focused answers' })).toBeNull()
  fireEvent.click(within(pane()).getByRole('button', { name: /Back to mindmap/ }))
  noPane()
})

test('the reason for an answer sits beside the confirm button when the panel has the room', async () => {
  for (const [width, height, home] of [
    [1000, 600, '.mindmap-question__actions'],
    // Too short (a phone, a small laptop): the options keep the room, the reason follows.
    [1000, 400, '.mindmap-question__reading'],
    // Tall enough, but the panel beside the canvas is 420 wide here: the reason and the
    // maturity would take a row each.
    [834, 612, '.mindmap-question__reading'],
  ] as const) {
    stageWidth(width, height)
    const view = render(<Harness />)
    await screen.findByRole('img', { name: 'Test map' })
    fireEvent.click(screen.getByRole('button', { name: 'Canvas Q0' }))
    fireEvent.click(within(pane()).getByLabelText(/Nightly backup/))
    const rationale = within(pane()).getByLabelText('My rationale (optional)')
    expect(rationale.closest(home)).not.toBeNull()
    expect(within(pane()).getByRole('radio', { name: 'Provisional' }).closest(home)).not.toBeNull()
    // The remaining notes stay under the options either way, in one fold.
    const more = pane().querySelectorAll('details.mindmap-decision__more')
    expect(more).toHaveLength(1)
    expect(more[0]!.closest('.mindmap-question__reading')).not.toBeNull()
    // So does the note on a skip.
    fireEvent.click(within(pane()).getByRole('button', { name: 'Decide later' }))
    const note = within(pane()).getByLabelText('What is missing to decide (optional)')
    expect(note.closest(home)).not.toBeNull()
    expect(within(pane()).getAllByLabelText('What is missing to decide (optional)')).toHaveLength(1)
    view.unmount()
    vi.unstubAllGlobals()
  }
})

test('the same question in the full-width reader has the room the side panel lacked', async () => {
  stageWidth(834, 612)
  render(<Harness />)
  await screen.findByRole('img', { name: 'Test map' })
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q0' }))
  fireEvent.click(within(pane()).getByLabelText(/Nightly backup/))
  const home = () =>
    within(pane())
      .getByLabelText('My rationale (optional)')
      .closest('.mindmap-question__actions, .mindmap-question__reading')!.className
  expect(home()).toBe('mindmap-question__reading')
  fireEvent.click(within(pane()).getByRole('button', { name: 'Open in focused answers' }))
  expect(home()).toBe('mindmap-question__actions')
})

test('closing hands the keyboard back after the panel is gone, and only if the panel had it', async () => {
  stageWidth(700)
  render(<Harness />)
  await screen.findByRole('img', { name: 'Test map' })
  // Opened from the canvas: the keyboard went into the panel, so it comes back out.
  const origin = screen.getByRole('button', { name: 'Canvas Q0' })
  press(origin)
  await waitFor(() => expect(document.activeElement).toBe(form()))
  fireEvent.click(within(pane()).getByRole('button', { name: /Back to mindmap/ }))
  noPane()
  expect(document.activeElement).toBe(origin)
  // Opened from the outline: the row kept the keyboard and keeps it.
  const first = row(/Recovery target/)
  press(first)
  fireEvent.click(within(pane()).getByRole('button', { name: /Back to mindmap/ }))
  noPane()
  expect(document.activeElement).toBe(first)
})

test('a canvas pick hands the keyboard to the answer form; Escape returns it and keeps the edits', async () => {
  render(<Harness />)
  const origin = screen.getByRole('button', { name: 'Canvas Q0' })
  press(origin)
  await waitFor(() => expect(document.activeElement).toBe(form()))
  fireEvent.keyDown(document.activeElement!, { key: '2' })
  expect((within(pane()).getByLabelText(/Nightly backup/) as HTMLInputElement).checked).toBe(true)
  fireEvent.change(within(pane()).getByLabelText('My rationale (optional)'), {
    target: { value: 'Budget first' },
  })
  // A key a child layer already used (a listbox, say) is not the panel's to take.
  const used = createEvent.keyDown(pane(), { key: 'Escape' })
  used.preventDefault()
  fireEvent(pane(), used)
  expect(pane()).toBeTruthy()
  fireEvent.keyDown(form()!, { key: 'Escape' })
  noPane()
  expect(document.activeElement).toBe(origin)
  fireEvent.click(origin)
  expect((within(pane()).getByLabelText(/Nightly backup/) as HTMLInputElement).checked).toBe(true)
  expect(within(pane()).getByDisplayValue('Budget first')).toBeTruthy()
  // "Back to mindmap" is the same exit for pointer users.
  fireEvent.click(within(pane()).getByRole('button', { name: /Back to mindmap/ }))
  noPane()
})

test('the outline keeps the keyboard: a row opens the panel, arrows browse, Escape closes', () => {
  render(<Harness />)
  const first = row(/Recovery target/)
  // Enter on a row opens the panel and stays on the row.
  first.focus()
  fireEvent.keyDown(first, { key: 'Enter' })
  expect(within(pane()).getByRole('heading', { name: 'Recovery target' })).toBeTruthy()
  expect(document.activeElement).toBe(first)
  // So does a click.
  press(row(/Replica lag/))
  expect(within(pane()).getByRole('heading', { name: 'Replica lag' })).toBeTruthy()
  expect(document.activeElement).toBe(row(/Replica lag/))
  fireEvent.keyDown(row(/Replica lag/), { key: 'ArrowUp' })
  expect(document.activeElement).toBe(row(/Recovery target/))
  expect(within(pane()).getByRole('heading', { name: 'Recovery target' })).toBeTruthy()
  // Escape from the row closes the panel; the row keeps the focus it never gave up.
  fireEvent.keyDown(row(/Recovery target/), { key: 'Escape' })
  noPane()
  expect(document.activeElement).toBe(row(/Recovery target/))
})

test('Escape in the search box clears the search first and only then reaches the panel', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q0' }))
  const search = screen.getByRole('textbox', { name: /^Search/ })
  fireEvent.change(search, { target: { value: 'replica' } })
  fireEvent.keyDown(search, { key: 'Escape' })
  expect((search as HTMLInputElement).value).toBe('')
  expect(pane()).toBeTruthy()
  fireEvent.keyDown(search, { key: 'Escape' })
  noPane()
})

test('a read-only question hands focus to its heading', async () => {
  render(<Harness status="answered" />)
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q0' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(pane()).getByRole('heading', { name: 'Recovery target' }),
    ),
  )
})

test('before the stage can be measured the column count is estimated from the window', () => {
  // jsdom lays nothing out: a 1024 px window stands in, which is four columns.
  render(<Harness />)
  expect(screen.getByRole('img', { name: 'Test map' }).getAttribute('data-columns')).toBe('4')
})

test('the measured stage decides the columns, and the panel never changes them', async () => {
  stageWidth(420)
  render(<Harness />)
  const map = await screen.findByRole('img', { name: 'Test map' })
  expect(map.getAttribute('data-columns')).toBe('1')
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q0' }))
  fireEvent.click(within(pane()).getByRole('button', { name: /Back to mindmap/ }))
  expect(screen.getByRole('img', { name: 'Test map' }).getAttribute('data-columns')).toBe('1')
})

test('skipping remembers the answer it replaced, and answering instead brings it back', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q0' }))
  fireEvent.click(within(pane()).getByLabelText(/Nightly backup/))
  fireEvent.change(within(pane()).getByLabelText('My rationale (optional)'), {
    target: { value: 'Budget first' },
  })
  fireEvent.click(within(pane()).getByRole('button', { name: 'Not applicable' }))
  expect(within(pane()).getByText('Marked: Not applicable')).toBeTruthy()
  expect((within(pane()).getByLabelText(/Nightly backup/) as HTMLInputElement).checked).toBe(false)
  // Skipped means handled: the outline already shows it as confirmed.
  expect(within(row(/Recovery target/)).getByTitle('Confirmed')).toBeTruthy()
  // The note does not undo that.
  fireEvent.change(within(pane()).getByLabelText('Why it does not apply (optional)'), {
    target: { value: 'Single region only' },
  })
  expect(within(row(/Recovery target/)).getByTitle('Confirmed')).toBeTruthy()
  // Another question in between does not lose what was remembered.
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Canvas Q0' }))
  fireEvent.click(within(pane()).getByRole('button', { name: 'Answer instead' }))
  expect((within(pane()).getByLabelText(/Nightly backup/) as HTMLInputElement).checked).toBe(true)
  // The earlier rationale returns; the question waits for confirmation again.
  expect(within(pane()).getByDisplayValue('Budget first')).toBeTruthy()
  expect(within(row(/Recovery target/)).getByTitle('Needs confirmation')).toBeTruthy()
  expect(within(pane()).queryByText(/^Marked:/)).toBeNull()
})

test('a configured category nobody asked about is visible and takes questions in place', async () => {
  const followup = vi.fn(async () => {})
  render(
    <Harness categoryPaths={[['Performance'], ['Reliability', 'Recovery']]} followup={followup} />,
  )
  const empty = row(/^Recovery/)
  expect(within(empty).getByText('No questions yet')).toBeTruthy()
  expect(row(/^Performance/).textContent).not.toContain('No questions yet')
  fireEvent.click(empty)
  expect(within(pane()).getByRole('heading', { name: 'Recovery' })).toBeTruthy()
  expect(within(pane()).getByText(/has not asked anything in this direction yet/)).toBeTruthy()
  fireEvent.change(within(pane()).getByLabelText('What else should AI consider? (optional)'), {
    target: { value: 'Failover drills' },
  })
  fireEvent.click(within(pane()).getByRole('button', { name: 'Generate questions' }))
  await waitFor(() =>
    expect(followup).toHaveBeenCalledWith(['Reliability', 'Recovery'], 'Failover drills'),
  )
})

test('a sealed round still shows the gap but offers no way to fill it', () => {
  render(<Harness status="answered" categoryPaths={[['Reliability']]} />)
  fireEvent.click(row(/^Reliability/))
  expect(within(pane()).getByText('No questions yet')).toBeTruthy()
  expect(within(pane()).queryByRole('button', { name: 'Generate questions' })).toBeNull()
})

test('a gap closes with the map: once every question is handled elsewhere it only reads', () => {
  // The round is still open, but each of its questions was sealed through another
  // channel. The whole map takes no more questions then, and neither does the gap in it.
  function AllHandled() {
    const [answers] = useState(Object.fromEntries(questions.map((q) => [q.id, confirmed(q)])))
    return (
      <MindmapWorkspace
        title="Report service"
        questions={questions}
        answers={answers}
        locked={new Set(questions.map((q) => q.id))}
        disabled={false}
        roundStatus="awaiting_human"
        followupPending={false}
        categoryPaths={[['Reliability']]}
        onChange={() => {}}
        onFollowup={async () => {}}
        onCancelFollowup={async () => {}}
        renderQuestion={() => null}
      />
    )
  }
  render(<AllHandled />)
  // Nothing can be added any more, so nothing is suggested either.
  expect(screen.queryByRole('button', { name: /worth another look/ })).toBeNull()
  fireEvent.click(row(/^Reliability/))
  expect(within(pane()).getByText('No questions yet')).toBeTruthy()
  expect(within(pane()).queryByRole('button', { name: 'Generate questions' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
  expect(within(pane()).queryByRole('button', { name: 'Generate questions' })).toBeNull()
})

test('task inputs are readable from the root node', () => {
  render(<Harness taskInputs={[{ label: 'Design topic', value: 'Reporting for 500 employees' }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
  fireEvent.click(within(pane()).getByText('Task input'))
  expect(within(pane()).getByText('Design topic')).toBeTruthy()
  expect(within(pane()).getByText('Reporting for 500 employees')).toBeTruthy()
})

test('the outline search finds a question by an option or by my own answer and shows why', () => {
  const [q0, q1] = questions
  render(
    <Harness
      initial={{
        q0: { ...blank(q0!.id), customText: 'Point-in-time recovery within fifteen minutes' },
        q1: blank(q1!.id),
      }}
    />,
  )
  const search = screen.getByRole('textbox', { name: /^Search/ })
  // An option's description, present on both questions.
  fireEvent.change(search, { target: { value: 'standby' } })
  expect(screen.getAllByRole('option')).toHaveLength(2)
  expect(screen.getAllByText(/^Match: .*standby instance/)).toHaveLength(2)
  // My own words, on one of them.
  fireEvent.change(search, { target: { value: 'fifteen' } })
  const hits = screen.getAllByRole('option')
  expect(hits).toHaveLength(1)
  expect(within(hits[0]!).getByText('Recovery target')).toBeTruthy()
  expect(within(hits[0]!).getByText(/^Match: .*within fifteen minutes/)).toBeTruthy()
  // A title hit needs no explanation.
  fireEvent.change(search, { target: { value: 'lag' } })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  expect(screen.queryByText(/^Match:/)).toBeNull()
})

test('once everything is handled the workspace lists what is worth another look, with one action each', async () => {
  const followup = vi.fn(async () => {})
  const [q0, q1] = questions
  render(
    <Harness
      categoryPaths={[['Performance'], ['Reliability']]}
      followup={followup}
      initial={{
        // Took the recommendation, wrote nothing; and deferred the other one.
        q0: confirmed(q0!),
        q1: confirmed(q1!, { selectedOptionIndices: [], decision: { status: 'deferred' } }),
      }}
    />,
  )
  expect(
    screen.getByText('This round’s answers are confirmed. Review decisions before submitting.'),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '3 things worth another look' }))
  const steps = within(pane()).getByRole('region', { name: 'Suggested next steps' })
  expect(
    within(steps)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual([
    '“Reliability” has no questions yetAsk AI to add',
    '1 questions were deferredRevisit',
    'Q1 took the recommendation without a rationaleCheck the evidence',
  ])
  fireEvent.click(within(steps).getByRole('button', { name: 'Check the evidence' }))
  expect(within(pane()).getByRole('heading', { name: 'Recovery target' })).toBeTruthy()
  expect(
    (within(pane()).getByLabelText('What needs more detail? (optional)') as HTMLTextAreaElement)
      .value,
  ).toContain('Which assumptions behind this choice remain unverified?')
  fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
  fireEvent.click(within(pane()).getByRole('button', { name: 'Revisit' }))
  expect(within(pane()).getByRole('heading', { name: 'Replica lag' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
  fireEvent.click(within(pane()).getByRole('button', { name: 'Ask AI to add' }))
  expect(within(pane()).getByRole('heading', { name: 'Reliability' })).toBeTruthy()
})

test('suggestions stay out of the way while questions are open and on a sealed round', () => {
  const { unmount } = render(<Harness categoryPaths={[['Reliability']]} />)
  expect(screen.queryByRole('button', { name: /worth another look/ })).toBeNull()
  unmount()
  render(<Harness status="answered" categoryPaths={[['Reliability']]} />)
  expect(screen.queryByRole('button', { name: /worth another look/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
  expect(within(pane()).queryByRole('region', { name: 'Suggested next steps' })).toBeNull()
})
