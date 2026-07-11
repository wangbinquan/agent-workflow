// LOCKS: RFC-165 UI 精修 — the ChoiceCards primitive's contract (the wizard's
// card-style kind/space pickers migrated here from Segmented, keeping the
// same radiogroup semantics + `${prefix}-${value}` testids).
//
//   C1 renders radio cards with aria-checked on the active one; clicking a
//      card selects it; clicking the active card is a no-op.
//   C2 label + description + icon render inside the card.
//   C3 group-level `disabled` disables every card.
//   C4 arrow keys move the selection between enabled cards.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ChoiceCards } from '../src/components/ChoiceCards'

afterEach(cleanup)

const OPTIONS = [
  { value: 'a', label: 'Alpha', description: 'first choice', icon: <svg data-testid="icon-a" /> },
  { value: 'b', label: 'Beta', description: 'second choice' },
  { value: 'c', label: 'Gamma', disabled: true },
] as const

describe('ChoiceCards (RFC-165 UI 精修)', () => {
  test('C1 radio semantics: aria-checked, select on click, active click is a no-op', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <ChoiceCards value="a" options={OPTIONS} onChange={onChange} testidPrefix="cc" />,
    )
    expect(getByTestId('cc-a').getAttribute('aria-checked')).toBe('true')
    expect(getByTestId('cc-b').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(getByTestId('cc-b'))
    expect(onChange).toHaveBeenCalledWith('b')
    fireEvent.click(getByTestId('cc-a'))
    expect(onChange).toHaveBeenCalledTimes(1) // active card click ignored
  })

  test('C2 label + description + icon render', () => {
    const { getByTestId, getByText } = render(
      <ChoiceCards value="a" options={OPTIONS} onChange={() => {}} testidPrefix="cc" />,
    )
    expect(getByText('Alpha')).toBeTruthy()
    expect(getByText('first choice')).toBeTruthy()
    expect(getByTestId('icon-a')).toBeTruthy()
  })

  test('C3 group disabled + per-option disabled', () => {
    const { getByTestId, rerender } = render(
      <ChoiceCards value="a" options={OPTIONS} onChange={() => {}} testidPrefix="cc" disabled />,
    )
    for (const v of ['a', 'b', 'c']) {
      expect((getByTestId(`cc-${v}`) as HTMLButtonElement).disabled).toBe(true)
    }
    rerender(<ChoiceCards value="a" options={OPTIONS} onChange={() => {}} testidPrefix="cc" />)
    expect((getByTestId('cc-b') as HTMLButtonElement).disabled).toBe(false)
    expect((getByTestId('cc-c') as HTMLButtonElement).disabled).toBe(true)
  })

  test('C5 tab stop falls back to the first ENABLED card when the checked one is disabled (Codex P2)', () => {
    const opts = [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta', disabled: true },
    ] as const
    const { getByTestId } = render(
      <ChoiceCards value="b" options={opts} onChange={() => {}} testidPrefix="cc" />,
    )
    // 'b' is checked but disabled — Tab must land on 'a', not a skipped button.
    expect(getByTestId('cc-a').getAttribute('tabindex')).toBe('0')
    expect(getByTestId('cc-b').getAttribute('tabindex')).toBe('-1')
  })

  test('C4 arrow keys move between ENABLED cards (disabled skipped, wraps)', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <ChoiceCards value="b" options={OPTIONS} onChange={onChange} testidPrefix="cc" />,
    )
    // b → ArrowRight skips disabled c, wraps to a.
    fireEvent.keyDown(getByTestId('cc-b'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('a')
    // b → ArrowLeft goes back to a as well (only a/b enabled).
    onChange.mockClear()
    fireEvent.keyDown(getByTestId('cc-b'), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenCalledWith('a')
  })
})
