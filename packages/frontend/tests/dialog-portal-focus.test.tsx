// Regression lock for the Dialog focus-trap vs. body-portaled <Select>
// popover conflict.
//
// Symptom (reported 2026-06-06, Settings → Authentication → Add provider):
// opening the "Provisioning policy" <Select> inside the dialog snapped the
// scrollbar back to the top and the dropdown was unusable; a follow-up
// click on "Cancel" appeared to do nothing.
//
// Cause: <Select> portals its listbox to document.body (to escape the
// panel's overflow clipping). The Dialog focus trap treated that out-of-
// panel focus as an escape and yanked focus to the panel's first focusable
// — the × close button at the top — scroll-jumping the panel to the top.
//
// Fix: Dialog.isFocusInsideDialog() now treats focus inside a popover that
// a panel control owns via aria-controls (combobox → listbox) as "inside".
// These tests must stay green so the trap never re-grabs an open <Select>,
// while still trapping focus that genuinely escapes the dialog.

import { describe, expect, test } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { Dialog } from '../src/components/Dialog'
import { Select } from '../src/components/Select'

function DialogWithSelect() {
  const [v, setV] = useState<'a' | 'b'>('a')
  return (
    <Dialog open onClose={() => {}} title="t">
      <Select<'a' | 'b'>
        value={v}
        onChange={setV}
        ariaLabel="sel"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />
    </Dialog>
  )
}

describe('Dialog focus trap × portaled <Select>', () => {
  test('opening a <Select> inside the dialog keeps focus on the listbox (not yanked to ×)', async () => {
    render(<DialogWithSelect />)
    fireEvent.click(document.querySelector('[role="combobox"]') as HTMLElement)
    // <Select> focuses its listbox on a setTimeout(0).
    await new Promise((r) => setTimeout(r, 10))

    const listbox = document.querySelector('[role="listbox"]')
    expect(listbox).not.toBeNull()
    const ae = document.activeElement
    // The bug: ae was the dialog__close button. After the fix focus must
    // remain within the owned listbox popover.
    expect(ae?.getAttribute('class')).not.toBe('dialog__close')
    expect(listbox?.contains(ae)).toBe(true)
    // Dropdown stays open and usable.
    expect(
      (document.querySelector('[role="combobox"]') as HTMLElement).getAttribute('aria-expanded'),
    ).toBe('true')
  })

  test('focus that genuinely escapes the dialog is still trapped back inside', () => {
    render(
      <>
        <button data-testid="outside">outside</button>
        <DialogWithSelect />
      </>,
    )
    const outside = document.querySelector<HTMLButtonElement>('[data-testid="outside"]')
    outside?.focus()
    // No aria-controls inside the panel points at this button, so the trap
    // must yank focus back into the panel.
    const ae = document.activeElement
    expect(ae).not.toBe(outside)
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(panel?.contains(ae)).toBe(true)
  })
})
