// RFC-032 PR2 InboxDrawer — locks the segmented filter, the ESC/outside-
// click dismissal, and row-click navigation behaviour.
//
// Why this test exists: the drawer is the *only* way users reach pending
// reviews / clarify queues from PR2 onward — the standalone list pages
// remain at /reviews + /clarify but the sidebar shortcut now flows
// through here. A regression that breaks segmented filtering, swallows
// ESC, or stops navigating on row click would silently hide half the
// merged queue.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function mockLists(opts: {
  reviews?: Array<Partial<{ nodeRunId: string; taskId: string; title: string; createdAt: number }>>
  clarify?: Array<
    Partial<{
      clarifyNodeRunId: string
      taskId: string
      sourceAgentNodeId: string
      createdAt: number
    }>
  >
}): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    if (s.includes('/api/reviews?status=pending')) {
      const rows = (opts.reviews ?? []).map((r, i) => ({
        nodeRunId: r.nodeRunId ?? `r${i}`,
        taskId: r.taskId ?? 'task_a',
        workflowId: 'wf_1',
        workflowName: 'wf-name',
        reviewNodeId: 'rev_node',
        title: r.title ?? `review ${i}`,
        description: '',
        currentVersionIndex: 1,
        reviewIteration: 0,
        decision: 'awaiting',
        awaitingReview: true,
        shardKey: null,
        createdAt: r.createdAt ?? 1_700_000_000_000 + i * 1000,
        decidedAt: null,
      }))
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (s.includes('/api/clarify?status=awaiting_human')) {
      const rows = (opts.clarify ?? []).map((c, i) => ({
        id: `sess_${i}`,
        taskId: c.taskId ?? 'task_b',
        sourceAgentNodeId: c.sourceAgentNodeId ?? `agent_${i}`,
        sourceShardKey: null,
        clarifyNodeId: 'clarify_node',
        clarifyNodeRunId: c.clarifyNodeRunId ?? `cn${i}`,
        iterationIndex: 0,
        questionCount: 2,
        status: 'awaiting_human',
        createdAt: c.createdAt ?? 1_700_000_500_000 + i * 1000,
        answeredAt: null,
      }))
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('[]', { status: 200 })
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
  navigateSpy.mockReset()
})

afterEach(() => {
  // RTL's auto-cleanup handles the unmount; touching innerHTML directly
  // races React's portal teardown and crashes the next test.
  vi.restoreAllMocks()
})

describe('RFC-032 InboxDrawer', () => {
  test('open=false → renders nothing', () => {
    mockLists({})
    wrap(<InboxDrawer open={false} onClose={() => {}} />)
    expect(screen.queryByTestId('inbox-drawer')).toBeNull()
  })

  test('open=true → portal mounts the drawer with three tabs', async () => {
    mockLists({ reviews: [{ nodeRunId: 'r1' }], clarify: [{ clarifyNodeRunId: 'c1' }] })
    wrap(<InboxDrawer open={true} onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-drawer')).toBeTruthy()
    })
    expect(screen.getByTestId('inbox-tab-all')).toBeTruthy()
    expect(screen.getByTestId('inbox-tab-reviews')).toBeTruthy()
    expect(screen.getByTestId('inbox-tab-clarify')).toBeTruthy()
  })

  test('All tab merges both feeds; Reviews tab filters to reviews only', async () => {
    mockLists({
      reviews: [{ nodeRunId: 'r1' }, { nodeRunId: 'r2' }],
      clarify: [{ clarifyNodeRunId: 'c1' }],
    })
    wrap(<InboxDrawer open={true} onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-row-review-r1')).toBeTruthy()
    })
    // Default = all: 3 rows.
    expect(
      screen.getAllByRole('button').filter((b) => b.className.includes('inbox-drawer__item'))
        .length,
    ).toBe(3)
    // Click reviews → 2 rows.
    fireEvent.click(screen.getByTestId('inbox-tab-reviews'))
    await waitFor(() => {
      expect(screen.queryByTestId('inbox-row-clarify-c1')).toBeNull()
    })
    expect(
      screen.getAllByRole('button').filter((b) => b.className.includes('inbox-drawer__item'))
        .length,
    ).toBe(2)
  })

  test('clicking a review row triggers navigate to /reviews/$nodeRunId', async () => {
    mockLists({ reviews: [{ nodeRunId: 'r99' }] })
    wrap(<InboxDrawer open={true} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId('inbox-row-review-r99'))
    fireEvent.click(screen.getByTestId('inbox-row-review-r99'))
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/reviews/$nodeRunId',
      params: { nodeRunId: 'r99' },
    })
  })

  test('clicking a clarify row triggers navigate to /clarify/$nodeRunId', async () => {
    mockLists({ clarify: [{ clarifyNodeRunId: 'cn-42' }] })
    wrap(<InboxDrawer open={true} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId('inbox-row-clarify-cn-42'))
    fireEvent.click(screen.getByTestId('inbox-row-clarify-cn-42'))
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/clarify/$nodeRunId',
      params: { nodeRunId: 'cn-42' },
    })
  })

  test('ESC closes the drawer', async () => {
    mockLists({})
    const onClose = vi.fn()
    wrap(<InboxDrawer open={true} onClose={onClose} />)
    await waitFor(() => screen.getByTestId('inbox-drawer'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  test('outside click closes; click inside does not', async () => {
    mockLists({})
    const onClose = vi.fn()
    const extra = document.createElement('div')
    extra.setAttribute('data-testid', 'outside')
    document.body.appendChild(extra)
    wrap(<InboxDrawer open={true} onClose={onClose} />)
    await waitFor(() => screen.getByTestId('inbox-drawer'))
    // Inside click — should not close.
    fireEvent.mouseDown(screen.getByTestId('inbox-drawer'))
    expect(onClose).not.toHaveBeenCalled()
    // Outside click — should close.
    fireEvent.mouseDown(extra)
    expect(onClose).toHaveBeenCalled()
  })

  test('empty queues render the empty hint', async () => {
    mockLists({ reviews: [], clarify: [] })
    wrap(<InboxDrawer open={true} onClose={() => {}} />)
    await waitFor(() => {
      // i18n string in en-US bundle.
      const drawer = screen.getByTestId('inbox-drawer')
      expect(drawer.textContent ?? '').toMatch(/Nothing waiting|当前没有/)
    })
  })
})
