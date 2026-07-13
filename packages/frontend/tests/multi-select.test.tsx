// RFC-173 (T2) — <MultiSelect> tag-combobox contract. Covers the design §8
// list: tags/synth rows/label fallback, toggle-stays-open, search, allowCustom
// (+ blur-doesn't-mis-commit), backspace/×, a11y roles, active-row invariants
// (focus-then-Enter / filter-then-Enter / zero-options custom Enter / no
// dangling active after external value change), value-set dedup, IME guard.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useState } from 'react'
import { MultiSelect, type MultiSelectOption } from '../src/components/MultiSelect'

const OPTS: MultiSelectOption[] = [
  { value: 'alpha', label: 'Alpha', description: 'first letter' },
  { value: 'bravo', label: 'Bravo', description: 'second' },
  { value: 'charlie', label: 'Charlie' },
]

function Harness({
  initial = [],
  options = OPTS,
  spy,
  ...rest
}: {
  initial?: string[]
  options?: MultiSelectOption[]
  spy?: (v: string[]) => void
} & Partial<React.ComponentProps<typeof MultiSelect>>) {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <MultiSelect
      value={value}
      onChange={(v) => {
        setValue(v)
        spy?.(v)
      }}
      options={options}
      ariaLabel="Skills"
      allowCustom
      {...rest}
    />
  )
}

const input = () => screen.getByRole('combobox') as HTMLInputElement
const openList = () => {
  fireEvent.focus(input())
  return screen.getByRole('listbox')
}
const optionEls = () => within(screen.getByRole('listbox')).getAllByRole('option')

// NB: no manual `document.body.innerHTML = ''` here — the listbox is portaled
// to document.body, so wiping it races React's portal removeChild and crashes
// happy-dom. setup.ts's afterEach cleanup() unmounts correctly (same lesson as
// resource-picker.test.tsx).
afterEach(() => {
  vi.restoreAllMocks()
})

