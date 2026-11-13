// RFC-490 (design §4.4, proposal C8 and P4): QuestionForm gained two opt-in props for
// the mindmap. `hideInactiveCustom` leaves the free-text box out until the custom row
// is picked (single) or ticked (multi); `intentResetToken` drops a pending "Other" pick
// that has nothing typed yet when its value changes, so a question that was just
// skipped does not keep showing "Other" as chosen. Both are off unless passed: the
// ordinary questionnaire and the centralized answer dialog pass neither, and the first
// block holds that their form is what it was (its full contract stays in
// clarify-question-form.test.tsx).
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { ClarifyAnswer, ClarifyQuestion } from '@agent-workflow/shared'
import { QuestionForm } from '../src/components/clarify/QuestionForm'

const option = (label: string) => ({
  label,
  description: '',
  recommended: false,
  recommendationReason: '',
})
const SINGLE: ClarifyQuestion = {
  id: 'q-db',
  title: 'Pick a database',
  kind: 'single',
  recommended: false,
  options: [option('Postgres'), option('MySQL')],
}
const MULTI: ClarifyQuestion = {
  id: 'q-langs',
  title: 'Pick languages',
  kind: 'multi',
  recommended: false,
  options: [option('TS'), option('Python'), option('Go')],
}
const empty = (questionId: string): ClarifyAnswer => ({
  questionId,
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText: '',
})

interface HostProps {
  question: ClarifyQuestion
  initial?: ClarifyAnswer
  hide?: boolean
  token?: string
  disabled?: boolean
  onChange?: (next: ClarifyAnswer) => void
  onAdvance?: () => void
}
/** Holds the answer like the route does; the new props are passed only when given. */
function Host(props: HostProps) {
  const [value, setValue] = useState(props.initial ?? empty(props.question.id))
  return (
    <QuestionForm
      question={props.question}
      value={value}
      index={1}
      disabled={props.disabled}
      onChange={(next) => {
        props.onChange?.(next)
        setValue(next)
      }}
      onAdvance={props.onAdvance}
      {...(props.hide === undefined ? {} : { hideInactiveCustom: props.hide })}
      {...(props.token === undefined ? {} : { intentResetToken: props.token })}
    />
  )
}
const box = () => screen.queryByTestId('clarify-custom-textarea') as HTMLTextAreaElement | null
const holder = () => document.querySelector('.clarify-question__custom')
const other = () => screen.getByTestId('clarify-custom-radio') as HTMLInputElement
const also = () => screen.getByTestId('clarify-custom-checkbox') as HTMLInputElement
const listed = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[data-option-idx]'))
const form = () => document.querySelector<HTMLElement>('.clarify-question')!
const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.lastCall![0] as ClarifyAnswer
const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

describe('QuestionForm without the RFC-490 props (ordinary questionnaire)', () => {
  test('single: the free-text box is in view but disabled, and Enter or a digit pick still advance', () => {
    const onChange = vi.fn()
    const onAdvance = vi.fn()
    render(<Host question={SINGLE} onChange={onChange} onAdvance={onAdvance} />)
    expect(box()).not.toBeNull()
    expect(box()!.disabled).toBe(true)
    expect(holder()!.classList.contains('is-active')).toBe(false)
    expect(other().checked).toBe(false)
    fireEvent.keyDown(form(), { key: 'Enter' })
    expect(onAdvance).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(form(), { key: '2' })
    expect(last(onChange).selectedOptionIndices).toEqual([1])
    expect(onAdvance).toHaveBeenCalledTimes(2)
    // Still there, still disabled, once a listed option is chosen.
    expect(box()!.disabled).toBe(true)
    // Picking "Other" enables the same box in place.
    fireEvent.click(other())
    expect(box()!.disabled).toBe(false)
    expect(holder()!.classList.contains('is-active')).toBe(true)
  })

  test('multi: the free-text box is in view but disabled until its checkbox is ticked', () => {
    const onAdvance = vi.fn()
    render(<Host question={MULTI} onAdvance={onAdvance} />)
    expect(box()!.disabled).toBe(true)
    fireEvent.click(also())
    expect(box()!.disabled).toBe(false)
    fireEvent.click(also())
    expect(box()).not.toBeNull()
    expect(box()!.disabled).toBe(true)
    // A digit toggles and stays; Enter is the explicit "next".
    fireEvent.keyDown(form(), { key: '1' })
    expect(onAdvance).not.toHaveBeenCalled()
    fireEvent.keyDown(form(), { key: 'Enter' })
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })
})

