// RFC-190 — CapabilityGrid: the homepage's six capability tiles.
//
// Why this test exists: the tiles are the "platform capability map" — a
// regression that drops a tile, breaks a link target (especially the /memory
// ?tab=all deep-link whose count must match its landing view), renders 0
// instead of "—" for permission-null counts, or makes the Onboarding intro
// variant fire network requests would quietly gut RFC-190's core promise.
// Also locks the Card `to` extension (link root keeps the .card chrome).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return {
    ...actual,
    // Render search params as a data-attr so href + search are both assertable.
    Link: ({
      to,
      search,
      children,
      ...rest
    }: {
      to: string
      search?: Record<string, string>
      children: React.ReactNode
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a
        href={to}
        data-search={search === undefined ? undefined : JSON.stringify(search)}
        {...rest}
      >
        {children}
      </a>
    ),
    useNavigate: () => vi.fn(),
  }
})

import { CapabilityGrid } from '../src/components/home/CapabilityGrid'

const HEALTHY = {
  resources: {
    agents: 4,
    skills: 2,
    mcps: 1,
    plugins: 0,
    workflows: 3,
    workgroups: 1,
    repos: 2,
    scheduled: 1,
    memories: 5,
  },
  tasks: { running: 1, awaiting: 2, done7d: 4, failed7d: 1 },
  generatedAt: '2026-07-15T00:00:00.000Z',
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function mockOverview(body: unknown = HEALTHY, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    if (s.includes('/api/overview')) {
      if (status !== 200) {
        return new Response(JSON.stringify({ code: 'boom', message: 'boom' }), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      }
      return json(body)
    }
    return json([])
  })
}

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RFC-190 CapabilityGrid', () => {
  test('renders all six tiles with live counts and the right link targets', async () => {
    mockOverview()
    wrap(<CapabilityGrid />)
    // The count node exists from first paint with the "—" placeholder —
    // wait for the fetched VALUE, not the element.
    await waitFor(() => {
      expect(screen.getByTestId('home-cap-agents-count').textContent).toBe('4')
    })
    const targets: Array<[string, string]> = [
      ['home-cap-agents', '/agents'],
      ['home-cap-workflows', '/workflows'],
      ['home-cap-workgroups', '/workgroups'],
      ['home-cap-memory', '/memory'],
      ['home-cap-scheduled', '/scheduled'],
      ['home-cap-repos', '/repos'],
    ]
    for (const [testid, href] of targets) {
      const tile = screen.getByTestId(testid)
      expect(tile.tagName.toLowerCase()).toBe('a')
      expect(tile.getAttribute('href')).toBe(href)
      // Card `to` root keeps the shared card chrome — no forked chrome class.
      expect(tile.className).toContain('card')
      expect(tile.className).toContain('card--interactive')
    }
    // The memory tile deep-links to the tab whose default view is the
    // approved pool the count reflects (design gate P2-6).
    expect(screen.getByTestId('home-cap-memory').getAttribute('data-search')).toBe(
      JSON.stringify({ tab: 'all' }),
    )
    expect(screen.getByTestId('home-cap-workflows-count').textContent).toBe('3')
    expect(screen.getByTestId('home-cap-repos-count').textContent).toBe('2')
  })

  test('null count (missing coarse permission) renders an em-dash, not 0', async () => {
    mockOverview({
      ...HEALTHY,
      resources: { ...HEALTHY.resources, repos: null },
    })
    wrap(<CapabilityGrid />)
    // Wait for the fetched values first (agents lands as a number), then the
    // permission-null repos count must STILL be the em-dash.
    await waitFor(() => {
      expect(screen.getByTestId('home-cap-agents-count').textContent).toBe('4')
    })
    expect(screen.getByTestId('home-cap-repos-count').textContent).toBe('—')
  })

  test('agents tile secondary line joins skills/mcps/plugins parts', async () => {
    mockOverview()
    wrap(<CapabilityGrid />)
    const sub = await screen.findByTestId('home-cap-agents-sub')
    expect(sub.textContent ?? '').toMatch(/2/)
    expect(sub.textContent ?? '').toMatch(/·/)
  })

  test('agents secondary line disappears when all three member counts are null', async () => {
    mockOverview({
      ...HEALTHY,
      resources: { ...HEALTHY.resources, skills: null, mcps: null, plugins: null },
    })
    wrap(<CapabilityGrid />)
    await waitFor(() => {
      expect(screen.getByTestId('home-cap-agents-count').textContent).toBe('4')
    })
    expect(screen.queryByTestId('home-cap-agents-sub')).toBeNull()
  })

  test('intro variant renders tiles without counts and fires NO overview request', async () => {
    const spy = mockOverview()
    wrap(<CapabilityGrid variant="intro" />)
    expect(await screen.findByTestId('home-cap-agents')).toBeTruthy()
    expect(screen.queryByTestId('home-cap-agents-count')).toBeNull()
    const overviewCalls = spy.mock.calls.filter((c) => String(c[0]).includes('/api/overview'))
    expect(overviewCalls.length).toBe(0)
  })

  test('fetch failure degrades to em-dashes + a retry row (page not blocked)', async () => {
    mockOverview(undefined, 500)
    wrap(<CapabilityGrid />)
    // The retry row only appears once the query settles into error state.
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByTestId('home-cap-agents-count').textContent).toBe('—')
  })
})
