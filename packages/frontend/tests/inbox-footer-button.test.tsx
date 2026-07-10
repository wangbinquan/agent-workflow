// RFC-032 PR2 InboxFooterButton — locks the badge math + failure-soft
// behaviour of the merged reviews + clarify counters.
//
// Why this test exists: the inbox button is the only entry point to the
// unified drawer; the badge is the only signal a user gets that anything
// is waiting. A regression that drops one feed silently or shows a "0"
// chip would hide pending work. The cases below cover the math
// (`total = reviewsCount + clarifyCount`), the empty-zero hiding, the
// `99+` cap, the both-feeds-failed soft-fail, and the RFC-121 regression
// that awaiting fusions are NOT counted here (they moved to /memory).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import '../src/i18n'
import { InboxFooterButton } from '../src/components/shell/InboxFooterButton'
import { setBaseUrl, setToken } from '../src/stores/auth'

function mockCounts(
  reviews: number | 'error',
  clarify: number | 'error',
  fusion?: number,
  // RFC-164 PR-6: third source — workgroup to-dos. Defaults to 0 so the
  // pre-existing two-source cases keep their exact expectations.
  workgroups: number | 'error' = 0,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    // RFC-121: when a fusion pending-count is mocked, the button must still
    // ignore it (fusions moved to the Memory badge). Unmocked by default.
    if (fusion !== undefined && s.includes('/api/fusions/pending-count')) {
      return new Response(JSON.stringify({ count: fusion }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (s.includes('/api/workgroup-tasks/pending-count')) {
      if (workgroups === 'error') {
        return new Response('{"code":"x"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ deliveries: workgroups, gates: 0, total: workgroups }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (s.includes('/api/reviews/pending-count')) {
      if (reviews === 'error') {
        return new Response('{"code":"x"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ count: reviews }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (s.includes('/api/clarify/pending-count')) {
      if (clarify === 'error') {
        return new Response('{"code":"x"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ count: clarify }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
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
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('RFC-032 InboxFooterButton', () => {
  test('reviews=3 + clarify=3 → badge "6"', async () => {
    mockCounts(3, 3)
    wrap(<InboxFooterButton open={false} onToggle={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-footer-badge').textContent).toBe('6')
    })
  })

  test('reviews=0 + clarify=0 → no badge rendered (button still present)', async () => {
    mockCounts(0, 0)
    wrap(<InboxFooterButton open={false} onToggle={() => {}} />)
    // Drain the queries.
    await waitFor(() => {
      expect(screen.getByTestId('inbox-footer-button')).toBeTruthy()
    })
    // No badge element.
    expect(screen.queryByTestId('inbox-footer-badge')).toBeNull()
  })

  test('count > 99 → "99+" displayed', async () => {
    mockCounts(60, 50)
    wrap(<InboxFooterButton open={false} onToggle={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-footer-badge').textContent).toBe('99+')
    })
  })

  test('all three feeds erroring → button rendered, badge hidden (no throw)', async () => {
    mockCounts('error', 'error', undefined, 'error')
    wrap(<InboxFooterButton open={false} onToggle={() => {}} />)
    // give react-query a tick to settle into the error state.
    await waitFor(() => {
      expect(screen.getByTestId('inbox-footer-button')).toBeTruthy()
    })
    expect(screen.queryByTestId('inbox-footer-badge')).toBeNull()
  })

  test('one feed erroring → badge shows surviving feed only', async () => {
    mockCounts(7, 'error')
    wrap(<InboxFooterButton open={false} onToggle={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-footer-badge').textContent).toBe('7')
    })
  })

  // RFC-121: fusions left the inbox for the /memory page. Even when the
  // fusion pending-count endpoint reports work, this badge must not count it
  // (the sidebar Memory badge carries fusions now). reviews=2 + clarify=1 +
  // fusion=5 → "3", not "8".
  test('awaiting fusions are NOT counted in the inbox badge', async () => {
    mockCounts(2, 1, 5)
    wrap(<InboxFooterButton open={false} onToggle={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-footer-badge').textContent).toBe('3')
    })
  })
})

// RFC-164 PR-6 — workgroup to-dos join the badge as the third source, with
// the same failure-soft merge (any surviving feed still counts).
describe('RFC-164 InboxFooterButton — workgroup third source', () => {
  test('reviews=2 + clarify=1 + workgroups=4 → badge "7"', async () => {
    mockCounts(2, 1, undefined, 4)
    wrap(<InboxFooterButton open={false} onToggle={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-footer-badge').textContent).toBe('7')
    })
  })

  test('workgroup feed erroring → badge shows the surviving two feeds', async () => {
    mockCounts(2, 1, undefined, 'error')
    wrap(<InboxFooterButton open={false} onToggle={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-footer-badge').textContent).toBe('3')
    })
  })

  test('only the workgroup feed surviving → its count still shows', async () => {
    mockCounts('error', 'error', undefined, 5)
    wrap(<InboxFooterButton open={false} onToggle={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-footer-badge').textContent).toBe('5')
    })
  })
})
