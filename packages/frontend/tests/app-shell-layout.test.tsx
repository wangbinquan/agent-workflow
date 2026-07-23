// RFC-198 PR2 — rendered responsive-shell and focus lifecycle contract.

import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface MockLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string
  children?: ReactNode
  activeOptions?: unknown
  activeProps?: unknown
  search?: Record<string, string> | ((previous: Record<string, unknown>) => unknown)
}

const harness = vi.hoisted(() => ({
  pathname: '/',
  permissionAllowed: true,
  linkClicks: [] as Array<{ to: string; focusedTestId: string | null }>,
  settingsClicks: [] as Array<{ focusedTestId: string | null }>,
}))

function focusedTestId(): string | null {
  return document.activeElement?.getAttribute('data-testid') ?? null
}

vi.mock('@tanstack/react-router', async () => {
  const React = await import('react')
  const Link = React.forwardRef<HTMLAnchorElement, MockLinkProps>(function MockLink(
    {
      to,
      children,
      activeOptions: _activeOptions,
      activeProps: _activeProps,
      search,
      onClick,
      ...anchorProps
    },
    ref,
  ) {
    return React.createElement(
      'a',
      {
        ...anchorProps,
        ref,
        href:
          search !== undefined && typeof search !== 'function'
            ? `${to}?${new URLSearchParams(search).toString()}`
            : to,
        onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
          onClick?.(event)
          if (!event.defaultPrevented) {
            harness.linkClicks.push({ to, focusedTestId: focusedTestId() })
          }
          event.preventDefault()
        },
      },
      children,
    )
  })

  return {
    Link,
    Outlet: () => React.createElement('div', { 'data-testid': 'mock-outlet' }),
    createRootRoute: (options: unknown) => options,
    redirect: (options: unknown) => options,
    useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
      select({ location: { pathname: harness.pathname } }),
  }
})

vi.mock('@/components/UserMenu', async () => {
  const React = await import('react')
  const recordRoute = (to: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    harness.linkClicks.push({ to, focusedTestId: focusedTestId() })
    event.preventDefault()
  }
  return {
    UserMenu: () =>
      React.createElement(
        'div',
        { 'data-testid': 'mock-user-menu' },
        React.createElement('a', { href: '/account', onClick: recordRoute('/account') }, 'Account'),
        React.createElement('a', { href: '/users', onClick: recordRoute('/users') }, 'Users'),
        React.createElement('button', { type: 'button' }, 'Sign out'),
      ),
  }
})

vi.mock('@/components/LanguageSwitch', async () => {
  const React = await import('react')
  return {
    LanguageSwitch: () =>
      React.createElement(
        'button',
        { type: 'button', 'data-testid': 'language-switch' },
        'Language',
      ),
  }
})

vi.mock('@/hooks/useActor', () => ({
  usePermission: () => harness.permissionAllowed,
}))

vi.mock('@/components/shell/SettingsGearButton', async () => {
  const React = await import('react')
  return {
    SettingsGearButton: ({ active }: { active: boolean }) =>
      React.createElement(
        'button',
        {
          type: 'button',
          className: `settings-gear${active ? ' settings-gear--active' : ''}`,
          'aria-label': 'Settings',
          onClick: () => harness.settingsClicks.push({ focusedTestId: focusedTestId() }),
        },
        'Settings',
      ),
  }
})

vi.mock('@/components/shell/InboxFooterButton', async () => {
  const React = await import('react')
  return {
    InboxFooterButton: React.forwardRef<
      HTMLButtonElement,
      { open: boolean; onToggle: () => void; variant?: 'sidebar' | 'compact' }
    >(function MockInboxFooterButton({ open, onToggle, variant = 'sidebar' }, ref) {
      return React.createElement(
        'button',
        {
          ref,
          type: 'button',
          'data-testid': variant === 'compact' ? 'compact-inbox-button' : 'inbox-footer-button',
          'aria-expanded': open,
          onClick: onToggle,
        },
        'Inbox',
      )
    }),
  }
})

vi.mock('@/components/shell/InboxDrawer', async () => {
  const React = await import('react')
  return {
    InboxDrawer: ({ open }: { open: boolean }) =>
      React.createElement('div', {
        'data-testid': 'mock-inbox-drawer',
        'data-open': String(open),
      }),
  }
})

