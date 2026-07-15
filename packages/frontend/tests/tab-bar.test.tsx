// RFC-150 PR-1 — <TabBar> primitive contract lock.
//
// Locks the tablist/tab/aria-selected DOM shape (byte-compatible with the
// pre-RFC hand-rolled `.tabs` strips), onSelect wiring, the badge slot
// (`.tabs__tab-badge`, tasks.detail pending-question count), the
// `.tabs--<variant>` modifier mapping and per-tab testids.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TabBar, type TabDef } from '../src/components/TabBar'

type Key = 'edit' | 'preview'

const TABS: ReadonlyArray<TabDef<Key>> = [
  { key: 'edit', label: 'Edit' },
  { key: 'preview', label: 'Preview' },
]

afterEach(() => {
  document.body.innerHTML = ''
})

describe('<TabBar> — tablist shape', () => {
  test('container is role=tablist with .tabs class and optional aria-label', () => {
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} ariaLabel="Drawer tabs" />)
    const list = screen.getByRole('tablist', { name: 'Drawer tabs' })
    expect(list.className).toBe('tabs')
  })

  test('tabs are type=button role=tab with aria-selected on the active one', () => {
    render(<TabBar tabs={TABS} active="preview" onSelect={() => {}} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    for (const tab of tabs) expect(tab.getAttribute('type')).toBe('button')
    expect(screen.getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true')
  })

  test('active tab carries tabs__tab--active; inactive does not', () => {
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} />)
    expect(screen.getByRole('tab', { name: 'Edit' }).className).toBe('tabs__tab tabs__tab--active')
    expect(screen.getByRole('tab', { name: 'Preview' }).className).toBe('tabs__tab')
  })

  test('clicking a tab fires onSelect with its key', () => {
    const onSelect = vi.fn()
    render(<TabBar tabs={TABS} active="edit" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('preview')
  })

  test('disabled tabs expose native disabled semantics and do not select', () => {
    const onSelect = vi.fn()
    render(
      <TabBar
        tabs={[
          { key: 'edit', label: 'Edit', disabled: true },
          { key: 'preview', label: 'Preview' },
        ]}
        active="edit"
        onSelect={onSelect}
      />,
    )
    const edit = screen.getByRole('tab', { name: 'Edit' }) as HTMLButtonElement
    expect(edit.disabled).toBe(true)
    fireEvent.click(edit)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('<TabBar> — variant / className mapping', () => {
  test.each([
    ['inline', 'tabs tabs--inline'],
    ['inspector', 'tabs tabs--inspector'],
    ['segment', 'tabs tabs--segment'],
  ] as const)('variant=%s renders class "%s"', (variant, expected) => {
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} variant={variant} />)
    expect(screen.getByRole('tablist').className).toBe(expected)
  })

  test('variant="default" (and omitted) add no modifier class', () => {
    const { unmount } = render(
      <TabBar tabs={TABS} active="edit" onSelect={() => {}} variant="default" />,
    )
    expect(screen.getByRole('tablist').className).toBe('tabs')
    unmount()
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} />)
    expect(screen.getByRole('tablist').className).toBe('tabs')
  })

  test('className is appended after the tabs chain', () => {
    render(
      <TabBar
        tabs={TABS}
        active="edit"
        onSelect={() => {}}
        variant="segment"
        className="task-detail__tab-bar"
      />,
    )
    expect(screen.getByRole('tablist').className).toBe('tabs tabs--segment task-detail__tab-bar')
  })
})

describe('<TabBar> — badge slot + testids', () => {
  test('badge renders as <span class="tabs__tab-badge"> inside its tab', () => {
    render(
      <TabBar
        tabs={[
          { key: 'edit', label: 'Edit' },
          { key: 'preview', label: 'Questions', badge: 3 },
        ]}
        active="edit"
        onSelect={() => {}}
      />,
    )
    const tab = screen.getByRole('tab', { name: /Questions/ })
    const badge = tab.querySelector('.tabs__tab-badge')
    expect(badge).not.toBeNull()
    expect(badge?.tagName).toBe('SPAN')
    expect(badge?.textContent).toBe('3')
  })

  test('undefined / false badge renders no badge span (count > 0 && count idiom)', () => {
    const count = [].length
    const { container } = render(
      <TabBar
        tabs={[
          { key: 'edit', label: 'Edit' },
          { key: 'preview', label: 'Questions', badge: count > 0 && count },
        ]}
        active="edit"
        onSelect={() => {}}
      />,
    )
    expect(container.querySelector('.tabs__tab-badge')).toBeNull()
  })

  test('per-tab testid lands on the tab button; tabs without one get none', () => {
    render(
      <TabBar
        tabs={[
          { key: 'edit', label: 'Edit', testid: 'drawer-tab-edit' },
          { key: 'preview', label: 'Preview' },
        ]}
        active="edit"
        onSelect={() => {}}
      />,
    )
    expect(screen.getByTestId('drawer-tab-edit')).toBe(screen.getByRole('tab', { name: 'Edit' }))
    expect(screen.getByRole('tab', { name: 'Preview' }).hasAttribute('data-testid')).toBe(false)
  })

  test('badgeTestid lands on the badge span itself (tasks.detail tq-tab-badge)', () => {
    render(
      <TabBar
        tabs={[
          { key: 'edit', label: 'Edit', badgeTestid: 'never-rendered' },
          { key: 'preview', label: 'Questions', badge: 5, badgeTestid: 'tq-tab-badge' },
        ]}
        active="edit"
        onSelect={() => {}}
      />,
    )
    const badge = screen.getByTestId('tq-tab-badge')
    expect(badge.className).toBe('tabs__tab-badge')
    expect(badge.textContent).toBe('5')
    // No badge → the badgeTestid is inert (span not rendered at all).
    expect(screen.queryByTestId('never-rendered')).toBeNull()
  })

  test('rootTestid lands on the tablist container; absent by default', () => {
    const { unmount } = render(
      <TabBar tabs={TABS} active="edit" onSelect={() => {}} rootTestid="memory-tab-bar" />,
    )
    expect(screen.getByTestId('memory-tab-bar')).toBe(screen.getByRole('tablist'))
    unmount()
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} />)
    expect(screen.getByRole('tablist').hasAttribute('data-testid')).toBe(false)
  })
})
