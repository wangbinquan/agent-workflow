// RFC-211 §12 — the guided-tour launcher.
//
// The page is now just a menu of learning flows: pick one, the spotlight tour
// walks you through the real screens. The old "example sandbox" (build-it-for-me
// / adopt / cleanup) was removed — the tour builds real resources, no example
// concept. These lock the launcher, the homepage invitation, and the bundle-wide
// "no literal markdown in plain-text copy" rule (caught in a real browser).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { TourProvider } from '../src/components/tour/SpotlightTour'

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({
      to,
      children,
      ...rest
    }: {
      to: string
      children: React.ReactNode
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }
})

interface RouteJson {
  match: RegExp
  body: unknown
  status?: number
}

const ME = {
  user: { id: 'u1', username: 'u1', displayName: 'u1', role: 'user', status: 'active' },
  permissions: ['agents:write'],
}

function stubFetch(routes: RouteJson[]) {
  const all = [...routes, { match: /\/api\/auth\/me/, body: ME }]
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) => {
    const url = String(input)
    const hit = all.find((r) => r.match.test(url))
    const body = hit === undefined ? [] : hit.body
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: hit?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch)
}

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  // The launcher (and the spotlight overlay it starts) live under a TourProvider,
  // mounted app-wide in RootShell.
  return render(
    <QueryClientProvider client={qc}>
      <TourProvider pathname="/onboarding">{node}</TourProvider>
    </QueryClientProvider>,
  )
}

async function renderLauncher() {
  const { Route } = await import('../src/routes/onboarding')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Comp = (Route.options as any).component as React.ComponentType
  return wrap(<Comp />)
}

const RUN = {
  id: '01JGUIDE0000000000000000AA',
  track: 'agent',
  status: 'active',
  currentStep: 'agent.create',
  completedSteps: [],
  suffix: 'abcd1234',
  artifacts: [],
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('RFC-211 guide copy', () => {
  test('no bundle leaks literal markdown into plain-text components', async () => {
    // Caught in a real browser: a banner shipped `**your own practice material**`
    // and NoticeBanner renders plain text, so the asterisks showed up verbatim.
    // Nothing markdown-renders i18n copy, so this is a bundle-wide rule.
    const [{ zhCN }, { enUS }] = await Promise.all([
      import('../src/i18n/zh-CN'),
      import('../src/i18n/en-US'),
    ])
    const offenders: string[] = []
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (node.includes('**')) offenders.push(`${path}: ${node.slice(0, 60)}`)
        return
      }
      if (node !== null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path === '' ? k : `${path}.${k}`)
      }
    }
    walk(zhCN, '')
    walk(enUS, '')
    expect(offenders).toEqual([])
  })
})

describe('RFC-211 homepage invitation', () => {
  test('a user who has never taken the tour is invited; one who has is not', async () => {
    // The first-run screen is INSTANCE-level (empty agents AND workflows), so the
    // second person to join a populated team would never be offered the tour. This
    // prompt is keyed off the current user's own history instead.
    const { HomepageGreeting } = await import('../src/components/home/HomepageGreeting')
    const HERO = [
      {
        match: /\/api\/overview/,
        body: {
          resources: {
            agents: 0,
            skills: 0,
            mcps: 0,
            plugins: 0,
            workflows: 0,
            workgroups: 0,
            repos: 0,
            scheduled: 0,
            memories: 0,
          },
          tasks: { running: 0, awaiting: 0, done7d: 0, failed7d: 0 },
          generatedAt: '2026-07-20T00:00:00.000Z',
        },
      },
      { match: /\/api\/runtimes\/status/, body: { runtimes: [] } },
    ]

    stubFetch([...HERO, { match: /\/api\/onboarding\/runs/, body: [] }])
    const first = wrap(<HomepageGreeting />)
    await waitFor(() => expect(screen.getByTestId('homepage-guide-prompt')).toBeTruthy())
    expect(screen.getByTestId('homepage-guide-prompt-cta').getAttribute('href')).toBe('/onboarding')
    first.unmount()

    vi.restoreAllMocks()
    stubFetch([...HERO, { match: /\/api\/onboarding\/runs/, body: [RUN] }])
    wrap(<HomepageGreeting />)
    await waitFor(() => expect(screen.getByTestId('homepage-start-task')).toBeTruthy())
    expect(screen.queryByTestId('homepage-guide-prompt')).toBeNull()
  })
})

describe('RFC-211 guided tour launcher', () => {
  test('renders through the shared page header and offers the three learning flows', async () => {
    stubFetch([])
    const { container } = await renderLauncher()
    await waitFor(() => expect(screen.getByTestId('guide-page')).toBeTruthy())
    expect(container.querySelector('.page__header--row')).toBeTruthy()
    for (const id of ['first-task', 'build-workflow', 'use-workgroup']) {
      expect(screen.getByTestId(`guide-flow-${id}`)).toBeTruthy()
    }
  })

  test('starting a flow launches the spotlight tour in place — no navigation', async () => {
    stubFetch([])
    await renderLauncher()
    fireEvent.click(await screen.findByTestId('guide-start-first-task'))
    // The overlay renders (dimmed page + bubble); the page did not navigate away.
    expect(screen.getByTestId('spotlight-tour-bubble')).toBeTruthy()
    expect(screen.getByTestId('guide-page')).toBeTruthy()
  })

  test('the tour writes nothing by itself — the menu is inert until you start', async () => {
    // The launcher no longer POSTs to build example resources; picking a flow just
    // starts the client-side spotlight overlay.
    const spy = stubFetch([])
    await renderLauncher()
    await waitFor(() => expect(screen.getByTestId('guide-flows')).toBeTruthy())
    const writes = spy.mock.calls.filter(
      (c) => ((c[1] as RequestInit | undefined)?.method ?? 'GET') !== 'GET',
    )
    expect(writes).toEqual([])
  })
})
