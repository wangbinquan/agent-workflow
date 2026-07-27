import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import i18n from '../src/i18n'
import { OwnerLabel } from '../src/components/OwnerLabel'

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
})

describe('OwnerLabel', () => {
  test('renders both the display name and the complete username', () => {
    const { container } = render(
      <OwnerLabel
        ownerUserId="u1"
        owner={{ id: 'u1', username: 'alice.long', displayName: 'Alice Example' }}
      />,
    )
    expect(container.textContent).toContain('Alice Example')
    expect(container.textContent).toContain('@alice.long')
    expect(container.querySelector('.owner-label')?.getAttribute('title')).toBe(
      'Alice Example (@alice.long)',
    )
  })

  test('falls back to a stable id for missing or mismatched identities', () => {
    const { container, rerender } = render(
      <OwnerLabel ownerUserId="deleted-user-42" owner={null} />,
    )
    expect(container.textContent).toBe('deleted-user-42')

    rerender(
      <OwnerLabel
        ownerUserId="expected-id"
        owner={{ id: 'wrong-id', username: 'wrong', displayName: 'Wrong User' }}
      />,
    )
    expect(container.textContent).toBe('expected-id')
    expect(container.textContent).not.toContain('Wrong User')
  })

  test('renders explicit system and old-daemon compatibility labels', () => {
    const { container, rerender } = render(<OwnerLabel ownerUserId="__system__" owner={null} />)
    expect(container.textContent).toBe('System (no owner)')

    rerender(<OwnerLabel ownerUserId={null} owner={null} />)
    expect(container.textContent).toBe('System (no owner)')

    rerender(<OwnerLabel />)
    expect(container.textContent).toBe('Unknown owner')
  })
})
