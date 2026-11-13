// Regressions from the 2026-11-12 hands-on review of the mindmap clarify workspace
// against the RFC-378 contract. Each case names the defect it keeps from returning:
//   - option wording could not be selected, so "ask about this passage" never applied
//     to option descriptions or recommendation reasons (RFC-378 §3.3);
//   - the passage control rendered at the end of the reader, outside the view;
//   - the digit badges on options did nothing, because focus never reached the form;
//   - the review listed an unanswered question as "needs confirmation";
//   - the root "guide questions" form described itself as a category.
//
// RFC-490: the panorama reader these cases open is now a panel beside the canvas (the
// region "Answer and confirm"), not a dialog, and the outline keeps the keyboard when a
// row opens it. Focus reaches the answer form from a pick on the map or from "next
// pending", so the two focus cases below enter through the map.
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ClarifyQuestionSchema, type ClarifyAnswer } from '@agent-workflow/shared'
import { MindmapWorkspace } from '../src/components/clarify/mindmap/MindmapWorkspace'
import { DecisionReviewDialog } from '../src/components/clarify/mindmap/DecisionReviewDialog'
import { QuestionForm } from '../src/components/clarify/QuestionForm'
import { SELECTION_CONTROL, placeSelectionControl } from '../src/lib/clarify/mindmap/selection'

vi.mock('../src/components/clarify/mindmap/MindmapCanvas', () => ({
  MindmapCanvas: (props: { onSelect(id: string): void }) => (
    <>
      <div role="img" aria-label="Test map" />
      <button onClick={() => props.onSelect('q:q0')}>Pick Q1 on the map</button>
    </>
  ),
}))

const questions = ['Recovery target', 'Replica lag'].map((title, i) =>
  ClarifyQuestionSchema.parse({
    id: `q${i}`,
    title,
    kind: 'single',
    options: [
      {
        label: 'Streaming replica with PITR',
        description: 'Recovers within fifteen minutes but needs a standby.',
        recommended: true,
        recommendationReason: 'Fits a single-region internal service.',
      },
      { label: 'Nightly backup only', description: 'Cheapest; a day of data may be lost.' },
    ],
    mindmap: { categoryPath: ['Reliability'] },
  }),
)
const empty = (questionId: string): ClarifyAnswer => ({
  questionId,
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText: '',
})

function Harness({ status = 'awaiting_human' }: { status?: string }) {
  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>(
    Object.fromEntries(questions.map((q) => [q.id, empty(q.id)])),
  )
  const readonly = status !== 'awaiting_human'
  return (
    <MindmapWorkspace
      title="Report service"
      questions={questions}
      answers={answers}
      locked={readonly ? new Set(questions.map((q) => q.id)) : new Set()}
      disabled={readonly}
      roundStatus={status}
      followupPending={false}
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
          disabled={readonly}
        />
      )}
    />
  )
}
const focused = () => fireEvent.click(screen.getByRole('radio', { name: 'Focused answers' }))
const row = (name: RegExp) => screen.getByRole('treeitem', { name })
/** RFC-490: the reader beside the canvas. */
const pane = () => screen.getByRole('region', { name: 'Answer and confirm' })
const pickOnMap = () => fireEvent.click(screen.getByRole('button', { name: 'Pick Q1 on the map' }))
function selectText(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent(document, new Event('selectionchange'))
}

/** Rule bodies whose selector LIST contains `selector` (comments stripped first). */
function rulesFor(css: string, selector: string): string[] {
  const bodies: string[] = []
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if (
      match[1]!
        .split(',')
        .map((part) => part.trim())
        .includes(selector)
    )
      bodies.push(match[2]!)
  return bodies
}

test('option wording is selectable in the mindmap reader while the questionnaire keeps its click target', () => {
  const mindmap = readFileSync(
    join(__dirname, '../src/components/clarify/mindmap/mindmap.css'),
    'utf8',
  )
  const reader = rulesFor(mindmap, '.mindmap-workspace__detail .clarify-option')
  expect(reader.join('\n')).toMatch(/user-select:\s*text/)
  // The rule this one overrides still exists; without it the override proves nothing.
  const global = readFileSync(join(__dirname, '../src/styles.css'), 'utf8')
  expect(rulesFor(global, '.clarify-option').join('\n')).toMatch(/user-select:\s*none/)
})

