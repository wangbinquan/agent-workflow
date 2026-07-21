// RFC-214 T1 — locks ErrorBanner's new onRetry contract:
//   - onRetry (no explicit action) → ONE canonical .btn.btn--sm retry button;
//   - onRetry-only still gets `error-banner--with-action` (MAJOR-5: else the
//     button lands in the slot but loses the flex row layout, a style regression);
//   - explicit `action` still wins (RFC-203 back-compat, zero ripple);
//   - retryLabel overrides the default common.retry label.

import { describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { ErrorBanner } from '../src/components/ErrorBanner'
import '../src/i18n'

afterEach(() => cleanup())

describe('<ErrorBanner onRetry />', () => {
  test('onRetry renders one .btn.btn--sm retry button that fires the callback', () => {
    const onRetry = vi.fn()
    const { getByRole, container } = render(
      <ErrorBanner error={new Error('x')} onRetry={onRetry} />,
    )
    const btn = getByRole('button', { name: 'Retry' })
    expect(btn.className).toContain('btn')
    expect(btn.className).toContain('btn--sm')
    fireEvent.click(btn)
    expect(onRetry).toHaveBeenCalledTimes(1)
    // MAJOR-5: onRetry-only must still carry the flex-row layout class.
    expect(container.querySelector('.error-banner--with-action')).not.toBeNull()
  })

  test('explicit action wins over onRetry (RFC-203 back-compat)', () => {
    const onRetry = vi.fn()
    const { getByTestId, queryByRole } = render(
      <ErrorBanner
        error={new Error('x')}
        onRetry={onRetry}
        action={<button data-testid="custom">Custom</button>}
      />,
    )
    expect(getByTestId('custom')).not.toBeNull()
    // the built-in retry button must not appear
    expect(queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  test('retryLabel overrides the default label', () => {
    const { getByRole } = render(
      <ErrorBanner error={new Error('x')} onRetry={() => {}} retryLabel="Try again" />,
    )
    expect(getByRole('button', { name: 'Try again' })).not.toBeNull()
  })

  test('no action and no onRetry → no with-action class (unchanged from RFC-203)', () => {
    const { container } = render(<ErrorBanner error={new Error('x')} />)
    expect(container.querySelector('.error-banner--with-action')).toBeNull()
    expect(container.querySelector('.error-box')).not.toBeNull()
  })
})
