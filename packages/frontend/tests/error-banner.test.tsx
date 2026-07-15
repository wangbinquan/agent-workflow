// RFC-195 T2 — shared <ErrorBanner> message/action/a11y extension contract.

import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { ApiError } from '../src/api/client'
import { ErrorBanner } from '../src/components/ErrorBanner'
import { describeApiError } from '../src/i18n'

describe('<ErrorBanner />', () => {
  test('keeps Error message parsing and exposes an alert', () => {
    render(<ErrorBanner error={new Error('network unavailable')} />)

    const alert = screen.getByRole('alert')
    expect(alert.className).toContain('notice-banner--error')
    expect(alert.textContent).toBe('network unavailable')
    expect(alert.textContent).not.toContain('⚠')
    expect(alert.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  test('keeps ApiError code and message parsing', () => {
    render(<ErrorBanner error={new ApiError(503, 'upstream-down', 'try again later')} />)

    expect(screen.getByRole('alert').textContent).toBe(
      describeApiError(new ApiError(503, 'upstream-down', 'try again later')),
    )
  })

  test('message overrides the default error parsing', () => {
    render(
      <ErrorBanner
        error={new ApiError(503, 'upstream-down', 'try again later')}
        message="Reviews could not be loaded"
      />,
    )

    expect(screen.getByRole('alert').textContent).toBe('Reviews could not be loaded')
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
})
