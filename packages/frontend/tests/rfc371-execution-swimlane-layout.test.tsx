// RFC-371: a common button alignment rule collapsed the real lane track to 2px.
// Preserve one actual time axis, zero-duration markers and unknown-time semantics.
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ExecutionSwimlane } from '../src/components/ExecutionSwimlane'

afterEach(cleanup)

test('the shared ruler matches actual parallel intervals and distinguishes zero from an unknown end', () => {
  const select = vi.fn()
  const { container } = render(
    <ExecutionSwimlane
      label="Attempts"
      rowHeading="Attempt"
      timeHeading="Page execution range"
      unknownLabel="Unknown interval"
      from={1000}
      to={5000}
      onSelect={select}
      rows={[
        { id: 'a', label: 'Agent A', start: 1000, end: 3000, description: 'Open A', detail: '2 s' },
        { id: 'b', label: 'Agent B', start: 1000, end: 4000, description: 'Open B', detail: '3 s' },
        {
          id: 'end',
          label: 'Output',
          start: 5000,
          end: 5000,
          description: 'Open output',
          detail: '0 ms',
        },
        {
          id: 'missing',
          label: 'Missing',
          start: 2000,
          end: null,
          description: 'Open missing',
          detail: '',
        },
      ]}
    />,
  )
  expect(
    Array.from(container.querySelectorAll('.execution-swimlane__axis span'), (e) => e.textContent),
  ).toEqual(['+0 s', '+1 s', '+2 s', '+3 s', '+4 s'])
  const a = screen.getByRole('button', { name: 'Open A' })
  const b = screen.getByRole('button', { name: 'Open B' })
  expect(a.classList.contains('btn--ghost')).toBe(true)
  for (const [button, width] of [
    [a, '50%'],
    [b, '75%'],
  ] as const) {
    const bar = button.querySelector<HTMLElement>('.execution-swimlane__bar')!
    expect(bar.style.left).toBe('0%')
    expect(bar.style.width).toBe(width)
  }
  const zero = screen.getByRole('button', { name: 'Open output' })
  expect(zero.querySelector('.execution-swimlane__bar')).toBeNull()
  expect(zero.querySelector<HTMLElement>('.execution-swimlane__point')?.style.left).toBe('100%')
  expect(zero.textContent).toContain('0 ms')
  const missing = screen.getByRole('button', { name: 'Open missing' })
  expect(missing.querySelector('.execution-swimlane__bar')).toBeNull()
  expect(missing.textContent).toContain('Unknown interval')
  missing.focus()
  fireEvent.click(missing)
  expect(select).toHaveBeenCalledWith('missing', missing)
  expect(document.activeElement).toBe(missing)
})

test('unknown page times keep empty lanes without exposing the layout placeholder as a ruler', () => {
  const asOf = 1791090812729
  const { container } = render(
    <ExecutionSwimlane
      label="Attempts"
      rowHeading="Attempt"
      timeHeading="Unknown interval"
      unknownLabel="Unknown interval"
      from={asOf}
      to={asOf + 1}
      onSelect={vi.fn()}
      rows={[
        {
          id: 'unknown',
          label: 'Agent A',
          start: null,
          end: null,
          description: 'Open unknown',
          detail: '',
        },
      ]}
    />,
  )
  expect(container.querySelector('.execution-swimlane__axis')).toBeNull()
  expect(container.querySelector('.execution-swimlane__bar')).toBeNull()
  expect(container.querySelector('.execution-swimlane__point')).toBeNull()
  expect(container.querySelector('.execution-swimlane__open')).toBeNull()
  expect(screen.getByRole('button', { name: 'Open unknown' }).textContent).toContain(
    'Unknown interval',
  )
})

test('a known open start retains a time marker and the shared ruler without inventing an end', () => {
  const { container } = render(
    <ExecutionSwimlane
      label="Attempts"
      rowHeading="Attempt"
      timeHeading="Page execution range"
      unknownLabel="Unknown interval"
      from={1000}
      to={5000}
      onSelect={vi.fn()}
      rows={[
        {
          id: 'open',
          label: 'Agent A',
          start: 2000,
          end: null,
          open: true,
          description: 'Open ongoing',
          detail: '',
        },
      ]}
    />,
  )
  expect(container.querySelectorAll('.execution-swimlane__axis span')).toHaveLength(5)
  expect(container.querySelector('.execution-swimlane__bar')).toBeNull()
  expect(container.querySelector<HTMLElement>('.execution-swimlane__open')?.style.left).toBe('25%')
  expect(screen.getByRole('button', { name: 'Open ongoing' }).textContent).toContain(
    'Unknown interval',
  )
})