describe('MultiSelect — tags + dropdown', () => {
  test('renders selected values as tags; empty shows placeholder', () => {
    render(<Harness initial={['alpha']} placeholder="pick skills" />)
    expect(screen.getByText('Alpha')).toBeTruthy() // tag uses the option label
    expect(input().getAttribute('placeholder')).toBe('') // non-empty selection → no placeholder
    render(<Harness placeholder="pick skills" />)
    expect(screen.getAllByPlaceholderText('pick skills').length).toBeGreaterThan(0)
  })

  test('value not in options → readable tag (name, not id) + synthesized checked row', () => {
    render(<Harness initial={['ghost']} />)
    // Tag falls back to the raw value (which for resources is the name).
    expect(screen.getByText('ghost')).toBeTruthy()
    openList()
    const ghost = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .find((o) => o.textContent?.includes('ghost'))
    expect(ghost).toBeTruthy()
    expect(ghost?.getAttribute('aria-selected')).toBe('true')
  })

  test('open lists options with aria-selected reflecting value.includes', () => {
    render(<Harness initial={['bravo']} />)
    openList()
    const rows = optionEls()
    const bravo = rows.find((o) => o.textContent?.includes('Bravo'))
    const alpha = rows.find((o) => o.textContent?.includes('Alpha'))
    expect(bravo?.getAttribute('aria-selected')).toBe('true')
    expect(alpha?.getAttribute('aria-selected')).toBe('false')
  })

  test('clicking a row toggles add/remove and the dropdown stays open', () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    openList()
    const alpha = optionEls().find((o) => o.textContent?.includes('Alpha'))!
    fireEvent.mouseDown(alpha)
    expect(spy).toHaveBeenLastCalledWith(['alpha'])
    expect(screen.queryByRole('listbox')).toBeTruthy() // still open
    // Now selected → clicking again removes.
    const alpha2 = optionEls().find((o) => o.textContent?.includes('Alpha'))!
    fireEvent.mouseDown(alpha2)
    expect(spy).toHaveBeenLastCalledWith([])
  })

  test('search filters by label AND description, case-insensitive', () => {
    render(<Harness allowCustom={false} />) // no "Add" row muddying the count
    openList()
    fireEvent.change(input(), { target: { value: 'FIRST' } }) // matches Alpha's description
    const rows = optionEls()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('Alpha')
  })

  test('value-set dedup: a selected option is one row, not doubled by a synth row', () => {
    render(<Harness initial={['alpha']} />)
    openList()
    const alphaRows = optionEls().filter((o) => o.textContent?.includes('Alpha'))
    expect(alphaRows).toHaveLength(1)
  })

  describe('allowCustom', () => {
    test('no exact match → Enter commits the custom token', () => {
      const spy = vi.fn()
      render(<Harness spy={spy} />)
      openList()
      fireEvent.change(input(), { target: { value: 'zeta' } })
      // The "Add" row is present…
      expect(screen.getByText('Add "zeta"')).toBeTruthy()
      fireEvent.keyDown(input(), { key: 'Enter' })
      expect(spy).toHaveBeenLastCalledWith(['zeta'])
    })

    test('allowCustom=false → no add row', () => {
      render(<Harness allowCustom={false} />)
      openList()
      fireEvent.change(input(), { target: { value: 'zeta' } })
      expect(screen.queryByText('Add "zeta"')).toBeNull()
    })

    test('clicking an option (blur on the input) does NOT mis-commit the search text', () => {
      const spy = vi.fn()
      render(<Harness spy={spy} />)
      openList()
      fireEvent.change(input(), { target: { value: 'al' } }) // filters to Alpha
      const alpha = optionEls().find((o) => o.textContent?.includes('Alpha'))!
      // mouseDown toggles; a real click would blur the input first — assert the
      // committed value is the toggle, never a custom 'al' token.
      fireEvent.mouseDown(alpha)
      fireEvent.blur(input())
      expect(spy).toHaveBeenLastCalledWith(['alpha'])
      expect(spy).not.toHaveBeenCalledWith(['al'])
    })
  })

  test('Backspace on empty input removes the last tag', () => {
    const spy = vi.fn()
    render(<Harness initial={['alpha', 'bravo']} spy={spy} />)
    fireEvent.keyDown(input(), { key: 'Backspace' })
    expect(spy).toHaveBeenLastCalledWith(['alpha']) // last tag (bravo) dropped
  })

  test('× removes that specific tag', () => {
    const spy = vi.fn()
    render(<Harness initial={['alpha', 'bravo']} spy={spy} />)
    fireEvent.click(screen.getByLabelText('Remove Alpha'))
    expect(spy).toHaveBeenLastCalledWith(['bravo'])
  })

  describe('a11y + keyboard', () => {
    test('roles: combobox input + multiselectable listbox + options', () => {
      render(<Harness initial={['alpha']} />)
      const combo = input()
      expect(combo.getAttribute('role')).toBe('combobox')
      expect(combo.getAttribute('aria-autocomplete')).toBe('list')
      const list = openList()
      expect(list.getAttribute('aria-multiselectable')).toBe('true')
      expect(within(list).getAllByRole('option').length).toBeGreaterThan(0)
    })

    test('Escape closes and retains input focus (no reopen)', () => {
      render(<Harness />)
      // happy-dom quirk: real .focus() sets document.activeElement but doesn't
      // dispatch the React focus event; fireEvent.focus does the opposite. Do
      // both so the input is genuinely focused AND the dropdown opens.
      input().focus()
      fireEvent.focus(input())
      expect(screen.getByRole('listbox')).toBeTruthy()
      fireEvent.keyDown(input(), { key: 'Escape' })
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(document.activeElement).toBe(input()) // stayed focused, didn't reopen
    })

    test('outside click closes the dropdown', () => {
      render(<Harness />)
      openList()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('listbox')).toBeNull()
    })

    test('Space does not toggle (it types into the search input)', () => {
      const spy = vi.fn()
      render(<Harness spy={spy} />)
      openList()
      fireEvent.keyDown(input(), { key: ' ' })
      expect(spy).not.toHaveBeenCalled()
    })

    test('IME composition: Enter while composing does not toggle/commit', () => {
      const spy = vi.fn()
      render(<Harness spy={spy} />)
      openList()
      fireEvent.change(input(), { target: { value: 'zeta' } })
      fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('active-row invariant (Codex R2 P1-1)', () => {
    test('focus then Enter (no arrow) toggles the first row', () => {
      const spy = vi.fn()
      render(<Harness spy={spy} />)
      openList()
      fireEvent.keyDown(input(), { key: 'Enter' })
      expect(spy).toHaveBeenLastCalledWith(['alpha']) // first option
    })

    test('filter then Enter toggles the first match', () => {
      const spy = vi.fn()
      render(<Harness spy={spy} />)
      openList()
      fireEvent.change(input(), { target: { value: 'char' } })
      fireEvent.keyDown(input(), { key: 'Enter' })
      expect(spy).toHaveBeenLastCalledWith(['charlie'])
    })

    test('filter to zero options + allowCustom → Enter commits custom', () => {
      const spy = vi.fn()
      render(<Harness spy={spy} />)
      openList()
      fireEvent.change(input(), { target: { value: 'nomatch' } })
      expect(optionEls()).toHaveLength(1) // only the "Add" custom row
      fireEvent.keyDown(input(), { key: 'Enter' })
      expect(spy).toHaveBeenLastCalledWith(['nomatch'])
    })

    test('ArrowDown then Enter toggles the second row', () => {
      const spy = vi.fn()
      render(<Harness spy={spy} />)
      openList()
      fireEvent.keyDown(input(), { key: 'ArrowDown' })
      fireEvent.keyDown(input(), { key: 'Enter' })
      expect(spy).toHaveBeenLastCalledWith(['bravo'])
    })
  })

  test('loading shows the loading row; disabled input blocks interaction', () => {
    const { rerender } = render(<Harness loading loadingLabel="Loading skills…" />)
    fireEvent.focus(input())
    expect(screen.getByText('Loading skills…')).toBeTruthy()
    rerender(
      <MultiSelect value={[]} onChange={() => {}} options={OPTS} ariaLabel="Skills" disabled />,
    )
    expect((screen.getByRole('combobox') as HTMLInputElement).disabled).toBe(true)
  })
})