vi.mock('@/components/shell/MemoryPendingBadge', async () => {
  const React = await import('react')
  return {
    MemoryPendingBadge: () =>
      React.createElement(
        'span',
        {
          className: 'nav-item__pending-count',
          title: '2 awaiting review',
        },
        React.createElement(
          'span',
          {
            className: 'sidebar__badge nav-item__badge',
            'data-testid': 'memory-badge',
            'aria-hidden': 'true',
          },
          '2',
        ),
        React.createElement('span', { className: 'sr-only' }, '2 awaiting review'),
      ),
  }
})

import i18n from '../src/i18n'
import { AppShell } from '../src/components/shell/AppShell'
import { RootShell } from '../src/routes/__root'
import { setInboxOpen } from '../src/stores/inbox'

interface MatchMediaController {
  setMatches: (matches: boolean) => void
}

function installMatchMedia(initialMatches: boolean): MatchMediaController {
  let matches = initialMatches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const media = {
    get matches() {
      return matches
    },
    media: '(max-width: 900px)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as MediaQueryList

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  )
  return {
    setMatches(next: boolean) {
      act(() => {
        matches = next
        const event = { matches: next, media: media.media } as MediaQueryListEvent
        for (const listener of listeners) listener(event)
      })
    },
  }
}

function href(href: string): HTMLAnchorElement {
  const link = document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)
  if (link === null) throw new Error(`missing link: ${href}`)
  return link
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  harness.pathname = '/'
  harness.permissionAllowed = true
  harness.linkClicks.length = 0
  harness.settingsClicks.length = 0
  act(() => setInboxOpen(false))
})

