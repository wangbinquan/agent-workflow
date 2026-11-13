// RFC-490 (design §6.1, §2.1, proposal C13): the decision notes come in two layouts.
// `inline` is the mindmap's: the rationale and the maturity stay in view under the
// answer and only the four remaining notes fold away, opening by themselves when there
// is something in them or the decision is provisional. The default layout is the one
// the ordinary questionnaire and the centralized answer dialog keep; it never offers
// the two skip statuses, shows a skipped answer as "Unmarked", and labels the note by
// what it explains. The read-only form (DecisionReadback) uses the same labels.
// How the panel wires the inline layout is covered in rfc490-question-pane.test.tsx.
import { useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { ClarifyAnswer, ClarifyDecision } from '@agent-workflow/shared'
import {
  DecisionDetails,
  DecisionReadback,
} from '../src/components/clarify/mindmap/DecisionDetails'

const chosen: ClarifyAnswer = {
  questionId: 'q',
  selectedOptionIndices: [0],
  selectedOptionLabels: [],
  customText: '',
}
const withDecision = (decision: ClarifyDecision): ClarifyAnswer => ({ ...chosen, decision })

function Host(props: {
  initial: ClarifyAnswer
  layout?: 'collapsed' | 'inline'
  onChange?: (next: ClarifyAnswer) => void
}) {
  const [value, setValue] = useState(props.initial)
  return (
    <DecisionDetails
      answer={value}
      disabled={false}
      layout={props.layout}
      onChange={(next) => {
        props.onChange?.(next)
        setValue(next)
      }}
    />
  )
}
const maturity = () => screen.getByRole('radiogroup', { name: 'Decision status' })
const marks = () =>
  within(maturity())
    .getAllByRole('radio')
    .map((radio) => [radio.textContent, radio.getAttribute('aria-checked')])
const fold = (container: HTMLElement) =>
  container.querySelector<HTMLDetailsElement>('details.mindmap-decision__more')!
const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.lastCall![0] as ClarifyAnswer

test('inline: the rationale and the maturity are in view, the four other notes are in the fold', () => {
  const { container } = render(<Host layout="inline" initial={chosen} />)
  // Nothing wraps the whole block in a fold any more.
  expect(container.querySelector('details.mindmap-decision')).toBeNull()
  const more = fold(container)
  const rationale = screen.getByLabelText('My rationale (optional)') as HTMLInputElement
  expect(rationale.tagName).toBe('INPUT')
  expect(rationale.placeholder).toBe('One sentence on why you chose this')
  expect(more.contains(rationale)).toBe(false)
  expect(more.contains(maturity())).toBe(false)
  expect(marks()).toEqual([
    ['Unmarked', 'true'],
    ['Decided', 'false'],
    ['Provisional', 'false'],
  ])
  expect(more.querySelector('summary')?.textContent).toBe('More notes: cost, unknowns, validation')
  expect(
    Array.from(more.querySelectorAll('.form-field__label'), (label) => label.textContent),
  ).toEqual([
    'Accepted tradeoff',
    'Still unverified',
    'Who will validate',
    'When or under what conditions to revisit',
  ])
  // Rationale first, maturity second, the fold last.
  expect(
    rationale.compareDocumentPosition(maturity()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(maturity().compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('inline: the fold starts open only when it holds something or the decision is provisional', () => {
  const opens = (decision: ClarifyDecision | undefined) => {
    const view = render(
      <Host layout="inline" initial={decision ? withDecision(decision) : chosen} />,
    )
    const open = fold(view.container).open
    view.unmount()
    return open
  }
  expect(opens(undefined)).toBe(false)
  // The two things already in view are no reason to open it.
  expect(opens({ status: 'decided', rationale: 'Measured last quarter' })).toBe(false)
  expect(opens({ status: 'provisional' })).toBe(true)
  const notes: ClarifyDecision[] = [
    { tradeoff: 'Written earlier' },
    { uncertainty: 'Written earlier' },
    { validationOwner: 'Written earlier' },
    { revisitWhen: 'Written earlier' },
  ]
  for (const note of notes) expect(opens(note), Object.keys(note).join()).toBe(true)
})

test('inline: choosing "Provisional" opens the fold, and a reader who closes it is left alone', () => {
  const onChange = vi.fn()
  const { container } = render(<Host layout="inline" initial={chosen} onChange={onChange} />)
  const more = fold(container)
  expect(more.open).toBe(false)
  fireEvent.click(within(maturity()).getByRole('radio', { name: 'Provisional' }))
  expect(last(onChange).decision).toEqual({ status: 'provisional' })
  expect(more.open).toBe(true)
  // The reader folds it away again (the browser reports that as a toggle).
  act(() => {
    more.open = false
  })
  expect(more.open).toBe(false)
  // Further edits do not keep popping it open …
  fireEvent.change(screen.getByLabelText('My rationale (optional)'), {
    target: { value: 'No baseline yet' },
  })
  expect(last(onChange).decision).toEqual({ status: 'provisional', rationale: 'No baseline yet' })
  expect(more.open).toBe(false)
  // … but choosing "Provisional" anew is that moment again.
  fireEvent.click(within(maturity()).getByRole('radio', { name: 'Decided' }))
  expect(more.open).toBe(false)
  fireEvent.click(within(maturity()).getByRole('radio', { name: 'Provisional' }))
  expect(more.open).toBe(true)
  // The notes inside are edited like any other.
  fireEvent.change(within(more).getByLabelText('Who will validate'), { target: { value: 'Lin' } })
  expect(last(onChange).decision).toEqual({
    status: 'provisional',
    rationale: 'No baseline yet',
    validationOwner: 'Lin',
  })
})

test('inline: every edit withdraws the confirmation, and an emptied decision leaves nothing behind', () => {
  const onChange = vi.fn()
  render(
    <Host
      layout="inline"
      initial={{ ...chosen, confirmedBasis: 'v2:previously-confirmed' }}
      onChange={onChange}
    />,
  )
  const rationale = () => screen.getByLabelText('My rationale (optional)') as HTMLInputElement
  fireEvent.change(rationale(), { target: { value: 'Budget first' } })
  expect(last(onChange)).toMatchObject({
    selectedOptionIndices: [0],
    decision: { rationale: 'Budget first' },
  })
  expect(last(onChange).confirmedBasis).toBeUndefined()
  expect(rationale().value).toBe('Budget first')
  fireEvent.click(within(maturity()).getByRole('radio', { name: 'Decided' }))
  expect(last(onChange).decision).toEqual({ status: 'decided', rationale: 'Budget first' })
  expect(marks()).toEqual([
    ['Unmarked', 'false'],
    ['Decided', 'true'],
    ['Provisional', 'false'],
  ])
  // Back to unmarked, then the reason removed: no status, no empty object.
  fireEvent.click(within(maturity()).getByRole('radio', { name: 'Unmarked' }))
  expect(last(onChange).decision).toEqual({ rationale: 'Budget first' })
  fireEvent.change(rationale(), { target: { value: '' } })
  expect(last(onChange).decision).toBeUndefined()
  expect(last(onChange).selectedOptionIndices).toEqual([0])
})

test('inline: a rationale with a line break gets a multi-line field, a single line gets one line', () => {
  const several = render(
    <Host layout="inline" initial={withDecision({ rationale: 'First\nSecond' })} />,
  )
  const area = screen.getByLabelText('My rationale (optional)') as HTMLTextAreaElement
  expect(area.tagName).toBe('TEXTAREA')
  expect(area.value).toBe('First\nSecond')
  expect(fold(several.container).contains(area)).toBe(false)
  // It is still the only rationale field: the fold does not repeat it.
  expect(screen.getAllByLabelText(/rationale/i)).toHaveLength(1)
  several.unmount()
  render(<Host layout="inline" initial={withDecision({ rationale: 'One line' })} />)
  const line = screen.getByLabelText('My rationale (optional)') as HTMLInputElement
  expect(line.tagName).toBe('INPUT')
  expect(line.value).toBe('One line')
})

test('inline, read-only: the notes are read back in place, with nothing to edit or unfold', () => {
  const onChange = vi.fn()
  const { container } = render(
    <DecisionDetails
      layout="inline"
      disabled
      answer={withDecision({
        status: 'provisional',
        rationale: 'A guess for now',
        uncertainty: 'No baseline',
      })}
      onChange={onChange}
    />,
  )
  expect(container.querySelector('.mindmap-decision--inline')).not.toBeNull()
  expect(container.querySelector('input, textarea, details, button')).toBeNull()
  expect(screen.queryByRole('radiogroup')).toBeNull()
  expect(container.querySelector('[data-decision-status="provisional"]')?.textContent).toBe(
    'Provisional',
  )
  expect(
    Array.from(container.querySelectorAll('dl > div'), (row) => [
      row.querySelector('dt')?.textContent,
      row.querySelector('dd')?.textContent,
    ]),
  ).toEqual([
    ['My rationale', 'A guess for now'],
    ['Still unverified', 'No baseline'],
  ])
  // Provisional without an owner or a review time says so.
  expect(screen.getByText(/ownership or review timing is still unspecified/)).toBeTruthy()
  expect(onChange).not.toHaveBeenCalled()
})

test('inline, read-only: an answer without notes reads as unmarked and nothing else', () => {
  const { container } = render(
    <DecisionDetails layout="inline" disabled answer={chosen} onChange={() => {}} />,
  )
  expect(container.querySelector('[data-decision-status="unmarked"]')?.textContent).toBe('Unmarked')
  expect(container.querySelectorAll('dl > div')).toHaveLength(0)
  expect(screen.queryByText(/ownership or review timing/)).toBeNull()
})

test('default layout: a skipped answer is named in the title, shows no maturity set, and never offers the skip statuses', () => {
  for (const [status, note, name] of [
    ['not-applicable', 'Why it does not apply', 'Not applicable'],
    ['deferred', 'What is missing to decide', 'Decide later'],
  ] as const) {
    const view = render(
      <Host
        initial={{
          ...chosen,
          selectedOptionIndices: [],
          decision: { status, rationale: 'Single region only' },
        }}
      />,
    )
    // The whole block is the one fold. Its title says what the answer is (the same word
    // the readback inside uses); only the three-way control below has no value for it.
    const block = view.container.querySelector('details.mindmap-decision')!
    expect(block.querySelector('summary')?.textContent).toBe(
      `Decision context (optional) · ${name}`,
    )
    expect(view.container.querySelector('details.mindmap-decision__more')).toBeNull()
    fireEvent.click(block.querySelector('summary')!)
    expect(marks()).toEqual([
      ['Unmarked', 'true'],
      ['Decided', 'false'],
      ['Provisional', 'false'],
    ])
    // The note the user left is there, under the label of what it explains.
    expect((screen.getByLabelText(note) as HTMLTextAreaElement).value).toBe('Single region only')
    expect(screen.queryByLabelText('My rationale')).toBeNull()
    view.unmount()
  }
})

test('default layout: marking a skipped answer as decided replaces the skip and keeps the note', () => {
  const onChange = vi.fn()
  render(
    <Host
      initial={{
        ...chosen,
        selectedOptionIndices: [],
        decision: { status: 'deferred', rationale: 'Waiting for the load test' },
      }}
      onChange={onChange}
    />,
  )
  fireEvent.click(screen.getByText('Decision context (optional) · Decide later'))
  fireEvent.click(within(maturity()).getByRole('radio', { name: 'Decided' }))
  expect(last(onChange).decision).toEqual({
    status: 'decided',
    rationale: 'Waiting for the load test',
  })
  // It is an ordinary rationale again.
  expect((screen.getByLabelText('My rationale') as HTMLTextAreaElement).value).toBe(
    'Waiting for the load test',
  )
  expect(screen.queryByLabelText('What is missing to decide')).toBeNull()
})

test('default layout: an ordinary answer is unchanged — one fold, all five notes inside', () => {
  const { container } = render(
    <Host initial={withDecision({ status: 'provisional', uncertainty: 'No baseline' })} />,
  )
  const block = container.querySelector('details.mindmap-decision')!
  expect(block.querySelector('summary')?.textContent).toBe(
    'Decision context (optional) · Provisional',
  )
  expect(
    Array.from(block.querySelectorAll('.form-field__label'), (label) => label.textContent),
  ).toEqual([
    'Decision status',
    'My rationale',
    'Accepted tradeoff',
    'Still unverified',
    'Who will validate',
    'When or under what conditions to revisit',
  ])
  expect(screen.queryByLabelText('My rationale (optional)')).toBeNull()
})

test('read-back: the status and the note are labelled by what they are', () => {
  for (const [status, chip, label] of [
    ['not-applicable', 'Not applicable', 'Why it does not apply'],
    ['deferred', 'Decide later', 'What is missing to decide'],
    ['decided', 'Decided', 'My rationale'],
    ['provisional', 'Provisional', 'My rationale'],
    [undefined, 'Unmarked', 'My rationale'],
  ] as const) {
    const view = render(
      <DecisionReadback
        decision={{
          ...(status ? { status } : {}),
          rationale: 'Because',
          tradeoff: 'Slower restore',
        }}
      />,
    )
    const mark = view.container.querySelector('.mindmap-decision__status')!
    expect(mark.textContent, String(status)).toBe(chip)
    expect(mark.getAttribute('data-decision-status')).toBe(status ?? 'unmarked')
    expect(
      Array.from(view.container.querySelectorAll('dt'), (term) => term.textContent),
      String(status),
    ).toEqual([label, 'Accepted tradeoff'])
    // Only a provisional decision is asked for an owner and a review time.
    expect(view.container.querySelector('.mindmap-decision__unknown') !== null).toBe(
      status === 'provisional',
    )
    view.unmount()
  }
})
