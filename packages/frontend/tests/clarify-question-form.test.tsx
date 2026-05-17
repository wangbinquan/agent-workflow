// RFC-023 PR-C T21 — QuestionForm contract.
//
// What this locks:
//   1. single-choice: picking an option sets indices=[i] and labels=[options[i]],
//      AND clears customText (mutex with Other).
//   2. single-choice: picking "Other" clears indices and enables the textarea.
//   3. multi-choice: toggling options never clears customText; toggling the
//      Other checkbox enables / clears the textarea independently.
//   4. Custom textarea is disabled until the user opted in.
//   5. The 'recommended' chip renders only when question.recommended is true.
//   6. Digit hotkey N+1 fires the custom row (single → select; multi → toggle).
//   7. Custom text is hard-capped to CLARIFY_MAX_CUSTOM_TEXT_LEN (2000).
//   8. Hotkeys do NOT fire when the keystroke originated inside an input or
//      textarea.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { ClarifyAnswer, ClarifyQuestion } from '@agent-workflow/shared'
import { CLARIFY_MAX_CUSTOM_TEXT_LEN } from '@agent-workflow/shared'
import { QuestionForm } from '../src/components/clarify/QuestionForm'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const SINGLE_Q: ClarifyQuestion = {
  id: 'q-db',
  title: 'Pick a database',
  kind: 'single',
  recommended: true,
  options: ['Postgres', 'MySQL'],
}

const MULTI_Q: ClarifyQuestion = {
  id: 'q-langs',
  title: 'Pick languages',
  kind: 'multi',
  recommended: false,
  options: ['TS', 'Python', 'Go'],
}

function emptyAnswer(qid: string): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [], selectedOptionLabels: [], customText: '' }
}

function Host({
  question,
  initial,
  onChangeSpy,
}: {
  question: ClarifyQuestion
  initial: ClarifyAnswer
  onChangeSpy: (a: ClarifyAnswer) => void
}) {
  const [a, setA] = useState<ClarifyAnswer>(initial)
  return (
    <QuestionForm
      question={question}
      value={a}
      index={1}
      onChange={(next) => {
        setA(next)
        onChangeSpy(next)
      }}
    />
  )
}

describe('QuestionForm — single-choice', () => {
  test('selecting an option sets indices/labels and clears customText', () => {
    const spy = vi.fn()
    render(
      <Host
        question={SINGLE_Q}
        initial={{ ...emptyAnswer('q-db'), customText: 'lingering' }}
        onChangeSpy={spy}
      />,
    )
    const radios = document.querySelectorAll('input[type=radio][data-option-idx]')
    fireEvent.click(radios[1]!) // MySQL
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as ClarifyAnswer
    expect(last.selectedOptionIndices).toEqual([1])
    expect(last.selectedOptionLabels).toEqual(['MySQL'])
    expect(last.customText).toBe('')
  })

  test('picking "Other" clears indices and enables the textarea', () => {
    const spy = vi.fn()
    render(<Host question={SINGLE_Q} initial={emptyAnswer('q-db')} onChangeSpy={spy} />)
    fireEvent.click(screen.getByTestId('clarify-custom-radio'))
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as ClarifyAnswer
    expect(last.selectedOptionIndices).toEqual([])
    // Textarea should now be enabled.
    const textarea = screen.getByTestId('clarify-custom-textarea') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
  })

  test('renders the Recommended chip when question.recommended is true', () => {
    render(<Host question={SINGLE_Q} initial={emptyAnswer('q-db')} onChangeSpy={() => {}} />)
    expect(screen.getByTestId('clarify-recommended-chip')).toBeTruthy()
  })
})

describe('QuestionForm — multi-choice', () => {
  test('toggling options keeps customText intact (no mutex with Other)', () => {
    const spy = vi.fn()
    render(
      <Host
        question={MULTI_Q}
        initial={{ ...emptyAnswer('q-langs'), customText: 'with concurrency' }}
        onChangeSpy={spy}
      />,
    )
    const checkboxes = document.querySelectorAll('input[type=checkbox][data-option-idx]')
    fireEvent.click(checkboxes[0]!) // TS
    fireEvent.click(checkboxes[2]!) // Go
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as ClarifyAnswer
    expect(last.selectedOptionIndices).toEqual([0, 2])
    expect(last.selectedOptionLabels).toEqual(['TS', 'Go'])
    expect(last.customText).toBe('with concurrency')
  })

  test('toggling the "Other" checkbox enables / clears the textarea independently', () => {
    const spy = vi.fn()
    render(
      <Host
        question={MULTI_Q}
        initial={{ ...emptyAnswer('q-langs'), customText: 'note' }}
        onChangeSpy={spy}
      />,
    )
    // The custom checkbox starts checked because customText is non-empty.
    const cb = screen.getByTestId('clarify-custom-checkbox') as HTMLInputElement
    expect(cb.checked).toBe(true)
    // Unticking clears the text.
    fireEvent.click(cb)
    const cleared = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as ClarifyAnswer
    expect(cleared.customText).toBe('')
  })

  test('hard-caps customText input to CLARIFY_MAX_CUSTOM_TEXT_LEN', () => {
    const spy = vi.fn()
    render(
      <Host
        question={MULTI_Q}
        initial={{ ...emptyAnswer('q-langs'), customText: 'seed' }}
        onChangeSpy={spy}
      />,
    )
    const textarea = screen.getByTestId('clarify-custom-textarea') as HTMLTextAreaElement
    const overlong = 'x'.repeat(CLARIFY_MAX_CUSTOM_TEXT_LEN + 250)
    fireEvent.change(textarea, { target: { value: overlong } })
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as ClarifyAnswer
    expect(last.customText.length).toBe(CLARIFY_MAX_CUSTOM_TEXT_LEN)
  })
})

describe('QuestionForm — keyboard hotkeys', () => {
  test('digit 1..N picks / toggles the matching option', () => {
    const spy = vi.fn()
    render(<Host question={SINGLE_Q} initial={emptyAnswer('q-db')} onChangeSpy={spy} />)
    const root = document.querySelector('.clarify-question') as HTMLElement
    root.focus()
    fireEvent.keyDown(root, { key: '2' })
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as ClarifyAnswer
    expect(last.selectedOptionIndices).toEqual([1])
  })

  test('digit N+1 picks the custom row (single)', () => {
    const spy = vi.fn()
    render(<Host question={SINGLE_Q} initial={emptyAnswer('q-db')} onChangeSpy={spy} />)
    const root = document.querySelector('.clarify-question') as HTMLElement
    root.focus()
    // SINGLE_Q has 2 options; N+1 = 3.
    fireEvent.keyDown(root, { key: '3' })
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as ClarifyAnswer
    expect(last.selectedOptionIndices).toEqual([])
  })

  test('hotkeys do not fire when the keydown originated inside an input/textarea', () => {
    const spy = vi.fn()
    render(<Host question={SINGLE_Q} initial={emptyAnswer('q-db')} onChangeSpy={spy} />)
    const textarea = screen.getByTestId('clarify-custom-textarea') as HTMLTextAreaElement
    // Even though textarea is disabled, fireEvent dispatches at it. The
    // handler must early-out because the event's target is a textarea.
    fireEvent.keyDown(textarea, { key: '1' })
    expect(spy.mock.calls.length).toBe(0)
  })
})
