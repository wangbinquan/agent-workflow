// RFC-150 PR-1 — <TabBar> primitive contract lock.
//
// Locks the tablist/tab/aria-selected DOM shape (byte-compatible with the
// pre-RFC hand-rolled `.tabs` strips), onSelect wiring, the badge slot
// (`.tabs__tab-badge`, tasks.detail pending-question count), the
// `.tabs--<variant>` modifier mapping, overflow affordances, required
// accessible names, semantic badge tones and per-tab testids.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TabBar, tabDomIds, type TabBarProps, type TabDef } from '../src/components/TabBar'

type Key = 'edit' | 'preview'

const TABS: ReadonlyArray<TabDef<Key>> = [
  { key: 'edit', label: 'Edit' },
  { key: 'preview', label: 'Preview' },
]

class TestResizeObserver {
  static instances: TestResizeObserver[] = []
  observed = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  observe = (target: Element) => this.observed.add(target)
  unobserve = (target: Element) => this.observed.delete(target)
  disconnect = () => {
    this.disconnected = true
    this.observed.clear()
  }
  trigger = () => this.callback([], this as unknown as ResizeObserver)
}

function latestObserver() {
  const observer = TestResizeObserver.instances.at(-1)
  if (observer === undefined) throw new Error('expected TabBar to create a ResizeObserver')
  return observer
}

function installMetrics(
  tablist: HTMLElement,
  metrics: { clientWidth: number; scrollWidth: number; scrollLeft: number },
) {
  Object.defineProperties(tablist, {
    clientWidth: { configurable: true, get: () => metrics.clientWidth },
    scrollWidth: { configurable: true, get: () => metrics.scrollWidth },
    scrollLeft: { configurable: true, get: () => metrics.scrollLeft },
  })
}

beforeEach(() => {
  TestResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('<TabBar> — tablist shape', () => {
  test('container is role=tablist with .tabs class and a required aria-label', () => {
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} ariaLabel="Drawer tabs" />)
    const list = screen.getByRole('tablist', { name: 'Drawer tabs' })
    expect(list.className).toBe('tabs')
  })

  test('accepts aria-labelledby as the mutually exclusive accessible-name alternative', () => {
    render(
      <>
        <h2 id="drawer-heading">Node inspector</h2>
        <TabBar tabs={TABS} active="edit" onSelect={() => {}} ariaLabelledBy="drawer-heading" />
      </>,
    )
    expect(screen.getByRole('tablist', { name: 'Node inspector' })).toBeTruthy()
  })

  test('type contract rejects a missing name or both naming mechanisms', () => {
    type Base = {
      tabs: ReadonlyArray<TabDef<Key>>
      active: Key
      onSelect: (key: Key) => void
    }
    type MissingIsAccepted = Base extends TabBarProps<Key> ? true : false
    type BothAreAccepted =
      Base & {
        ariaLabel: string
        ariaLabelledBy: string
      } extends TabBarProps<Key>
        ? true
        : false
    type LabelIsAccepted = Base & { ariaLabel: string } extends TabBarProps<Key> ? true : false
    type LabelledByIsAccepted =
      Base & {
        ariaLabelledBy: string
      } extends TabBarProps<Key>
        ? true
        : false

    const contract: [MissingIsAccepted, BothAreAccepted, LabelIsAccepted, LabelledByIsAccepted] = [
      false,
      false,
      true,
      true,
    ]
    expect(contract).toEqual([false, false, true, true])
  })

  test('type contract requires accessible text for attention and danger badges', () => {
    type AttentionWithoutLabel =
      {
        key: Key
        label: string
        badge: number
        badgeTone: 'attention'
      } extends TabDef<Key>
        ? true
        : false
    type DangerWithLabel =
      {
        key: Key
        label: string
        badge: number
        badgeTone: 'danger'
        badgeAriaLabel: string
      } extends TabDef<Key>
        ? true
        : false

    const contract: [AttentionWithoutLabel, DangerWithLabel] = [false, true]
    expect(contract).toEqual([false, true])
  })

  test('tabs are type=button role=tab with aria-selected on the active one', () => {
    render(<TabBar tabs={TABS} active="preview" onSelect={() => {}} ariaLabel="Test tabs" />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    for (const tab of tabs) expect(tab.getAttribute('type')).toBe('button')
    expect(screen.getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true')
  })

  test('active tab carries tabs__tab--active; inactive does not', () => {
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} ariaLabel="Test tabs" />)
    expect(screen.getByRole('tab', { name: 'Edit' }).className).toBe('tabs__tab tabs__tab--active')
    expect(screen.getByRole('tab', { name: 'Preview' }).className).toBe('tabs__tab')
  })

  test('clicking a tab fires onSelect with its key', () => {
    const onSelect = vi.fn()
    render(<TabBar tabs={TABS} active="edit" onSelect={onSelect} ariaLabel="Test tabs" />)
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
        ariaLabel="Test tabs"
      />,
    )
    const edit = screen.getByRole('tab', { name: 'Edit' }) as HTMLButtonElement
    expect(edit.disabled).toBe(true)
    fireEvent.click(edit)
    fireEvent.keyDown(edit, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('uses one roving tab stop and follows a disabled active tab with the first enabled tab', () => {
    const { rerender } = render(
      <TabBar tabs={TABS} active="preview" onSelect={() => {}} ariaLabel="Test tabs" />,
    )
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
        ariaLabel="Test tabs"
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
    render(<TabBar tabs={tabs} active="a" onSelect={onSelect} ariaLabel="Test tabs" />)
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
    render(<TabBar tabs={tabs} active="c" onSelect={onSelect} ariaLabel="Test tabs" />)
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
    render(
      <TabBar
        tabs={tabs}
        active="a"
        onSelect={onSelect}
        activation="manual"
        ariaLabel="Test tabs"
      />,
    )
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
        ariaLabel="Test tabs"
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
    render(
      <TabBar
        tabs={TABS}
        active="edit"
        onSelect={() => {}}
        ariaLabel="Test tabs"
        idPrefix="agent-editor"
      />,
    )
    const edit = screen.getByRole('tab', { name: 'Edit' })
    expect(edit.id).toBe('agent-editor-tab-edit')
    expect(edit.getAttribute('aria-controls')).toBe('agent-editor-panel-edit')
  })

  test('scrolls a newly active tab into view and honors reduced motion', () => {
    const scrollIntoView = vi.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const { rerender } = render(
      <TabBar tabs={TABS} active="edit" onSelect={() => {}} ariaLabel="Test tabs" />,
    )
    scrollIntoView.mockClear()
    rerender(<TabBar tabs={TABS} active="preview" onSelect={() => {}} ariaLabel="Test tabs" />)
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'auto',
    })
    HTMLElement.prototype.scrollIntoView = original
    vi.unstubAllGlobals()
  })
})

