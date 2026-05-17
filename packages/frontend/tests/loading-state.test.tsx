// RFC-035 PR3 — render matrix for the shared <LoadingState>.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { LoadingState } from '../src/components/LoadingState'
import '../src/i18n'

describe('<LoadingState />', () => {
  test('renders role=status + aria-live=polite for screen readers', () => {
    const { getByTestId } = render(<LoadingState />)
    const node = getByTestId('loading-state')
    expect(node.getAttribute('role')).toBe('status')
    expect(node.getAttribute('aria-live')).toBe('polite')
  })

  test('default label falls back to t("common.loading")', () => {
    const { getByTestId } = render(<LoadingState />)
    const text = getByTestId('loading-state').textContent ?? ''
    expect(text.length).toBeGreaterThan(0)
  })

  test('custom label overrides the default', () => {
    const { getByTestId } = render(<LoadingState label="Fetching agents…" />)
    expect(getByTestId('loading-state').textContent ?? '').toContain('Fetching agents…')
  })

  test('size=compact applies the modifier class', () => {
    const { container } = render(<LoadingState size="compact" />)
    expect(container.querySelector('.loading-state--compact')).not.toBeNull()
  })

  test('renders the spinner anchor element', () => {
    const { container } = render(<LoadingState />)
    expect(container.querySelector('.loading-state__spinner')).not.toBeNull()
  })
})
