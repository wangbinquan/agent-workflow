// RFC-150 PR-1 — <TabBar> primitive contract lock.
//
// Locks the tablist/tab/aria-selected DOM shape (byte-compatible with the
// pre-RFC hand-rolled `.tabs` strips), onSelect wiring, the badge slot
// (`.tabs__tab-badge`, tasks.detail pending-question count), the
// `.tabs--<variant>` modifier mapping and per-tab testids.

import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TabBar, tabDomIds, type TabDef } from '../src/components/TabBar'

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
        activation="manual"
      />,
    )
    const edit = screen.getByRole('tab', { name: 'Edit' }) as HTMLButtonElement
    expect(edit.disabled).toBe(true)
    fireEvent.click(edit)
    fireEvent.keyDown(edit, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('uses one roving tab stop and follows a disabled active tab with the first enabled tab', () => {
    const { rerender } = render(<TabBar tabs={TABS} active="preview" onSelect={() => {}} />)
    expect(screen.getByRole('tab', { name: 'Edit' }).tabIndex).toBe(-1)
    expect(screen.getByRole('tab', { name: 'Preview' }).tabIndex).toBe(0)

    rerender(
      <TabBar
        tabs={[
          { key: 'edit', label: 'Edit', disabled: true },
          { key: 'preview', label: 'Preview' },
        ]}
        active="edit"
        onSelect={() => {}}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Edit' }).tabIndex).toBe(-1)
    expect(screen.getByRole('tab', { name: 'Preview' }).tabIndex).toBe(0)
  })
})

describe('<TabBar> — keyboard roving', () => {
  const tabs: ReadonlyArray<TabDef<'a' | 'b' | 'c' | 'd'>> = [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B', disabled: true },
    { key: 'c', label: 'C' },
    { key: 'd', label: 'D' },
  ]

  test('ArrowLeft/Right wrap, skip disabled tabs, focus, and automatically select', () => {
    const onSelect = vi.fn()
    render(<TabBar tabs={tabs} active="a" onSelect={onSelect} />)
    const a = screen.getByRole('tab', { name: 'A' })
    const c = screen.getByRole('tab', { name: 'C' })
    const d = screen.getByRole('tab', { name: 'D' })

    a.focus()
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(c)
    expect(c.tabIndex).toBe(0)
    expect(onSelect).toHaveBeenLastCalledWith('c')

    fireEvent.keyDown(c, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(a)
    expect(onSelect).toHaveBeenLastCalledWith('a')

    fireEvent.keyDown(a, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(d)
    expect(onSelect).toHaveBeenLastCalledWith('d')
  })

  test('Home/End target the first/last enabled tab', () => {
    const onSelect = vi.fn()
    render(<TabBar tabs={tabs} active="c" onSelect={onSelect} />)
    const a = screen.getByRole('tab', { name: 'A' })
    const c = screen.getByRole('tab', { name: 'C' })
    const d = screen.getByRole('tab', { name: 'D' })

    c.focus()
    fireEvent.keyDown(c, { key: 'End' })
    expect(document.activeElement).toBe(d)
    expect(onSelect).toHaveBeenLastCalledWith('d')

    fireEvent.keyDown(d, { key: 'Home' })
    expect(document.activeElement).toBe(a)
    expect(onSelect).toHaveBeenLastCalledWith('a')
  })

  test('manual activation moves focus without selecting until Space or Enter', () => {
    const onSelect = vi.fn()
    render(<TabBar tabs={tabs} active="a" onSelect={onSelect} activation="manual" />)
    const a = screen.getByRole('tab', { name: 'A' })
    const c = screen.getByRole('tab', { name: 'C' })

    a.focus()
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(c)
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.keyDown(c, { key: ' ' })
    expect(onSelect).toHaveBeenCalledWith('c')
    fireEvent.keyDown(c, { key: 'Enter' })
    expect(onSelect).toHaveBeenLastCalledWith('c')
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  test('all-disabled tabs expose no tab stop and ignore keyboard selection', () => {
    const onSelect = vi.fn()
    render(
      <TabBar
        tabs={tabs.map((tab) => ({ ...tab, disabled: true }))}
        active="a"
        onSelect={onSelect}
      />,
    )
    expect(screen.getAllByRole('tab').every((tab) => tab.tabIndex === -1)).toBe(true)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'ArrowRight' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('<TabBar> — panel ids and scrolling', () => {
  test('tablist owns horizontal overflow without shrinking tab targets', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
    const tabsRule = css.match(/\.tabs\s*\{([^}]*)\}/)?.[1] ?? ''
    const tabRule = css.match(/\.tabs__tab\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(tabsRule).toContain('overflow-x: auto')
    expect(tabsRule).toContain('overscroll-behavior-inline: contain')
    expect(tabsRule).toContain('scrollbar-width: thin')
    expect(tabRule).toContain('flex: 0 0 auto')
  })

  test('tabDomIds and idPrefix create stable tab/panel associations', () => {
    expect(tabDomIds('settings', 'runtime')).toEqual({
      tabId: 'settings-tab-runtime',
      panelId: 'settings-panel-runtime',
    })
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} idPrefix="agent-editor" />)
    const edit = screen.getByRole('tab', { name: 'Edit' })
    expect(edit.id).toBe('agent-editor-tab-edit')
    expect(edit.getAttribute('aria-controls')).toBe('agent-editor-panel-edit')
  })

  test('scrolls a newly active tab into view and honors reduced motion', () => {
    const scrollIntoView = vi.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const { rerender } = render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} />)
    scrollIntoView.mockClear()
    rerender(<TabBar tabs={TABS} active="preview" onSelect={() => {}} />)
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'auto',
    })
    HTMLElement.prototype.scrollIntoView = original
    vi.unstubAllGlobals()
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