describe('hideInactiveCustom (mindmap)', () => {
  test('single: no free-text box until "Other" is picked, and none again once an option is', () => {
    const onChange = vi.fn()
    render(<Host question={SINGLE} hide onChange={onChange} />)
    expect(box()).toBeNull()
    // Not a hidden or disabled box: its whole block is left out.
    expect(holder()).toBeNull()
    // The "Other" row itself is always offered.
    expect(other().checked).toBe(false)
    fireEvent.click(other())
    expect(other().checked).toBe(true)
    expect(box()).not.toBeNull()
    expect(box()!.disabled).toBe(false)
    expect(holder()!.classList.contains('is-active')).toBe(true)
    fireEvent.change(box()!, { target: { value: 'Partition by month' } })
    expect(last(onChange)).toMatchObject({
      selectedOptionIndices: [],
      customText: 'Partition by month',
    })
    expect(box()!.value).toBe('Partition by month')
    // A listed option replaces the custom answer and the box goes with it.
    fireEvent.click(listed()[0]!)
    expect(last(onChange)).toMatchObject({ selectedOptionIndices: [0], customText: '' })
    expect(box()).toBeNull()
    expect(holder()).toBeNull()
    expect(other().checked).toBe(false)
  })

  test('single: an answer that already is free text shows its box from the start', () => {
    render(
      <Host
        question={SINGLE}
        hide
        initial={{ ...empty('q-db'), customText: 'Something else entirely' }}
      />,
    )
    expect(other().checked).toBe(true)
    expect(box()!.value).toBe('Something else entirely')
    expect(box()!.disabled).toBe(false)
  })

  test('single: the digit for "Other" brings the box in and puts the cursor in it', async () => {
    const onAdvance = vi.fn()
    render(<Host question={SINGLE} hide onAdvance={onAdvance} />)
    form().focus()
    // Two options, so "Other" is 3.
    fireEvent.keyDown(form(), { key: '3' })
    expect(box()).not.toBeNull()
    expect(onAdvance).not.toHaveBeenCalled()
    await frames()
    expect(document.activeElement).toBe(box())
  })

  test('multi: no free-text box until its checkbox is ticked, whatever else is ticked', () => {
    const onChange = vi.fn()
    render(<Host question={MULTI} hide onChange={onChange} />)
    expect(box()).toBeNull()
    expect(holder()).toBeNull()
    fireEvent.click(listed()[0]!)
    fireEvent.click(listed()[2]!)
    expect(last(onChange).selectedOptionIndices).toEqual([0, 2])
    expect(box()).toBeNull()
    fireEvent.click(also())
    expect(also().checked).toBe(true)
    expect(box()!.disabled).toBe(false)
    fireEvent.change(box()!, { target: { value: 'and some Rust' } })
    expect(last(onChange)).toMatchObject({
      selectedOptionIndices: [0, 2],
      customText: 'and some Rust',
    })
    // Unticking takes the note and its box away; the ticked options stay.
    fireEvent.click(also())
    expect(last(onChange)).toMatchObject({ selectedOptionIndices: [0, 2], customText: '' })
    expect(box()).toBeNull()
    expect(also().checked).toBe(false)
  })

  test('multi: an answer that already has a note shows its box from the start', () => {
    render(<Host question={MULTI} hide initial={{ ...empty('q-langs'), customText: 'plus SQL' }} />)
    expect(also().checked).toBe(true)
    expect(box()!.value).toBe('plus SQL')
  })

  test('read-only: a free-text answer is still shown, an absent one leaves no empty box', () => {
    const written = render(
      <Host
        question={SINGLE}
        hide
        disabled
        initial={{ ...empty('q-db'), customText: 'Decided offline' }}
      />,
    )
    expect(box()!.value).toBe('Decided offline')
    expect(box()!.disabled).toBe(true)
    written.unmount()
    render(
      <Host
        question={SINGLE}
        hide
        disabled
        initial={{ ...empty('q-db'), selectedOptionIndices: [1] }}
      />,
    )
    expect(box()).toBeNull()
  })

  test('passing false is the same as not passing it', () => {
    render(<Host question={SINGLE} hide={false} />)
    expect(box()).not.toBeNull()
    expect(box()!.disabled).toBe(true)
  })
})

