// RFC-079 — multi-document review view: document list + approve gate +
// per-document selection. Locks the user-facing contract that the approve
// button is disabled until every document is decided and that the per-document
// Accept button hits the selection endpoint for the active document.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'
import type { DocVersion, ReviewDetail } from '@agent-workflow/shared'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})
// useTaskSync opens a websocket; stub it out.
vi.mock('../src/hooks/useTaskSync', () => ({ useTaskSync: () => {} }))

import { api } from '../src/api/client'
import { MultiDocReviewView } from '../src/components/review/MultiDocReviewView'

function doc(id: string): DocVersion {
  return {
    id,
    taskId: 't',
    reviewNodeId: 'rev',
    reviewNodeRunId: 'run',
    sourceNodeId: 'src',
    sourcePortName: 'cases',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: `runs/t/${id}.md`,
    commentsJson: '[]',
    decision: 'pending',
    decisionReason: null,
    promptSnapshot: null,
    agentSnapshot: null,
    createdAt: 0,
    decidedAt: null,
    decidedBy: null,
  }
}

const detail: ReviewDetail = {
  summary: {
    nodeRunId: 'run',
    taskId: 't',
    taskName: 'T',
    workflowId: 'w',
    workflowName: 'W',
    reviewNodeId: 'rev',
    title: 'Review cases',
    description: '',
    currentVersionIndex: 1,
    reviewIteration: 0,
    decision: 'pending',
    awaitingReview: true,
    shardKey: null,
    isMultiDoc: true,
    createdAt: 0,
    decidedAt: null,
  },
  currentVersion: doc('d0'),
  // Distinct from the list titles so findByText('Case A') only matches the list.
  currentBody: '# Active document body\n\ntext',
  comments: [],
  rerunnableOnReject: [],
  rerunnableOnIterate: [],
  documents: [
    {
      docVersionId: 'd0',
      itemIndex: 0,
      itemPath: 'cases/a.md',
      title: 'Case A',
      selection: 'accepted',
      commentCount: 0,
    },
    {
      docVersionId: 'd1',
      itemIndex: 1,
      itemPath: 'cases/b.md',
      title: 'Case B',
      selection: 'unselected',
      commentCount: 0,
    },
    {
      docVersionId: 'd2',
      itemIndex: 2,
      itemPath: 'cases/c.md',
      title: 'Case C',
      selection: 'not_accepted',
      commentCount: 2,
    },
  ],
}

function wrap(node: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  // The multi-doc header now renders a <Link to="/tasks/$id"> (jump to the
  // owning task), which needs a router context. Mount under a minimal memory
  // router that registers that route so the Link resolves.
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {node}
        <Outlet />
      </>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  const tasksRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tasksRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.patch as ReturnType<typeof vi.fn>).mockReset()
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/reviews/run') return Promise.resolve(detail)
    if (url === '/api/config') return Promise.resolve({})
    return Promise.resolve(undefined)
  })
  ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
})

describe('MultiDocReviewView', () => {
  test('renders the document list and gates approve until all decided', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    expect(await screen.findByText('Case A')).toBeTruthy()
    expect(screen.getByText('Case B')).toBeTruthy()
    expect(screen.getByText('Case C')).toBeTruthy()
    // d1 is 'unselected' → approve disabled.
    const approve = screen.getByTestId('multidoc-approve') as HTMLButtonElement
    expect(approve.disabled).toBe(true)
  })

  test('per-document Accept hits the selection endpoint for the active document', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    fireEvent.click(screen.getByTestId('multidoc-accept'))
    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/api/reviews/run/documents/d0/selection', {
        selection: 'accepted',
      })
    })
  })

  // RFC-090: keyboard navigation for the review queue.
  test('ArrowDown / ArrowUp move the active document and clamp at the ends', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    const current = (title: string): string | null =>
      screen.getByText(title).closest('button')?.getAttribute('aria-current') ?? null
    expect(current('Case A')).toBe('true') // first doc active by default
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(current('Case B')).toBe('true'))
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(current('Case C')).toBe('true'))
    // Clamp: ArrowDown on the last document stays put (no wraparound).
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(current('Case C')).toBe('true')
    // ArrowUp walks back.
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    await waitFor(() => expect(current('Case B')).toBe('true'))
  })

  test('Q sets the active document to accepted', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    fireEvent.keyDown(window, { key: 'q' })
    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/api/reviews/run/documents/d0/selection', {
        selection: 'accepted',
      })
    })
  })

  test('W sets the active document to not_accepted', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    fireEvent.keyDown(window, { key: 'w' })
    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/api/reviews/run/documents/d0/selection', {
        selection: 'not_accepted',
      })
    })
  })

  // The per-document accept / reject buttons must advertise their Q / W
  // shortcut with the same inline <kbd> chip the cross-clarify scope picker
  // uses (.kbd-shortcut). Mirrors cross-clarify-scope-shortcut.test.tsx's
  // "(Q)/(W) shortcut hint chips" lock. The chip is aria-hidden so it never
  // leaks into the button's accessible name, and it must reuse the shared
  // .kbd-shortcut primitive rather than fork a per-component class.
  test('accept / reject buttons render Q / W shortcut chips reusing .kbd-shortcut', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    const acceptKbd = screen.getByTestId('multidoc-accept-kbd')
    const rejectKbd = screen.getByTestId('multidoc-not-accept-kbd')
    expect(acceptKbd.textContent).toBe('Q')
    expect(rejectKbd.textContent).toBe('W')
    // Shared primitive, not a fork.
    expect(acceptKbd.classList.contains('kbd-shortcut')).toBe(true)
    expect(rejectKbd.classList.contains('kbd-shortcut')).toBe(true)
    // aria-hidden keeps the button's accessible name as the label alone.
    expect(acceptKbd.getAttribute('aria-hidden')).toBe('true')
    expect(rejectKbd.getAttribute('aria-hidden')).toBe('true')
    // The chips live inside their respective action buttons.
    expect(acceptKbd.closest('[data-testid="multidoc-accept"]')).not.toBeNull()
    expect(rejectKbd.closest('[data-testid="multidoc-not-accept"]')).not.toBeNull()
  })

  // The popover / inline-edit comment textareas (and the reject-reason textarea)
  // are all form controls; focus inside any of them must mute Q/W so a typed
  // 'q'/'w' edits the comment instead of flipping the doc's selection.
  test('Q/W do not fire while focus is in a form control', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    expect(document.activeElement).toBe(ta)
    fireEvent.keyDown(window, { key: 'q' })
    fireEvent.keyDown(window, { key: 'w' })
    expect(api.patch).not.toHaveBeenCalled()
    document.body.removeChild(ta)
  })
})
