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
      id: string
      // RFC-058: legacy alias names kept on the test mock surface for
      // readability of older test cases; mapped to the new unified shape below.
      clarifyNodeRunId: string
      clarifyNodeId: string
      clarifyNodeTitle: string | null
      taskId: string
      sourceAgentNodeId: string
      sourceAgentNodeTitle: string | null
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
        taskName: 'fixture-task',
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
        id: c.id ?? `sess_${i}`,
        taskId: c.taskId ?? 'task_b',
        taskName: 'fixture-task',
        kind: 'self' as const,
        askingNodeId: c.sourceAgentNodeId ?? `agent_${i}`,
        askingNodeTitle: c.sourceAgentNodeTitle === undefined ? null : c.sourceAgentNodeTitle,
        askingShardKey: null,
        intermediaryNodeId: c.clarifyNodeId ?? 'clarify_node',
        intermediaryNodeTitle: c.clarifyNodeTitle === undefined ? null : c.clarifyNodeTitle,
        intermediaryNodeRunId: c.clarifyNodeRunId ?? `cn${i}`,
        targetConsumerNodeId: null,
        loopIter: 0,
        iteration: 0,
        questionCount: 2,
        status: 'awaiting_human' as const,
        directive: null,
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
    mockLists({
      reviews: [{ nodeRunId: 'r1' }],
      clarify: [{ id: 'c1', clarifyNodeRunId: 'c1' }],
    })
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
      clarify: [{ id: 'c1', clarifyNodeRunId: 'c1' }],
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
    mockLists({ clarify: [{ id: 'cn-42', clarifyNodeRunId: 'cn-42' }] })
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

  // RFC-037 follow-up: a clarify row's *identity* is the clarify node
  // itself — that's what the row's open target navigates to and what the
  // clarify list + detail pages display. Title fallback order:
  // clarifyNodeTitle → clarifyNodeId. The source-agent attribution moves
  // into the subtitle so users still know which agent is asking.
  test('clarify row title uses clarifyNodeTitle when set; subtitle carries source-agent label', async () => {
    mockLists({
      clarify: [
        {
          id: 'cn-titled',
          clarifyNodeRunId: 'cn-titled',
          clarifyNodeId: 'clarify_db',
          clarifyNodeTitle: 'Ask user about the DB',
          sourceAgentNodeId: 'agent_xy_01',
          sourceAgentNodeTitle: 'Implementation Coder',
        },
      ],
    })
    wrap(<InboxDrawer open={true} onClose={() => {}} />)
    const row = await screen.findByTestId('inbox-row-clarify-cn-titled')
    expect(row.textContent ?? '').toContain('Ask user about the DB')
    // Source agent still surfaces as supporting context in the subtitle.
    expect(row.textContent ?? '').toContain('Implementation Coder')
    // The clarify node id is not in the row text (avoid double-rendering it).
    expect(row.textContent ?? '').not.toContain('clarify_db')
  })

  test('clarify row title falls back to clarifyNodeId when clarifyNodeTitle is null', async () => {
    mockLists({
      clarify: [
        {
          id: 'cn-untitled',
          clarifyNodeRunId: 'cn-untitled',
          clarifyNodeId: 'clarify_legacy',
          clarifyNodeTitle: null,
          sourceAgentNodeId: 'agent_legacy_99',
          sourceAgentNodeTitle: null,
        },
      ],
    })
    wrap(<InboxDrawer open={true} onClose={() => {}} />)
    const row = await screen.findByTestId('inbox-row-clarify-cn-untitled')
    expect(row.textContent ?? '').toContain('clarify_legacy')
    // The raw source-agent id still appears in the subtitle when its title
    // is unavailable — keeps the row debuggable for older snapshots.
    expect(row.textContent ?? '').toContain('agent_legacy_99')
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

  // Regression: the drawer was originally PR2's only entry into the
  // pending queue, and the standalone /reviews + /clarify pages — which
  // surface historical / approved / rejected / answered rows the drawer
  // intentionally hides — became unreachable from the sidebar once the
  // separate nav items were removed. The drawer now carries explicit
  // footer links to both list pages.
  test('footer surfaces View-all entries for both /reviews and /clarify', async () => {
    mockLists({ reviews: [], clarify: [] })
    const onClose = vi.fn()
    wrap(<InboxDrawer open={true} onClose={onClose} />)
    await waitFor(() => screen.getByTestId('inbox-drawer'))
    expect(screen.getByTestId('inbox-drawer-open-reviews')).toBeTruthy()
    expect(screen.getByTestId('inbox-drawer-open-clarify')).toBeTruthy()
  })

  test('clicking View-all reviews navigates to /reviews and closes the drawer', async () => {
    mockLists({ reviews: [], clarify: [] })
    const onClose = vi.fn()
    wrap(<InboxDrawer open={true} onClose={onClose} />)
    await waitFor(() => screen.getByTestId('inbox-drawer'))
    fireEvent.click(screen.getByTestId('inbox-drawer-open-reviews'))
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/reviews' })
    expect(onClose).toHaveBeenCalled()
  })

  test('clicking View-all clarify navigates to /clarify and closes the drawer', async () => {
    mockLists({ reviews: [], clarify: [] })
    const onClose = vi.fn()
    wrap(<InboxDrawer open={true} onClose={onClose} />)
    await waitFor(() => screen.getByTestId('inbox-drawer'))
    fireEvent.click(screen.getByTestId('inbox-drawer-open-clarify'))
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/clarify' })
    expect(onClose).toHaveBeenCalled()
  })

  // Regression for the "switching tabs leaves stale clarify rows" bug
  // reported in production: the backend can legitimately return several
  // `awaiting_human` clarify sessions that share a `clarifyNodeRunId`
  // (loop iterations / retries on the same node). The drawer originally
  // used `clarifyNodeRunId` for the React `key`, which produced duplicate
  // keys and broke reconciliation — clicking the Reviews tab after the
  // Clarify tab would leave the clarify rows in the DOM instead of
  // filtering them out. Lock in: keys are session-id based and tab
  // switches correctly remove the other kind.
  test('clarify sessions sharing a clarifyNodeRunId all render and tab filter still works', async () => {
    mockLists({
      reviews: [{ nodeRunId: 'r1' }],
      clarify: [
        { id: 'sess_x', clarifyNodeRunId: 'shared_nrun' },
        { id: 'sess_y', clarifyNodeRunId: 'shared_nrun' },
        { id: 'sess_z', clarifyNodeRunId: 'shared_nrun' },
      ],
    })
    wrap(<InboxDrawer open={true} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId('inbox-row-review-r1'))
    // All three clarify sessions render under their session ids despite
    // sharing the node-run id — proves keys are session-unique.
    expect(screen.getByTestId('inbox-row-clarify-sess_x')).toBeTruthy()
    expect(screen.getByTestId('inbox-row-clarify-sess_y')).toBeTruthy()
    expect(screen.getByTestId('inbox-row-clarify-sess_z')).toBeTruthy()
    // Default = all: 1 review + 3 clarify = 4 rows.
    const countItems = (): number =>
      screen.getAllByRole('button').filter((b) => b.className.includes('inbox-drawer__item')).length
    expect(countItems()).toBe(4)
    // Click Reviews — clarify rows must disappear (the bug left them in
    // the DOM because duplicate React keys broke reconciliation).
    fireEvent.click(screen.getByTestId('inbox-tab-reviews'))
    await waitFor(() => {
      expect(screen.queryByTestId('inbox-row-clarify-sess_x')).toBeNull()
    })
    expect(screen.queryByTestId('inbox-row-clarify-sess_y')).toBeNull()
    expect(screen.queryByTestId('inbox-row-clarify-sess_z')).toBeNull()
    expect(countItems()).toBe(1)
    // Click Clarify — all three reappear, review row gone.
    fireEvent.click(screen.getByTestId('inbox-tab-clarify'))
    await waitFor(() => screen.getByTestId('inbox-row-clarify-sess_x'))
    expect(screen.queryByTestId('inbox-row-review-r1')).toBeNull()
    expect(countItems()).toBe(3)
    // Back to All — everything visible again.
    fireEvent.click(screen.getByTestId('inbox-tab-all'))
    await waitFor(() => screen.getByTestId('inbox-row-review-r1'))
    expect(countItems()).toBe(4)
  })

  // Clarify rows always navigate to `/clarify/$nodeRunId` even when their
  // React key is the session id — the detail route is per-node-run, not
  // per-session. Lock in the split so a future refactor doesn't
  // accidentally route by session id and 404.
  test('clarify row nav target is clarifyNodeRunId, not session id', async () => {
    mockLists({
      clarify: [{ id: 'sess_abc', clarifyNodeRunId: 'nrun_xyz' }],
    })
    wrap(<InboxDrawer open={true} onClose={() => {}} />)
    await waitFor(() => screen.getByTestId('inbox-row-clarify-sess_abc'))
    fireEvent.click(screen.getByTestId('inbox-row-clarify-sess_abc'))
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/clarify/$nodeRunId',
      params: { nodeRunId: 'nrun_xyz' },
    })
  })
})