describe('intentResetToken (mindmap: the answer was skipped)', () => {
  test('single: a pending "Other" with nothing typed is dropped when the token changes', () => {
    const view = render(<Host question={SINGLE} hide token="" />)
    fireEvent.click(other())
    expect(other().checked).toBe(true)
    expect(box()).not.toBeNull()
    // The same token again is not a change.
    view.rerender(<Host question={SINGLE} hide token="" />)
    expect(other().checked).toBe(true)
    expect(box()).not.toBeNull()
    // Skipped: "Other" is no longer shown as chosen, and its box is gone.
    view.rerender(<Host question={SINGLE} hide token="not-applicable" />)
    expect(other().checked).toBe(false)
    expect(box()).toBeNull()
    // Answering again starts clean and "Other" can be picked anew.
    view.rerender(<Host question={SINGLE} hide token="" />)
    expect(other().checked).toBe(false)
    fireEvent.click(other())
    expect(other().checked).toBe(true)
    expect(box()!.disabled).toBe(false)
  })

  test('single: typed text is an answer, not a pending pick, and is not dropped', () => {
    const view = render(<Host question={SINGLE} hide token="" />)
    fireEvent.click(other())
    fireEvent.change(box()!, { target: { value: 'Partition by month' } })
    view.rerender(<Host question={SINGLE} hide token="deferred" />)
    expect(other().checked).toBe(true)
    expect(box()!.value).toBe('Partition by month')
  })

  test('multi: a ticked but empty note is dropped, a written one is kept', () => {
    const view = render(<Host question={MULTI} hide token="" />)
    fireEvent.click(also())
    expect(box()).not.toBeNull()
    view.rerender(<Host question={MULTI} hide token="deferred" />)
    expect(also().checked).toBe(false)
    expect(box()).toBeNull()
    fireEvent.click(also())
    fireEvent.change(box()!, { target: { value: 'plus SQL' } })
    view.rerender(<Host question={MULTI} hide token="" />)
    expect(also().checked).toBe(true)
    expect(box()!.value).toBe('plus SQL')
  })

  test('the token given at mount is the baseline: nothing is dropped by it', () => {
    render(
      <Host
        question={MULTI}
        hide
        token="deferred"
        initial={{ ...empty('q-langs'), customText: 'kept' }}
      />,
    )
    expect(also().checked).toBe(true)
    expect(box()!.value).toBe('kept')
  })

  test('it does not depend on the box being hidden: the in-view box goes back to disabled', () => {
    const view = render(<Host question={SINGLE} token="" />)
    fireEvent.click(other())
    expect(box()!.disabled).toBe(false)
    view.rerender(<Host question={SINGLE} token="not-applicable" />)
    expect(other().checked).toBe(false)
    expect(box()).not.toBeNull()
    expect(box()!.disabled).toBe(true)
    expect(holder()!.classList.contains('is-active')).toBe(false)
  })
})
