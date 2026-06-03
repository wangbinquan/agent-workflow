// RFC-079 — multi-document review view: document list + approve gate +
// per-document selection. Locks the user-facing contract that the approve
// button is disabled until every document is decided and that the per-document
// Accept button hits the selection endpoint for the active document.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
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
})