test('the passage control is placed under the selection inside the scrolling reader', () => {
  const reader = { left: 100, top: 50, scrollLeft: 0, scrollTop: 400, clientWidth: 800 }
  // 300px below the reader top, scrolled 400px: 700px into the content, plus the gap.
  expect(placeSelectionControl({ left: 260, top: 330, bottom: 350 }, reader)).toEqual({
    top: 700 + SELECTION_CONTROL.gap,
    left: 160,
  })
  // A selection at the far right or left never pushes the control out of the reader.
  expect(placeSelectionControl({ left: 5000, top: 0, bottom: 60 }, reader).left).toBe(
    800 - SELECTION_CONTROL.width - SELECTION_CONTROL.margin,
  )
  expect(placeSelectionControl({ left: -40, top: 0, bottom: 60 }, reader).left).toBe(
    SELECTION_CONTROL.margin,
  )
})

test('selecting a recommendation reason offers the passage control next to it and quotes it', () => {
  const { container } = render(<Harness />)
  focused()
  fireEvent.click(row(/Recovery target/))
  selectText(screen.getByText(/Fits a single-region internal service/))
  const control = screen.getByRole('button', { name: 'Ask about this passage' })
  const box = control.parentElement!
  // In the scrolling reader (so it travels with the words), positioned by the selection.
  expect(box.parentElement).toBe(container.querySelector('.mindmap-question__reading'))
  expect(box.style.top).not.toBe('')
  expect(box.style.left).not.toBe('')
  fireEvent.click(control)
  expect(
    screen.getByText(/Fits a single-region internal service/, { selector: 'blockquote' }),
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Ask about this passage' })).toBeNull()
})

test('option reading text never chooses; the title row chooses unless it ends a selection', () => {
  render(<Harness />)
  focused()
  fireEvent.click(row(/Recovery target/))
  const radio = () => screen.getByLabelText(/Nightly backup only/) as HTMLInputElement
  // Description and recommendation reason are quotable text. A click there — also the
  // first click of a double or triple click — must not answer (dispatchEvent returns
  // false when the default action was prevented).
  const description = screen.getByText('Cheapest; a day of data may be lost.')
  expect(fireEvent.click(description)).toBe(false)
  expect(fireEvent.click(screen.getByText(/Fits a single-region internal service/))).toBe(false)
  expect(radio().checked).toBe(false)
  // The title row is the click target: an ordinary click passes through …
  const title = screen.getByText('Nightly backup only')
  expect(fireEvent.click(title)).toBe(true)
  // … but the click that ends a text selection inside that option does not.
  selectText(title)
  expect(fireEvent.click(title)).toBe(false)
  // A selection elsewhere does not block choosing another option.
  selectText(screen.getByRole('heading', { name: 'Recovery target' }))
  expect(fireEvent.click(title)).toBe(true)
  // The control itself always answers.
  selectText(description)
  fireEvent.click(radio())
  expect(radio().checked).toBe(true)
})

test('digit hotkeys keep working when focus rests on an option after a mouse pick, never in text', () => {
  const onChange = vi.fn()
  render(
    <QuestionForm question={questions[0]!} value={empty('q0')} index={1} onChange={onChange} />,
  )
  const radios = document.querySelectorAll<HTMLInputElement>('input[type=radio][data-option-idx]')
  fireEvent.keyDown(radios[0]!, { key: '2' })
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedOptionIndices: [1] }))
  onChange.mockClear()
  fireEvent.keyDown(screen.getByTestId('clarify-custom-textarea'), { key: '1' })
  expect(onChange).not.toHaveBeenCalled()
})

