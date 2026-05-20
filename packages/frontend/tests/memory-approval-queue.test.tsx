// RFC-041 PR4 — MemoryApprovalQueue contract.
//
// Locks:
// 1. Empty state when GET /api/memories?status=candidate returns [].
// 2. Each row renders title + scope chip + action buttons.
// 3. Admin sees buttons enabled; non-admin sees them disabled + the
//    "Admin only" banner.
// 4. [Approve] POSTs { action: 'approve' } to /promote.
// 5. [Reject] POSTs { action: 'reject' }.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Memory } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryApprovalQueue } from '../src/components/memory/MemoryApprovalQueue'
import '../src/i18n'

function mkCandidate(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_cand_1',
    scopeType: 'workflow',
    scopeId: 'wf_a',
    title: 'Prefer plural collection paths',
    bodyMd: 'When generating list endpoints, use /items not /item.',
    tags: ['api-naming'],
    status: 'candidate',
    sourceKind: 'clarify',
    sourceEventId: 'sess_1',
    sourceTaskId: 'task_a',
    distillJobId: 'job_1',
    distillAction: 'new',
    supersedesId: null,
    supersededById: null,
    approvedByUserId: null,
    approvedAt: null,
    createdAt: 1000,
    version: 1,
    ...overrides,
  }
}

function wrap(isAdmin: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryApprovalQueue isAdmin={isAdmin} />
    </QueryClientProvider>,
  )
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      const call: FetchCall = { url, method, body }
      calls.push(call)
      return handler(call)
    },
  )
  return calls
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('MemoryApprovalQueue', () => {
  test('empty state shown when no candidates', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    wrap(true)
    await waitFor(() => {
      expect(screen.getByTestId('memory-approval-queue-empty')).toBeTruthy()
    })
  })

  test('admin sees enabled approve / reject buttons', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ items: [mkCandidate()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    wrap(true)
    const approve = (await screen.findByTestId(
      'memory-candidate-mem_cand_1-approve',
    )) as HTMLButtonElement
    const reject = screen.getByTestId('memory-candidate-mem_cand_1-reject') as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    expect(reject.disabled).toBe(false)
    expect(screen.queryByTestId('memory-admin-only-banner')).toBeNull()
  })

  test('non-admin sees disabled buttons + admin-only banner', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ items: [mkCandidate()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    wrap(false)
    const approve = (await screen.findByTestId(
      'memory-candidate-mem_cand_1-approve',
    )) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    expect(screen.getByTestId('memory-admin-only-banner')).toBeTruthy()
  })

  test('approve click posts { action: "approve" } to /promote', async () => {
    const calls = installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [mkCandidate()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ memory: mkCandidate({ status: 'approved' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    wrap(true)
    const btn = await screen.findByTestId('memory-candidate-mem_cand_1-approve')
    fireEvent.click(btn)
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post?.url).toContain('/api/memories/mem_cand_1/promote')
      expect((post?.body as { action: string }).action).toBe('approve')
    })
  })

  // Regression: the approval card MUST render bodyMd, otherwise admins
  // can't actually approve anything. Locks in:
  //  - GET /api/memories?status=candidate is called with include=body
  //    (so the backend returns full Memory rows, not stripped MemorySummary).
  //  - Short bodies (≤ COLLAPSE_LINE_THRESHOLD lines) render fully with no toggle.
  test('list fetch includes include=body and short body renders without a toggle', async () => {
    const calls = installFetch(
      () =>
        new Response(
          JSON.stringify({
            items: [mkCandidate({ bodyMd: 'short body across\ntwo lines only' })],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    wrap(true)
    const body = await screen.findByTestId('memory-candidate-mem_cand_1-body')
    expect(body.textContent).toBe('short body across\ntwo lines only')
    expect(screen.queryByTestId('memory-candidate-mem_cand_1-body-toggle')).toBeNull()
    // GET must request include=body — the listMemories default returns
    // MemorySummary which lacks bodyMd / sourceKind / etc.
    const getCall = calls.find((c) => c.method === 'GET')
    expect(getCall).toBeTruthy()
    expect(getCall!.url).toContain('include=body')
    expect(getCall!.url).toContain('status=candidate')
  })

  // Regression: long bodies must be foldable so a queue of 20+ candidates
  // stays scannable. Threshold = 8 newline-separated lines.
  test('long body (> 8 lines) defaults to clamped and toggles open / closed', async () => {
    const longBody = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    installFetch(
      () =>
        new Response(JSON.stringify({ items: [mkCandidate({ bodyMd: longBody })] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    wrap(true)
    const body = await screen.findByTestId('memory-candidate-mem_cand_1-body')
    expect(body.getAttribute('data-expanded')).toBe('false')
    expect(body.className).toContain('memory-candidate-card__body--clamped')
    // Full text is still in the DOM (CSS-clamped, not text-truncated) so a
    // screen reader / Ctrl-F can still find the rest.
    expect(body.textContent).toContain('line 12')
    const toggle = screen.getByTestId('memory-candidate-mem_cand_1-body-toggle')
    fireEvent.click(toggle)
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(body.className).not.toContain('memory-candidate-card__body--clamped')
    fireEvent.click(toggle)
    expect(body.getAttribute('data-expanded')).toBe('false')
    expect(body.className).toContain('memory-candidate-card__body--clamped')
  })

  test('reject click posts { action: "reject" } to /promote', async () => {
    const calls = installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [mkCandidate()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ memory: mkCandidate({ status: 'rejected' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    wrap(true)
    const btn = await screen.findByTestId('memory-candidate-mem_cand_1-reject')
    fireEvent.click(btn)
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post?.url).toContain('/api/memories/mem_cand_1/promote')
      expect((post?.body as { action: string }).action).toBe('reject')
    })
  })
})
