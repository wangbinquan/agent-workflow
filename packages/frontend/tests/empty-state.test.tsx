// RFC-035 PR3 — render matrix for the shared <EmptyState>.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { EmptyState } from '../src/components/EmptyState'

describe('<EmptyState />', () => {
  test('renders the title in the title slot', () => {
    const { getByTestId } = render(<EmptyState title="No agents yet" />)
    expect(getByTestId('empty-state').textContent ?? '').toContain('No agents yet')
  })

  test('description renders when provided', () => {
    const { getByTestId } = render(
      <EmptyState title="t" description="Try creating one in the New page." />,
    )
    expect(getByTestId('empty-state').textContent ?? '').toContain('Try creating one')
  })

  test('icon renders when provided (aria-hidden)', () => {
    const { container } = render(<EmptyState title="t" icon={<span data-testid="icon">📭</span>} />)
    const icon = container.querySelector('.empty-state__icon')
    expect(icon).not.toBeNull()
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
  })

  test('action renders when provided', () => {
    const { container } = render(
      <EmptyState title="t" action={<button data-testid="cta">Add</button>} />,
    )
    expect(container.querySelector('.empty-state__action')).not.toBeNull()
    expect(container.querySelector('[data-testid="cta"]')).not.toBeNull()
  })

  test('size=compact applies the modifier class', () => {
    const { container } = render(<EmptyState title="t" size="compact" />)
    expect(container.querySelector('.empty-state--compact')).not.toBeNull()
  })

  test('default size has no compact modifier', () => {
    const { container } = render(<EmptyState title="t" />)
    expect(container.querySelector('.empty-state--compact')).toBeNull()
  })

  test('custom data-testid overrides the default', () => {
    const { getByTestId } = render(<EmptyState title="t" data-testid="agents-empty" />)
    expect(getByTestId('agents-empty')).not.toBeNull()
  })
})