describe('<TabBar> — overflow affordances', () => {
  test('observes the scroll container and every tab, then only renders controls for real overflow', () => {
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} ariaLabel="Test tabs" />)
    const tablist = screen.getByRole('tablist')
    const viewport = tablist.parentElement as HTMLDivElement
    const metrics = { clientWidth: 320, scrollWidth: 320, scrollLeft: 0 }
    installMetrics(tablist, metrics)

    const observer = latestObserver()
    expect(observer.observed).toEqual(new Set([tablist, ...screen.getAllByRole('tab')]))
    act(() => observer.trigger())
    expect(viewport.dataset.hasOverflow).toBe('false')
    expect(screen.queryByRole('button', { name: /Show more sections/ })).toBeNull()

    // Exactly one pixel is the subpixel tolerance, not real overflow.
    metrics.scrollWidth = 321
    act(() => observer.trigger())
    expect(viewport.dataset.hasOverflow).toBe('false')

    metrics.scrollWidth = 321.01
    act(() => observer.trigger())
    expect(viewport.dataset.hasOverflow).toBe('true')
    expect(
      (screen.getByRole('button', { name: 'Show more sections before' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Show more sections after' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  test('derives start/end state from scroll events with a one-pixel edge tolerance', () => {
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} ariaLabel="Test tabs" />)
    const tablist = screen.getByRole('tablist')
    const viewport = tablist.parentElement as HTMLDivElement
    const metrics = { clientWidth: 400, scrollWidth: 1000, scrollLeft: 0 }
    installMetrics(tablist, metrics)
    act(() => latestObserver().trigger())

    expect(viewport.dataset.overflowStart).toBe('false')
    expect(viewport.dataset.overflowEnd).toBe('true')

    metrics.scrollLeft = 1
    fireEvent.scroll(tablist)
    expect(viewport.dataset.overflowStart).toBe('false')

    metrics.scrollLeft = 1.01
    fireEvent.scroll(tablist)
    expect(viewport.dataset.overflowStart).toBe('true')
    expect(viewport.dataset.overflowEnd).toBe('true')

    metrics.scrollLeft = 599
    fireEvent.scroll(tablist)
    expect(viewport.dataset.overflowStart).toBe('true')
    expect(viewport.dataset.overflowEnd).toBe('false')

    metrics.scrollWidth = 401
    act(() => latestObserver().trigger())
    expect(viewport.dataset.hasOverflow).toBe('false')
    expect(screen.queryByRole('button', { name: /Show more sections/ })).toBeNull()
  })

  test('scroll buttons stay outside the tablist, page by 70%, and honor reduced motion', () => {
    const onSelect = vi.fn()
    render(<TabBar tabs={TABS} active="edit" onSelect={onSelect} ariaLabel="Test tabs" />)
    const tablist = screen.getByRole('tablist')
    const metrics = { clientWidth: 400, scrollWidth: 1000, scrollLeft: 0 }
    installMetrics(tablist, metrics)
    const scrollBy = vi.fn()
    Object.defineProperty(tablist, 'scrollBy', { configurable: true, value: scrollBy })
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    act(() => latestObserver().trigger())

    const end = screen.getByRole('button', { name: 'Show more sections after' })
    expect(tablist.contains(end)).toBe(false)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    fireEvent.click(end)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 280, behavior: 'smooth' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('true')

    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as unknown as MediaQueryList)
    fireEvent.click(end)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 280, behavior: 'auto' })
  })

  test('allows localized scroll-control labels without changing tab semantics', () => {
    render(
      <TabBar
        tabs={TABS}
        active="edit"
        onSelect={() => {}}
        ariaLabel="Test tabs"
        scrollStartAriaLabel="Earlier sections"
        scrollEndAriaLabel="Later sections"
      />,
    )
    const tablist = screen.getByRole('tablist')
    installMetrics(tablist, { clientWidth: 200, scrollWidth: 500, scrollLeft: 100 })
    act(() => latestObserver().trigger())

    expect(
      (screen.getByRole('button', { name: 'Earlier sections' }) as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Later sections' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})

describe('<TabBar> — variant / className mapping', () => {
  test.each([
    ['inline', 'tabs tabs--inline'],
    ['inspector', 'tabs tabs--inspector'],
    ['segment', 'tabs tabs--segment'],
  ] as const)('variant=%s renders class "%s"', (variant, expected) => {
    render(
      <TabBar
        tabs={TABS}
        active="edit"
        onSelect={() => {}}
        variant={variant}
        ariaLabel="Test tabs"
      />,
    )
    expect(screen.getByRole('tablist').className).toBe(expected)
  })

  test('variant="default" (and omitted) add no modifier class', () => {
    const { unmount } = render(
      <TabBar
        tabs={TABS}
        active="edit"
        onSelect={() => {}}
        variant="default"
        ariaLabel="Test tabs"
      />,
    )
    expect(screen.getByRole('tablist').className).toBe('tabs')
    unmount()
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} ariaLabel="Test tabs" />)
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
        ariaLabel="Test tabs"
      />,
    )
    expect(screen.getByRole('tablist').className).toBe('tabs tabs--segment task-detail__tab-bar')
  })
})

describe('<TabBar> — badge slot + testids', () => {
  test('badge defaults to the neutral semantic tone inside its tab', () => {
    render(
      <TabBar
        tabs={[
          { key: 'edit', label: 'Edit' },
          { key: 'preview', label: 'Questions', badge: 3 },
        ]}
        active="edit"
        onSelect={() => {}}
        ariaLabel="Test tabs"
      />,
    )
    const tab = screen.getByRole('tab', { name: /Questions/ })
    const badge = tab.querySelector('.tabs__tab-badge')
    expect(badge).not.toBeNull()
    expect(badge?.tagName).toBe('SPAN')
    expect(badge?.textContent).toBe('3')
    expect(badge?.className).toBe('tabs__tab-badge tabs__tab-badge--neutral')
    expect(badge?.getAttribute('data-tone')).toBe('neutral')
  })

  test.each([
    ['attention', '3 pending questions'],
    ['danger', '2 validation errors'],
  ] as const)('%s badge exposes its tone class/data and accessible label', (tone, label) => {
    render(
      <TabBar
        tabs={[
          { key: 'edit', label: 'Edit' },
          {
            key: 'preview',
            label: 'Questions',
            badge: tone === 'attention' ? 3 : 2,
            badgeTone: tone,
            badgeAriaLabel: label,
          },
        ]}
        active="edit"
        onSelect={() => {}}
        ariaLabel="Test tabs"
      />,
    )
    const badge = document.querySelector('.tabs__tab-badge') as HTMLSpanElement
    expect(badge.className).toBe(`tabs__tab-badge tabs__tab-badge--${tone}`)
    expect(badge.dataset.tone).toBe(tone)
    expect(badge.getAttribute('aria-label')).toBe(label)
    expect(screen.getByRole('tab', { name: new RegExp(label) })).toBeTruthy()
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
        ariaLabel="Test tabs"
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
        ariaLabel="Test tabs"
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
        ariaLabel="Test tabs"
      />,
    )
    const badge = screen.getByTestId('tq-tab-badge')
    expect(badge.className).toBe('tabs__tab-badge tabs__tab-badge--neutral')
    expect(badge.textContent).toBe('5')
    // No badge → the badgeTestid is inert (span not rendered at all).
    expect(screen.queryByTestId('never-rendered')).toBeNull()
  })

  test('rootTestid lands on the tablist container; absent by default', () => {
    const { unmount } = render(
      <TabBar
        tabs={TABS}
        active="edit"
        onSelect={() => {}}
        rootTestid="memory-tab-bar"
        ariaLabel="Test tabs"
      />,
    )
    expect(screen.getByTestId('memory-tab-bar')).toBe(screen.getByRole('tablist'))
    unmount()
    render(<TabBar tabs={TABS} active="edit" onSelect={() => {}} ariaLabel="Test tabs" />)
    expect(screen.getByRole('tablist').hasAttribute('data-testid')).toBe(false)
  })
})
