// LOCKS: RFC-165 UI 精修 — Select's opt-in `searchable` mode (the wizard's
// object pickers filter long agent/workflow/workgroup lists).
//
//   S1 non-searchable selects render NO filter input (back-compat).
//   S2 searchable: typing narrows to case-insensitive label/value matches;
//      zero matches show the empty row; Enter picks the first visible match.
//   S3 the filter resets on every open.
//   RFC-250 T25 follow-up: empty source, search miss, and all-disabled results
//      are three distinct non-option presentation states.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Select } from '../src/components/Select'
import '../src/i18n'

afterEach(cleanup)

const OPTIONS = [
  { value: 'auditor', label: 'auditor' },
  { value: 'builder', label: 'builder' },
  { value: 'reviewer', label: 'Code Reviewer' },
] as const

describe('Select searchable (RFC-165 UI 精修)', () => {
  test('S1 plain mode has no filter input', () => {
    const { getByTestId } = render(
      <Select value="auditor" options={OPTIONS} onChange={() => {}} data-testid="sel" />,
    )
    fireEvent.click(getByTestId('sel'))
    expect(screen.queryByTestId('sel-search')).toBeNull()
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  test('S2 typing filters (case-insensitive, label or value); Enter picks first match', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <Select value="auditor" options={OPTIONS} onChange={onChange} searchable data-testid="sel" />,
    )
    fireEvent.click(getByTestId('sel'))
    const input = screen.getByTestId('sel-search')
    fireEvent.change(input, { target: { value: 'code' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Code Reviewer/ })).toBeTruthy()
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    const noMatches = screen.getByText(/无匹配项|No matches/)
    expect(noMatches.getAttribute('role')).toBe('presentation')
    expect(screen.getByRole('listbox').getAttribute('aria-activedescendant')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: ' ' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'build' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('builder')
  })

  test('an empty source reports no available options, not a search miss', () => {
    const onChange = vi.fn()
    render(
      <Select<string> value="" options={[]} onChange={onChange} searchable data-testid="sel" />,
    )
    fireEvent.click(screen.getByTestId('sel'))

    const emptySource = screen.getByText(/No available options|当前没有可用选项/)
    expect(emptySource.getAttribute('role')).toBe('presentation')
    expect(screen.queryByText(/No matches|无匹配项/)).toBeNull()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    const search = screen.getByTestId('sel-search')
    expect(search.getAttribute('aria-activedescendant')).toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.keyDown(search, { key: ' ' })
    expect(onChange).not.toHaveBeenCalled()
  })

  test('S4 arrows from the search input move ONE row; Enter fires once (Codex P1)', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <Select value="auditor" options={OPTIONS} onChange={onChange} searchable data-testid="sel" />,
    )
    fireEvent.click(getByTestId('sel'))
    const input = screen.getByTestId('sel-search')
    // auditor(0) → one ArrowDown lands on builder(1), not reviewer(2).
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('builder')
  })

  test('S5 keys during IME composition are ignored (Codex P1)', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <Select value="auditor" options={OPTIONS} onChange={onChange} searchable data-testid="sel" />,
    )
    fireEvent.click(getByTestId('sel'))
    const input = screen.getByTestId('sel-search')
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(onChange).not.toHaveBeenCalled()
  })

  test('S6 reopening after a filtered session re-aligns the active row to the selection (Codex P2)', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <Select
        value="reviewer"
        options={OPTIONS}
        onChange={onChange}
        searchable
        data-testid="sel"
      />,
    )
    fireEvent.click(getByTestId('sel'))
    // Filter down to one row (index 0 in the FILTERED array), then close.
    fireEvent.change(screen.getByTestId('sel-search'), { target: { value: 'audit' } })
    fireEvent.keyDown(screen.getByTestId('sel-search'), { key: 'Escape' })
    // Reopen over the full list: Enter must adopt the CURRENT selection
    // (reviewer, index 2), not whatever index 0 now points at.
    fireEvent.click(getByTestId('sel'))
    fireEvent.keyDown(screen.getByTestId('sel-search'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('reviewer')
  })

  test('S3 filter resets on reopen', () => {
    const { getByTestId } = render(
      <Select value="auditor" options={OPTIONS} onChange={() => {}} searchable data-testid="sel" />,
    )
    fireEvent.click(getByTestId('sel'))
    fireEvent.change(screen.getByTestId('sel-search'), { target: { value: 'code' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.click(getByTestId('sel')) // close
    fireEvent.click(getByTestId('sel')) // reopen
    expect((screen.getByTestId('sel-search') as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })
})

describe('RFC-250 Select disabled-option keyboard contract', () => {
  const mixed = [
    { value: 'alpha', label: 'Alpha' },
    { value: 'blocked', label: 'Blocked', disabled: true },
    { value: 'charlie', label: 'Charlie' },
    { value: 'disabled-last', label: 'Disabled last', disabled: true },
  ] as const

  const activeText = () => {
    const list = screen.getByRole('listbox')
    const id = list.getAttribute('aria-activedescendant')
    return id === null ? null : document.getElementById(id)?.textContent
  }

  test('Arrow/Home/End skip disabled rows', () => {
    const onChange = vi.fn()
    render(<Select value="alpha" options={mixed} onChange={onChange} data-testid="sel" />)
    fireEvent.click(screen.getByTestId('sel'))
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(activeText()).toContain('Charlie')
    fireEvent.keyDown(list, { key: 'End' })
    expect(activeText()).toContain('Charlie')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(activeText()).toContain('Alpha')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('charlie')
  })

  test('plain-list typeahead ignores a matching disabled row', () => {
    const onChange = vi.fn()
    const options = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'charlie-old', label: 'Charlie legacy', disabled: true },
      { value: 'charlie-new', label: 'Charlie current' },
    ] as const
    render(<Select value="alpha" options={options} onChange={onChange} data-testid="sel" />)
    fireEvent.click(screen.getByTestId('sel'))
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'c' })
    expect(activeText()).toContain('Charlie current')
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('charlie-new')
  })

  test('all-disabled filtered results expose no active descendant and cannot select', () => {
    const onChange = vi.fn()
    const options = [
      { value: 'blocked-a', label: 'Blocked A', disabled: true },
      { value: 'ready', label: 'Ready' },
      { value: 'blocked-b', label: 'Blocked B', disabled: true },
    ] as const
    render(
      <Select value="ready" options={options} onChange={onChange} searchable data-testid="sel" />,
    )
    fireEvent.click(screen.getByTestId('sel'))
    const search = screen.getByTestId('sel-search')
    fireEvent.change(search, { target: { value: 'blocked' } })
    const list = screen.getByRole('listbox')
    expect(list.getAttribute('aria-activedescendant')).toBeNull()
    expect(search.getAttribute('aria-activedescendant')).toBeNull()
    const unavailable = screen.getByText(/All current options are unavailable|当前选项均不可用/)
    expect(unavailable.getAttribute('role')).toBe('presentation')
    expect(screen.queryByText(/No available options|当前没有可用选项/)).toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.keyDown(search, { key: ' ' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('RFC-250 Select active option identity', () => {
  const initial = [
    { value: 'alpha', label: 'Alpha' },
    { value: 'bravo', label: 'Bravo' },
    { value: 'charlie', label: 'Charlie' },
  ] as const

  const activeText = () => {
    const list = screen.getByRole('listbox')
    const id = list.getAttribute('aria-activedescendant')
    return id === null ? null : document.getElementById(id)?.textContent
  }

  test('an async reorder preserves the highlighted value before Enter', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Select value="alpha" options={initial} onChange={onChange} data-testid="sel" />,
    )
    fireEvent.click(screen.getByTestId('sel'))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    expect(activeText()).toContain('Bravo')

    const reordered = [initial[2], initial[0], initial[1]] as const
    rerender(<Select value="alpha" options={reordered} onChange={onChange} data-testid="sel" />)
    expect(activeText()).toContain('Bravo')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('bravo')
  })

  test('a removed highlighted value falls back to the first enabled option before Enter', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Select value="alpha" options={initial} onChange={onChange} data-testid="sel" />,
    )
    fireEvent.click(screen.getByTestId('sel'))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    expect(activeText()).toContain('Bravo')

    const withoutBravo = [initial[2], initial[0]] as const
    rerender(<Select value="alpha" options={withoutBravo} onChange={onChange} data-testid="sel" />)
    expect(activeText()).toContain('Charlie')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('charlie')
  })

  test('a newly disabled highlighted value cannot be committed by Enter', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Select value="alpha" options={initial} onChange={onChange} data-testid="sel" />,
    )
    fireEvent.click(screen.getByTestId('sel'))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    expect(activeText()).toContain('Bravo')

    const disabledBravo = [{ ...initial[1], disabled: true }, initial[2], initial[0]] as const
    rerender(<Select value="alpha" options={disabledBravo} onChange={onChange} data-testid="sel" />)
    expect(activeText()).toContain('Charlie')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('charlie')
    expect(onChange).not.toHaveBeenCalledWith('bravo')
  })
})