afterEach(() => {
  cleanup()
  act(() => setInboxOpen(false))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RFC-198 responsive AppShell', () => {
  // Regression: the Memory label and its pending count used to be separate
  // sibling links, which exposed two click targets and two keyboard stops for
  // one navigation row. The count is now status inside the stable Memory link.
  test('Memory main/default and pending count share exactly one link', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(
      <AppShell pathname="/memory">
        <h1>Memory</h1>
      </AppShell>,
    )

    const main = href('/memory?tab=all')
    const badge = screen.getByTestId('memory-badge')
    expect(main.contains(badge)).toBe(true)
    expect(badge.closest('a')).toBe(main)
    expect(document.querySelectorAll('a[href^="/memory"]')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Memory 2 awaiting review' })).toBe(main)
  })

  test('matchMedia absence falls back to one desktop shell tree', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
      </AppShell>,
    )

    expect(screen.getByTestId('desktop-sidebar')).toBeTruthy()
    expect(screen.queryByTestId('mobile-topbar')).toBeNull()
    expect(screen.getAllByTestId(/shell-navigation-/)).toHaveLength(1)
    expect(screen.getAllByTestId('inbox-footer-button')).toHaveLength(1)
    expect(screen.getAllByTestId('mock-user-menu')).toHaveLength(1)
  })

  test('compact shell mounts the dialog/navigation/footer only while open and focuses active route', async () => {
    installMatchMedia(true)
    render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
      </AppShell>,
    )

    expect(screen.getByTestId('mobile-topbar')).toBeTruthy()
    expect(screen.queryByTestId('desktop-sidebar')).toBeNull()
    expect(screen.queryByTestId('mobile-nav-dialog')).toBeNull()
    expect(screen.queryByTestId('mock-user-menu')).toBeNull()
    expect(screen.getAllByTestId('compact-inbox-button')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('mobile-menu-trigger'))
    expect(screen.getByRole('button', { name: 'Open navigation menu' })).toBeTruthy()
    expect(screen.getByTestId('mobile-nav-dialog')).toBeTruthy()
    expect(screen.getAllByTestId(/shell-navigation-/)).toHaveLength(1)
    expect(screen.getAllByTestId('mock-user-menu')).toHaveLength(1)
    await waitFor(() => expect(document.activeElement).toBe(href('/tasks')))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('mobile-nav-dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('mobile-menu-trigger'))
  })

  test('unknown/detail active fallback gives initial focus to Home', async () => {
    installMatchMedia(true)
    render(
      <AppShell pathname="/reviews/rev_1">
        <h1>Review</h1>
      </AppShell>,
    )

    fireEvent.click(screen.getByTestId('mobile-menu-trigger'))
    await waitFor(() => expect(document.activeElement).toBe(href('/')))
  })

  test('the one-shot navigation handoff does not weaken Dialog focus trapping', async () => {
    installMatchMedia(true)
    render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
        <input aria-label="Outside field" />
      </AppShell>,
    )

    fireEvent.click(screen.getByTestId('mobile-menu-trigger'))
    await waitFor(() => expect(document.activeElement).toBe(href('/tasks')))
    screen.getByRole('textbox', { name: 'Outside field' }).focus()
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  test('mobile route click restores the stable trigger before Link navigation, then focuses committed h1', async () => {
    installMatchMedia(true)
    const view = render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
      </AppShell>,
    )
    const menuTrigger = screen.getByTestId('mobile-menu-trigger')
    fireEvent.click(menuTrigger)

    fireEvent.click(href('/agents'))
    expect(screen.queryByTestId('mobile-nav-dialog')).toBeNull()
    expect(harness.linkClicks.at(-1)).toEqual({
      to: '/agents',
      focusedTestId: 'mobile-menu-trigger',
    })
    // This is also the dirty-guard Stay state: without a committed pathname,
    // focus remains on the stable trigger rather than a removed sheet link.
    expect(document.activeElement).toBe(menuTrigger)

    view.rerender(
      <AppShell pathname="/agents">
        <h1 data-testid="agents-heading">Agents</h1>
      </AppShell>,
    )
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('agents-heading')))
  })

  test('mobile Memory count activates its one parent link and preserves the focus handoff', async () => {
    installMatchMedia(true)
    const view = render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
      </AppShell>,
    )
    const trigger = screen.getByTestId('mobile-menu-trigger')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByTestId('memory-badge'))

    expect(screen.queryByTestId('mobile-nav-dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(harness.linkClicks.at(-1)?.to).toBe('/memory')

    view.rerender(
      <AppShell pathname="/memory">
        <h1 data-testid="memory-heading">Memory</h1>
      </AppShell>,
    )
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('memory-heading')))
  })

  test('blocked navigation pending state cannot focus an unrelated later route', async () => {
    installMatchMedia(true)
    const view = render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
      </AppShell>,
    )
    const trigger = screen.getByTestId('mobile-menu-trigger')
    fireEvent.click(trigger)
    fireEvent.click(href('/agents'))
    expect(document.activeElement).toBe(trigger)

    view.rerender(
      <AppShell pathname="/repos">
        <h1 data-testid="unrelated-heading">Repos</h1>
      </AppShell>,
    )
    await new Promise((resolve) => window.setTimeout(resolve, 5))
    expect(document.activeElement).toBe(trigger)

    view.rerender(
      <AppShell pathname="/agents">
        <h1 data-testid="stale-target-heading">Agents</h1>
      </AppShell>,
    )
    await new Promise((resolve) => window.setTimeout(resolve, 5))
    expect(document.activeElement).toBe(trigger)
  })

  test('modified clicks stay owned by the browser and do not close the sheet', async () => {
    installMatchMedia(true)
    render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
      </AppShell>,
    )
    fireEvent.click(screen.getByTestId('mobile-menu-trigger'))
    await waitFor(() => expect(document.activeElement).toBe(href('/tasks')))

    fireEvent.click(href('/agents'), { metaKey: true })
    expect(screen.getByTestId('mobile-nav-dialog')).toBeTruthy()
  })

  test('compact-to-desktop keeps main stable and only steals focus when an open menu loses its trigger', async () => {
    const media = installMatchMedia(true)
    render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
        <input aria-label="Draft" />
      </AppShell>,
    )
    const main = screen.getByTestId('app-shell-main')
    const draft = screen.getByRole('textbox', { name: 'Draft' })
    draft.focus()

    media.setMatches(false)
    expect(screen.getByTestId('app-shell-main')).toBe(main)
    expect(document.activeElement).toBe(draft)

    media.setMatches(true)
    fireEvent.click(screen.getByTestId('mobile-menu-trigger'))
    media.setMatches(false)
    expect(screen.queryByTestId('mobile-nav-dialog')).toBeNull()
    expect(screen.getByTestId('app-shell-main')).toBe(main)
    await waitFor(() => expect(document.activeElement).toBe(main))
  })

  test('menu and Inbox are mutually exclusive for both trigger and external store opens', () => {
    installMatchMedia(true)
    render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
      </AppShell>,
    )

    fireEvent.click(screen.getByTestId('mobile-menu-trigger'))
    expect(screen.getByTestId('mobile-nav-dialog')).toBeTruthy()
    fireEvent.click(screen.getByTestId('compact-inbox-button'))
    expect(screen.queryByTestId('mobile-nav-dialog')).toBeNull()
    expect(screen.getByTestId('mock-inbox-drawer').getAttribute('data-open')).toBe('true')

    fireEvent.click(screen.getByTestId('mobile-menu-trigger'))
    expect(screen.getByTestId('mobile-nav-dialog')).toBeTruthy()
    expect(screen.getByTestId('mock-inbox-drawer').getAttribute('data-open')).toBe('false')

    act(() => setInboxOpen(true))
    expect(screen.queryByTestId('mobile-nav-dialog')).toBeNull()
    expect(screen.getByTestId('mock-inbox-drawer').getAttribute('data-open')).toBe('true')
  })

  test('mobile footer routes close before navigation while Language stays in the sheet', () => {
    installMatchMedia(true)
    render(
      <AppShell pathname="/tasks">
        <h1>Tasks</h1>
      </AppShell>,
    )
    const trigger = screen.getByTestId('mobile-menu-trigger')

    for (const route of ['/account', '/users']) {
      fireEvent.click(trigger)
      fireEvent.click(href(route))
      expect(screen.queryByTestId('mobile-nav-dialog')).toBeNull()
      expect(harness.linkClicks.at(-1)).toEqual({
        to: route,
        focusedTestId: 'mobile-menu-trigger',
      })
    }

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByTestId('mobile-nav-dialog')).toBeNull()
    expect(harness.settingsClicks.at(-1)).toEqual({ focusedTestId: 'mobile-menu-trigger' })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByTestId('language-switch'))
    expect(screen.getByTestId('mobile-nav-dialog')).toBeTruthy()
  })

  test('settings entry remains permission-gated in both shell modes', () => {
    vi.stubGlobal('matchMedia', undefined)
    harness.permissionAllowed = false
    const view = render(
      <AppShell pathname="/settings">
        <h1>Settings</h1>
      </AppShell>,
    )
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()

    harness.permissionAllowed = true
    view.rerender(
      <AppShell pathname="/settings">
        <h1>Settings</h1>
      </AppShell>,
    )
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
  })
})

