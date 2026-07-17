// RFC-195 T2 — shared <ErrorBanner> message/action/a11y extension contract.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ApiError } from '../src/api/client'
import { ErrorBanner } from '../src/components/ErrorBanner'

describe('<ErrorBanner />', () => {
  test('keeps Error message parsing and exposes an alert', () => {
    render(<ErrorBanner error={new Error('network unavailable')} />)

    const alert = screen.getByRole('alert')
    expect(alert.className).toContain('notice-banner--error')
    expect(alert.textContent).toBe('network unavailable')
    expect(alert.textContent).not.toContain('⚠')
    expect(alert.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  test('ApiError renders the resolved title + the raw message in a collapsible block (RFC-203)', () => {
    render(<ErrorBanner error={new ApiError(503, 'upstream-down', 'try again later')} />)

    const alert = screen.getByRole('alert')
    // Unmapped code → misc domain template title; raw folded, not inline.
    expect(alert.textContent).toContain('Request failed')
    const fold = alert.querySelector('.error-details__raw pre')
    expect(fold?.textContent).toBe('try again later')
  })

  test('message overrides the title; raw diagnostics stay in the fold', () => {
    render(
      <ErrorBanner
        error={new ApiError(503, 'upstream-down', 'try again later')}
        message="Reviews could not be loaded"
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Reviews could not be loaded')
    expect(alert.querySelector('.error-details__raw pre')?.textContent).toBe('try again later')
  })

  test('action adds the layout modifier and renders beside the message', () => {
    render(
      <ErrorBanner
        error={new Error('network unavailable')}
        action={<button type="button">Retry</button>}
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert.className).toContain('notice-banner--error')
    expect(screen.getByRole('button', { name: 'Retry' }).parentElement?.className).toBe(
      'notice-banner__action',
    )
    expect(alert.querySelector('.notice-banner__body')?.textContent).toBe('network unavailable')
  })

  test('optional dismiss control is accessible and delegates state ownership', () => {
    const onDismiss = vi.fn()
    render(<ErrorBanner error={new Error('network unavailable')} onDismiss={onDismiss} />)

    const close = screen.getByRole('button', { name: /close|关闭/i })
    fireEvent.click(close)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