// RFC-490: the entry is a pick on the map. Enter on an outline row used to land here
// too, through the dialog's initial focus; the outline now keeps the keyboard (covered
// in rfc490-workspace-panel), so the map is the route by which focus reaches the form.
test('opening a question from the panorama focuses its answer form so a digit answers it', async () => {
  render(<Harness />)
  pickOnMap()
  expect(screen.queryByRole('dialog')).toBeNull()
  const form = () => pane().querySelector<HTMLElement>('.clarify-question')
  await waitFor(() => expect(document.activeElement).toBe(form()))
  expect(form()).not.toBeNull()
  fireEvent.keyDown(document.activeElement!, { key: '2' })
  expect((within(pane()).getByLabelText(/Nightly backup only/) as HTMLInputElement).checked).toBe(
    true,
  )
  // Confirming disables its own button; the keyboard stays on the same question.
  fireEvent.click(within(pane()).getByRole('button', { name: 'Confirm this answer' }))
  await waitFor(() => expect(document.activeElement).toBe(form()))
  expect(within(pane()).getByRole('heading', { name: 'Recovery target' })).toBeTruthy()
  // Moving on from inside the reader lands on the next question's form.
  fireEvent.click(within(pane()).getByRole('button', { name: /Next pending/ }))
  await waitFor(() =>
    expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toBe(
      'Replica lag',
    ),
  )
  expect(document.activeElement).toBe(form())
})

test('a read-only question keeps initial focus on its heading', async () => {
  render(<Harness status="answered" />)
  pickOnMap()
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(pane()).getByRole('heading', { name: 'Recovery target' }),
    ),
  )
})

test('outline keyboard navigation in the focused view keeps focus on the tree', () => {
  render(<Harness />)
  focused()
  const first = row(/Recovery target/)
  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(row(/Replica lag/))
  expect(screen.getByRole('heading', { name: 'Replica lag' })).toBeTruthy()
})

test('the root guidance form describes the whole round, not one category', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Question outline' }))
  // RFC-490: read from the panel beside the canvas; the next node replaces its content
  // without closing anything first.
  expect(within(pane()).getByRole('heading', { name: 'Report service' })).toBeTruthy()
  expect(within(pane()).getByText(/every question and answer in this round/)).toBeTruthy()
  expect(within(pane()).queryByText(/adds missing topics directly under it/)).toBeNull()
  fireEvent.click(row(/^Reliability/))
  expect(within(pane()).getByRole('heading', { name: 'Reliability' })).toBeTruthy()
  expect(within(pane()).getByText(/adds missing topics directly under it/)).toBeTruthy()
  expect(within(pane()).queryByText(/every question and answer in this round/)).toBeNull()
})

const reviewProps = {
  open: true,
  title: 'Report service',
  questions,
  locked: new Set<string>(),
  directive: 'stop' as const,
  onDirective: vi.fn(),
  onClose: vi.fn(),
  onEdit: vi.fn(),
  onSubmit: vi.fn(),
  disabled: true,
  busy: false,
  followupFailed: false,
  error: null,
  isCross: false,
}

test('the review names an unanswered question as unanswered, not as awaiting confirmation', () => {
  render(
    <DecisionReviewDialog
      {...reviewProps}
      answers={{ q0: { ...empty('q0'), selectedOptionIndices: [1] }, q1: empty('q1') }}
    />,
  )
  const [answered, unanswered] = screen.getAllByRole('article')
  expect(within(answered!).getByText('Nightly backup only')).toBeTruthy()
  expect(within(answered!).getByText('Needs confirmation')).toBeTruthy()
  expect(within(unanswered!).getByText('Unanswered')).toBeTruthy()
  expect(within(unanswered!).queryByText('Needs confirmation')).toBeNull()
})

test('a sealed round reads the same dialog as a summary with nothing to submit', () => {
  const close = vi.fn()
  render(
    <DecisionReviewDialog
      {...reviewProps}
      onClose={close}
      readonly
      locked={new Set(['q0', 'q1'])}
      blockReason="All questions have been handled."
      answers={{
        q0: { ...empty('q0'), selectedOptionIndices: [0] },
        q1: { ...empty('q1'), customText: 'Five minutes at most' },
      }}
    />,
  )
  expect(screen.getByRole('dialog', { name: 'Decision summary for this round' })).toBeTruthy()
  expect(screen.getByText('Five minutes at most')).toBeTruthy()
  expect(screen.queryByTestId('mindmap-review-submit')).toBeNull()
  expect(screen.queryByRole('radio', { name: 'Keep clarifying' })).toBeNull()
  expect(screen.queryByText('All questions have been handled.')).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Locate' })).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(close).toHaveBeenCalledOnce()
})
