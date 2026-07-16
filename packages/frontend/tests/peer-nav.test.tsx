// RFC-201 T5.4: sibling resources are links inside a labelled nav, not tabs.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { PeerNav } from '../src/components/PeerNav'

const items = [
  { key: 'alpha', label: 'Alpha shard', href: '/clarify/a?focus=q1' },
  { key: 'beta', label: 'Beta shard', href: '/clarify/b?focus=q1' },
] as const

function Fixture({ active }: { active: (typeof items)[number]['key'] }) {
  return (
    <PeerNav
      items={items}
      activeKey={active}
      ariaLabel="Sibling clarify rounds"
      renderDestination={(item, destination) => (
        <a
          href={item.href}
          className={destination.className}
          aria-current={destination.ariaCurrent}
        >
          {destination.children}
        </a>
      )}
    />
  )
}

describe('PeerNav', () => {
  test('renders native links in a named nav with exactly one current page', () => {
    const { rerender } = render(<Fixture active="alpha" />)
    const nav = screen.getByRole('navigation', { name: 'Sibling clarify rounds' })
    expect(nav.querySelector('[role="tablist"]')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()

    const alpha = screen.getByRole('link', { name: 'Alpha shard' })
    const beta = screen.getByRole('link', { name: 'Beta shard' })
    expect(alpha.getAttribute('href')).toBe('/clarify/a?focus=q1')
    expect(alpha.getAttribute('aria-current')).toBe('page')
    expect(alpha.className).toContain('btn--primary')
    expect(beta.getAttribute('aria-current')).toBeNull()

    rerender(<Fixture active="beta" />)
    expect(
      screen.getByRole('link', { name: 'Alpha shard' }).getAttribute('aria-current'),
    ).toBeNull()
    expect(screen.getByRole('link', { name: 'Beta shard' }).getAttribute('aria-current')).toBe(
      'page',
    )
  })

  test('does not consume link activation or modifier-click behavior', () => {
    render(<Fixture active="alpha" />)
    const link = screen.getByRole('link', { name: 'Beta shard' })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
    const prevented = !link.dispatchEvent(click)
    expect(prevented).toBe(false)
  })

  test('Clarify route uses PeerNav + TanStack Link and never borrows tab classes', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'clarify.detail.tsx'),
      'utf8',
    )
    expect(source).toContain('<PeerNav')
    expect(source).toContain('<Link')
    expect(source).toContain('aria-current={destination.ariaCurrent}')
    expect(source).not.toContain('tabs__tab')
  })
})
