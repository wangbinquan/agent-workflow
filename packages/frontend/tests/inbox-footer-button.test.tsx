// RFC-032 PR2 InboxFooterButton — locks the badge math + failure-soft
// behaviour of the merged reviews + clarify counters.
//
// Why this test exists: the inbox button is the only entry point to the
// unified drawer; the badge is the only signal a user gets that anything
// is waiting. A regression that drops one feed silently or shows a "0"
// chip would hide pending work. The four cases below cover the math
// (`total = reviewsCount + clarifyCount`), the empty-zero hiding, the
// `99+` cap, and the both-feeds-failed soft-fail.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import '../src/i18n'
import { InboxFooterButton } from '../src/components/shell/InboxFooterButton'
import { setBaseUrl, setToken } from '../src/stores/auth'

function mockCounts(reviews: number | 'error', clarify: number | 'error') {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
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

  test('both feeds erroring → button rendered, badge hidden (no throw)', async () => {
    mockCounts('error', 'error')
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
})
