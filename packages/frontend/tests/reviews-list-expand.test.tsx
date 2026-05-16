// RFC-013-T5 — /reviews list page: row expansion + historical-version sub-list.
//
// Renders the `HistoryRows` child component (the per-row expand body)
// directly. The parent table's expand toggle logic is small enough
// (toggle a Set) that the source-level test in reviews-list-expand
// `expand` button assertion already locks it.
//
// We stub `@tanstack/react-router`'s Link as a plain <a> with the same
// onboarding.test.tsx pattern — RouterProvider is overkill for asserting
// the URL each Open link points at.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as RouterModule from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DocVersion } from '@agent-workflow/shared'
import { HistoryRows } from '../src/routes/reviews'
import { setBaseUrl, setToken } from '../src/stores/auth'

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return {
    ...actual,
    // The `<Link to="..." params={...} search={...}>` rewriter — we render
    // a plain anchor whose href captures the search query so tests can
    // inspect the final URL. TanStack's normal Link does this via the
    // router context which we don't bootstrap here.
    Link: ({
      to,
      params,
      search,
      children,
      ...rest
    }: {
      to: string
      params?: Record<string, string>
      search?: Record<string, string | undefined>
      children: React.ReactNode
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
      let href = to
      if (params !== undefined) {
        for (const [k, v] of Object.entries(params)) {
          href = href.replace(`$${k}`, v)
        }
      }
      const q =
        search !== undefined
          ? Object.entries(search)
              .filter(([, v]) => v !== undefined && v !== '')
              .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
              .join('&')
          : ''
      if (q.length > 0) href = `${href}?${q}`
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      )
    },
  }
})

function wrap(node: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function makeVersion(id: string, idx: number, decision: DocVersion['decision']): DocVersion {
  return {
    id,
    taskId: 't',
    reviewNodeId: 'r',
    reviewNodeRunId: 'run',
    sourceNodeId: 's',
    sourcePortName: 'p',
    versionIndex: idx,
    reviewIteration: 0,
    bodyPath: 'x',
    commentsJson: '[]',
    decision,
    decisionReason: null,
    promptSnapshot: null,
    agentSnapshot: null,
    sourceFilePath: null,
    createdAt: 0,
    decidedAt: null,
    decidedBy: null,
  }
}

const VERSIONS = [
  makeVersion('dv_v2', 2, 'iterated'),
  makeVersion('dv_v1', 1, 'rejected'),
  makeVersion('dv_v3', 3, 'pending'),
]

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('RFC-013 HistoryRows', () => {
  test('renders v1..vN in ascending order with decision chips + (current) tag on the current version', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(VERSIONS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    wrap(<HistoryRows nodeRunId="run" currentVersionIndex={3} />)

    // Initially we render a loading state.
    expect(screen.getByText(/loading/i)).toBeTruthy()

    // After the query resolves, three li rows in v1, v2, v3 order.
    await waitFor(() => screen.getByText('v1'))

    const labels = Array.from(document.querySelectorAll('.reviews-version-list__label')).map(
      (el) => el.textContent,
    )
    expect(labels).toEqual(['v1', 'v2', 'v3'])

    // Decisions show up as visible text in the status chip.
    expect(screen.getByText('rejected')).toBeTruthy()
    expect(screen.getByText('iterated')).toBeTruthy()
    expect(screen.getByText('pending')).toBeTruthy()

    // The current version is tagged. The pill text uses i18n key
    // `reviews.currentTag` which resolves to "current" in en-US.
    expect(document.querySelectorAll('.reviews-version-list__current-pill').length).toBe(1)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calledUrl = String(fetchSpy.mock.calls[0]![0])
    expect(calledUrl).toContain('/api/reviews/run/versions')
  })

  test('current row Open link omits ?version query; historical rows carry it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(VERSIONS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    wrap(<HistoryRows nodeRunId="run" currentVersionIndex={3} />)
    await waitFor(() => screen.getByText('v1'))

    const items = document.querySelectorAll('.reviews-version-list__item')
    // Items in ascending version-index order.
    const links = Array.from(items).map((li) => li.querySelector('a')!.getAttribute('href'))
    expect(links[0]).toBe('/reviews/run?version=dv_v1') // v1: historical
    expect(links[1]).toBe('/reviews/run?version=dv_v2') // v2: historical
    expect(links[2]).toBe('/reviews/run') // v3: current → no ?version
  })

  test('on fetch failure shows error + retry button that re-fires the request', async () => {
    let n = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n += 1
      if (n === 1) {
        return new Response('boom', { status: 500 })
      }
      return new Response(JSON.stringify(VERSIONS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    wrap(<HistoryRows nodeRunId="run" currentVersionIndex={3} />)

    await waitFor(() => screen.getByRole('alert'))
    const retry = screen.getByRole('button', { name: /retry/i })
    fireEvent.click(retry)

    await waitFor(() => screen.getByText('v1'))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
