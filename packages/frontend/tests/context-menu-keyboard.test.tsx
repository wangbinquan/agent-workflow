import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ContextMenu } from '../src/components/canvas/ContextMenu'

afterEach(() => cleanup())

describe('ContextMenu keyboard contract', () => {
  test('focuses the first enabled item and supports Arrow/Home/End/Enter', async () => {
    const first = vi.fn()
    const last = vi.fn()
    const { getByText } = render(
      <ContextMenu
        open
        x={0}
        y={0}
        items={[
          { label: 'First', onSelect: first },
          { label: 'Disabled', onSelect: vi.fn(), disabled: true },
          { label: 'Last', onSelect: last },
        ]}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(document.activeElement).toBe(getByText('First')))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(getByText('Last'))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(getByText('First'))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(getByText('Last'))
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(last).toHaveBeenCalledTimes(1)
  })

  test('Escape closes and restores the supplied trigger', async () => {
    const onClose = vi.fn()
    const triggerRef = createRef<HTMLButtonElement>()
    const { getByText, rerender } = render(
      <>
        <button ref={triggerRef}>Trigger</button>
        <ContextMenu
          open
          x={0}
          y={0}
          items={[{ label: 'Item', onSelect: vi.fn() }]}
          onClose={onClose}
          triggerRef={triggerRef}
        />
      </>,
    )
    await waitFor(() => expect(document.activeElement).toBe(getByText('Item')))
    fireEvent.keyDown(getByText('Item'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(
      <>
        <button ref={triggerRef}>Trigger</button>
        <ContextMenu
          open={false}
          x={0}
          y={0}
          items={[]}
          onClose={onClose}
          triggerRef={triggerRef}
        />
      </>,
    )
    await waitFor(() => expect(document.activeElement).toBe(getByText('Trigger')))
  })
})
