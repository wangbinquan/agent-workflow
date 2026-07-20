// RFC-211 — the guided tour page.
//
// What these lock:
//   - the tour is reachable and self-describing without any data (a brand-new
//     install has no runs, no resources, and no runtime configured);
//   - "build it for me" goes through the server rather than composing resources
//     in the browser — that is what keeps the private/example/owner invariants
//     in one place;
//   - cleanup NEVER fires without an explicit confirmation that first shows
//     what is about to be deleted. It is the most destructive button in the
//     product and it deletes tasks, workspaces and run logs along with rows.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setBaseUrl, setToken } from '../src/stores/auth'

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
  permissions: ['agents:write', 'skills:write', 'workflows:write'],
}

/**
 * Route-aware fetch stub; anything unmatched returns []. `/api/auth/me` is
 * always answered because the page asks who you are before deciding whether to
 * show the admin-only instance-wide sweep.
 */
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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

async function renderGuide() {
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
  // No manual `document.body.innerHTML = ''` here: the shared setup already
  // calls testing-library's cleanup(), and wiping innerHTML underneath a
  // portal-mounted Dialog makes React's own unmount throw removeChild.
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('RFC-211 guided tour page', () => {
  test('renders through the shared page header and offers all four tracks', async () => {
    stubFetch([{ match: /\/api\/onboarding\/runs/, body: [] }])
    const { container } = await renderGuide()
    await waitFor(() => expect(screen.getByTestId('guide-page')).toBeTruthy())
    expect(container.querySelector('.page__header--row')).toBeTruthy()
    for (const track of ['agent', 'skill', 'workflow', 'workgroup']) {
      expect(screen.getByTestId(`guide-track-${track}`)).toBeTruthy()
    }
  })

  test('the sandbox warning is present before anything is created', async () => {
    // Users build real resources here and later wipe them in one click. Saying
    // so up front is the only thing standing between "practice material" and
    // "I lost work".
    stubFetch([{ match: /\/api\/onboarding\/runs/, body: [] }])
    await renderGuide()
    await waitFor(() => expect(screen.getByTestId('guide-sandbox-notice')).toBeTruthy())
  })

  test('picking a track then Start POSTs a run', async () => {
    const spy = stubFetch([
      { match: /\/api\/onboarding\/runs$/, body: [] },
      { match: /\/api\/onboarding\/runs/, body: RUN },
    ])
    await renderGuide()
    fireEvent.click(await screen.findByTestId('guide-track-agent'))
    fireEvent.click(screen.getByTestId('guide-start'))
    await waitFor(() => {
      const posts = spy.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      )
      expect(posts.length).toBe(1)
      expect(String(posts[0]![0])).toContain('/api/onboarding/runs')
      expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({ track: 'agent' })
    })
  })

  test('"build it for me" calls the server, never composes resources client-side', async () => {
    const spy = stubFetch([
      { match: /\/api\/onboarding\/runs$/, body: [RUN] },
      { match: /provision/, body: { ...RUN, step: 'agent.create' } },
    ])
    await renderGuide()
    fireEvent.click(await screen.findByTestId('guide-track-agent'))
    const build = await screen.findByTestId('guide-provision')
    fireEvent.click(build)
    await waitFor(() => {
      expect(spy.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/provision'))).toBe(
        true,
      )
      // If the page ever composed resources itself, a write to the ordinary
      // resource endpoints would show up here. (It does GET /api/agents — that
      // is the adopt picker listing what you already own.)
      const resourceWrites = spy.mock.calls.filter(
        (c) =>
          /\/api\/(agents|skills|workflows|workgroups)/.test(String(c[0])) &&
          ((c[1] as RequestInit | undefined)?.method ?? 'GET') !== 'GET',
      )
      expect(resourceWrites).toEqual([])
    })
  })

  test('"I\'ll do it myself" deep-links to the real create form', async () => {
    stubFetch([{ match: /\/api\/onboarding\/runs$/, body: [RUN] }])
    await renderGuide()
    fireEvent.click(await screen.findByTestId('guide-track-agent'))
    const link = await screen.findByTestId('guide-self-serve')
    expect(link.getAttribute('href')).toBe('/agents/new')
  })

  test('cleanup requires confirmation and shows what will be deleted first', async () => {
    const spy = stubFetch([
      { match: /\/api\/onboarding\/runs$/, body: [RUN] },
      {
        match: /\/api\/onboarding\/examples/,
        body: {
          scope: 'mine',
          entries: [
            {
              resourceType: 'agent',
              resourceId: 'a1',
              resourceName: 'guide-coder-abcd1234',
              ownerUserId: 'u1',
            },
          ],
        },
      },
    ])
    await renderGuide()
    fireEvent.click(await screen.findByTestId('guide-cleanup'))

    // The preview must be on screen BEFORE the destructive call is possible.
    await waitFor(() => expect(screen.getByTestId('guide-cleanup-preview')).toBeTruthy())
    expect(screen.getByText('guide-coder-abcd1234')).toBeTruthy()
    const deletes = spy.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(deletes).toEqual([])
  })

  test('confirming cleanup sends the scoped DELETE', async () => {
    const spy = stubFetch([
      { match: /\/api\/onboarding\/runs$/, body: [RUN] },
      { match: /\/api\/onboarding\/examples/, body: { scope: 'mine', entries: [] } },
    ])
    await renderGuide()
    fireEvent.click(await screen.findByTestId('guide-cleanup'))
    const confirm = await screen.findByRole('button', { name: /Delete them|确认清除/ })
    fireEvent.click(confirm)
    await waitFor(() => {
      const deletes = spy.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      )
      expect(deletes.length).toBe(1)
      expect(String(deletes[0]![0])).toContain('scope=mine')
    })
  })
})