describe('RFC-198 root shell branches', () => {
  test('auth, token-null transition, and authenticated branches never expose stale protected children', () => {
    vi.stubGlobal('matchMedia', undefined)
    const protectedChild = <div data-testid="protected-child">protected</div>
    const view = render(
      <RootShell pathname="/auth" token={null}>
        {protectedChild}
      </RootShell>,
    )
    expect(screen.getByTestId('protected-child')).toBeTruthy()
    expect(screen.queryByTestId('route-transition-state')).toBeNull()
    expect(screen.queryByTestId('app-shell-main')).toBeNull()

    view.rerender(
      <RootShell pathname="/tasks" token={null}>
        {protectedChild}
      </RootShell>,
    )
    expect(screen.queryByTestId('protected-child')).toBeNull()
    expect(screen.getByTestId('route-transition-state')).toBeTruthy()
    expect(screen.getByTestId('loading-state').className).toContain('loading-state--compact')

    view.rerender(
      <RootShell pathname="/tasks" token="token">
        {protectedChild}
      </RootShell>,
    )
    expect(screen.getByTestId('protected-child')).toBeTruthy()
    expect(screen.getByTestId('app-shell-main')).toBeTruthy()
    expect(screen.queryByTestId('route-transition-state')).toBeNull()
  })
})
