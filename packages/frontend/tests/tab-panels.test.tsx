// RFC-169 (T5) — TabPanels keeps inactive panels mounted (hidden), so a child's
// local buffer survives tab switches instead of being dropped on every switch
// (§3.4, R2-P1-2). Locks: inactive panel present with `hidden`; an uncontrolled
// input's value round-trips across a switch away and back.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { TabPanels } from '../src/components/split/TabPanels'

afterEach(() => vi.restoreAllMocks())

function Harness() {
  const [active, setActive] = useState<'a' | 'b'>('a')
  return (
    <>
      <button type="button" data-testid="to-a" onClick={() => setActive('a')}>
        a
      </button>
      <button type="button" data-testid="to-b" onClick={() => setActive('b')}>
        b
      </button>
      <TabPanels
        active={active}
        panels={[
          { key: 'a', testid: 'panel-a', content: <input data-testid="input-a" defaultValue="" /> },
          { key: 'b', testid: 'panel-b', content: <div>panel b body</div> },
        ]}
      />
    </>
  )
}

describe('TabPanels keep-mounted', () => {
  test('inactive panel stays in the DOM with hidden set', () => {
    render(<Harness />)
    expect(screen.getByTestId('panel-a').hasAttribute('hidden')).toBe(false)
    expect(screen.getByTestId('panel-b').hasAttribute('hidden')).toBe(true)
    fireEvent.click(screen.getByTestId('to-b'))
    expect(screen.getByTestId('panel-a').hasAttribute('hidden')).toBe(true)
    expect(screen.getByTestId('panel-b').hasAttribute('hidden')).toBe(false)
  })

  test("a child's local buffer survives switching away and back", () => {
    render(<Harness />)
    const input = screen.getByTestId('input-a') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'draft-in-progress' } })
    fireEvent.click(screen.getByTestId('to-b')) // switch away (panel a hidden, not unmounted)
    fireEvent.click(screen.getByTestId('to-a')) // switch back
    expect((screen.getByTestId('input-a') as HTMLInputElement).value).toBe('draft-in-progress')
  })
})
