// RFC-164 PR-6 — the InboxDrawer's workgroup to-dos row (third source).
//
// The pending-count endpoint is count-only (no per-item rows), so the drawer
// renders ONE summary row: kind chip + total + deliveries/gates breakdown,
// clicking navigates to the tasks list (each room owns its actionable
// cards). Locks: render-when-positive, hidden-when-zero, failure-soft error
// row that leaves the reviews/clarify lists alone, and the navigation.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const navigateSpy = vi.fn()

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  }
})

// Imported AFTER vi.mock so the mock is bound.
import { InboxDrawer } from '../src/components/shell/InboxDrawer'

function mockFeeds(opts: {
  wg?: { deliveries: number; gates: number; total: number } | 'error'
  reviews?: unknown[]
  clarify?: unknown[]
}): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (s.includes('/api/workgroup-tasks/pending-count')) {
      if (opts.wg === 'error') return json({ code: 'x', message: 'boom' }, 500)
      return json(opts.wg ?? { deliveries: 0, gates: 0, total: 0 })
    }
    if (s.includes('/api/reviews?status=pending')) return json(opts.reviews ?? [])
    if (s.includes('/api/clarify?status=awaiting_human')) return json(opts.clarify ?? [])
    return json({})
  })
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <InboxDrawer open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  navigateSpy.mockReset()
})

afterEach(() => {
  // Unmount React BEFORE clearing the body — the drawer portals into
  // document.body and blowing the DOM away first makes React's portal
  // removal throw (happy-dom removeChild DOMException).
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('InboxDrawer — workgroup to-dos row', () => {
  test('renders the summary row with the deliveries/gates breakdown when total > 0', async () => {
    mockFeeds({ wg: { deliveries: 2, gates: 1, total: 3 } })
    wrap()
    const row = await screen.findByTestId('inbox-row-workgroups')
    expect(row.textContent).toContain('3 workgroup to-do(s)')
    expect(screen.getByTestId('inbox-row-workgroups-breakdown').textContent).toBe(
      '2 to deliver · 1 to confirm',
    )
  })

  test('clicking the row navigates to the tasks list', async () => {
    mockFeeds({ wg: { deliveries: 1, gates: 0, total: 1 } })
    wrap()
    fireEvent.click(await screen.findByTestId('inbox-row-workgroups'))
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith({ to: '/tasks' })
    })
  })

  test('zero to-dos → no row (and the empty state may show)', async () => {
    mockFeeds({ wg: { deliveries: 0, gates: 0, total: 0 } })
    wrap()
    await screen.findByTestId('inbox-drawer')
    await waitFor(() => {
      expect(screen.queryByTestId('inbox-row-workgroups')).toBeNull()
    })
  })

  test('failure-soft: a broken workgroup feed shows its error row, reviews/clarify still render', async () => {
    mockFeeds({
      wg: 'error',
      reviews: [
        {
          nodeRunId: 'r1',
          taskId: 'task_a',
          taskName: 'my-task',
          workflowId: 'wf',
          workflowName: 'wf-name',
          reviewNodeId: 'n',
          title: 'review me',
          description: '',
          currentVersionIndex: 1,
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    wrap()
    // The wg error row appears…
    await screen.findByText('Failed to load workgroup to-dos')
    // …while the surviving review row still lists.
    await screen.findByTestId('inbox-row-review-r1')
    expect(screen.queryByTestId('inbox-row-workgroups')).toBeNull()
  })

  test('hidden on the reviews/clarify tabs (all-tab summary only)', async () => {
    mockFeeds({ wg: { deliveries: 2, gates: 0, total: 2 } })
    wrap()
    await screen.findByTestId('inbox-row-workgroups')
    fireEvent.click(screen.getByTestId('inbox-tab-reviews'))
    expect(screen.queryByTestId('inbox-row-workgroups')).toBeNull()
    fireEvent.click(screen.getByTestId('inbox-tab-all'))
    await screen.findByTestId('inbox-row-workgroups')
  })
})
