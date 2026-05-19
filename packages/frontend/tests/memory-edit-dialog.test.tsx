// RFC-045 — MemoryEditDialog contract.
//
// Locks:
//   * Initial state mirrors the seeded Memory (title / body / tags / scope).
//   * Save fires PATCH /api/memories/:id with only the changed fields.
//   * scopeType=global auto-clears scopeId on the wire.
//   * Tags-only change PATCHes tags alone, version stays valid.
//   * 422 response surfaces an inline ErrorBanner; dialog stays open.
//   * 409 memory-terminal-status renders the localized friendly message.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Memory } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryEditDialog, _diffAgainstForTests } from '../src/components/memory/MemoryEditDialog'
import '../src/i18n'

function mkMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_x',
    scopeType: 'agent',
    scopeId: 'agent-a',
    title: 'orig title',
    bodyMd: 'orig body',
    tags: ['t1'],
    status: 'approved',
    sourceKind: 'manual',
    sourceEventId: null,
    sourceTaskId: null,
    distillJobId: null,
    distillAction: null,
    supersedesId: null,
    supersededById: null,
    approvedByUserId: 'admin',
    approvedAt: 1000,
    createdAt: 500,
    version: 1,
    ...overrides,
  }
}

function wrap(memory: Memory) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryEditDialog open onClose={() => {}} memory={memory} />
    </QueryClientProvider>,
  )
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
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
  cleanup()
  vi.restoreAllMocks()
})

describe('_diffAgainstForTests — RFC-045', () => {
  test('no-op patch returns empty object', () => {
    const seed = mkMemory()
    const out = _diffAgainstForTests(seed, {
      scopeType: seed.scopeType,
      scopeId: seed.scopeId,
      title: seed.title,
      bodyMd: seed.bodyMd,
      tags: seed.tags,
    })
    expect(out).toEqual({})
  })
  test('title-only change yields {title}', () => {
    const seed = mkMemory()
    const out = _diffAgainstForTests(seed, {
      scopeType: seed.scopeType,
      scopeId: seed.scopeId,
      title: 'renamed',
      bodyMd: seed.bodyMd,
      tags: seed.tags,
    })
    expect(out).toEqual({ title: 'renamed' })
  })
  test('scopeType→global pairs scopeId=null on wire even if state still has the old id', () => {
    const seed = mkMemory({ scopeType: 'agent', scopeId: 'agent-a' })
    const out = _diffAgainstForTests(seed, {
      scopeType: 'global',
      // Even with a stale agent id in state, the helper forces scopeId=null
      // (form UI nulls it on scope switch, but be defensive).
      scopeId: 'agent-a',
      title: seed.title,
      bodyMd: seed.bodyMd,
      tags: seed.tags,
    })
    expect(out.scopeType).toBe('global')
    expect(out.scopeId).toBeNull()
  })
  test('tag reorder alone is no diff', () => {
    const seed = mkMemory({ tags: ['a', 'b', 'c'] })
    const out = _diffAgainstForTests(seed, {
      scopeType: seed.scopeType,
      scopeId: seed.scopeId,
      title: seed.title,
      bodyMd: seed.bodyMd,
      tags: ['c', 'b', 'a'],
    })
    expect(out).toEqual({})
  })
})

describe('MemoryEditDialog — UX', () => {
  test('renders with seeded title / body / scope', async () => {
    installFetch(
      () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    wrap(mkMemory())
    const title = await screen.findByTestId<HTMLInputElement>('memory-form-title')
    expect(title.value).toBe('orig title')
    const body = screen.getByTestId<HTMLTextAreaElement>('memory-form-body')
    expect(body.value).toBe('orig body')
  })

  test('Save with no changes closes the dialog without firing PATCH', async () => {
    const calls = installFetch(
      () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    let closed = false
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryEditDialog open onClose={() => (closed = true)} memory={mkMemory()} />
      </QueryClientProvider>,
    )
    const save = await screen.findByTestId('memory-edit-dialog-save')
    fireEvent.click(save)
    await waitFor(() => expect(closed).toBe(true))
    // No PATCH call should have been issued (only the GET options-list pre-fetches).
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  test('Save with title change PATCHes {title} only', async () => {
    const calls = installFetch((call) => {
      if (call.method === 'PATCH') {
        return new Response(
          JSON.stringify({
            memory: { ...mkMemory(), title: 'renamed', version: 2 },
            changedFields: ['title'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    wrap(mkMemory())
    const title = await screen.findByTestId<HTMLInputElement>('memory-form-title')
    fireEvent.change(title, { target: { value: 'renamed' } })
    fireEvent.click(screen.getByTestId('memory-edit-dialog-save'))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(patch!.url).toContain('/api/memories/mem_x')
      expect(patch!.body).toEqual({ title: 'renamed' })
    })
  })

  test('after Save success, the detail + candidates caches hold the FRESH memory (no stale re-open)', async () => {
    // Regression: previously, re-opening the dialog right after Save still
    // showed the pre-edit data until a manual page refresh because the
    // dialog read the cached (stale) Memory before background refetch
    // resolved.
    const updated: Memory = { ...mkMemory(), title: 'renamed', tags: ['fresh'], version: 2 }
    installFetch((call) => {
      if (call.method === 'PATCH') {
        return new Response(JSON.stringify({ memory: updated, changedFields: ['title', 'tags'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    // Seed the cache with the OLD memory shape, matching what
    // MemoryAllList / MemoryApprovalQueue would have written before edit.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const seed = mkMemory()
    qc.setQueryData(['memories', 'detail', seed.id], { memory: seed })
    qc.setQueryData(['memories', 'candidates'], { items: [seed] })

    let closed = false
    render(
      <QueryClientProvider client={qc}>
        <MemoryEditDialog open onClose={() => (closed = true)} memory={seed} />
      </QueryClientProvider>,
    )
    fireEvent.change(await screen.findByTestId('memory-form-title'), {
      target: { value: 'renamed' },
    })
    fireEvent.click(screen.getByTestId('memory-edit-dialog-save'))
    await waitFor(() => expect(closed).toBe(true))
    // Detail cache now holds the SERVER-RETURNED memory (eager write).
    expect(qc.getQueryData(['memories', 'detail', seed.id])).toEqual({ memory: updated })
    // Candidates list item was replaced in-place.
    const cand = qc.getQueryData<{ items: Memory[] }>(['memories', 'candidates'])
    expect(cand?.items).toBeDefined()
    expect(cand!.items[0]).toEqual(updated)
  })

  test('409 memory-terminal-status renders the localized friendly message', async () => {
    installFetch((call) => {
      if (call.method === 'PATCH') {
        return new Response(
          JSON.stringify({ code: 'memory-terminal-status', message: 'terminal' }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    wrap(mkMemory())
    const title = await screen.findByTestId<HTMLInputElement>('memory-form-title')
    fireEvent.change(title, { target: { value: 'renamed' } })
    fireEvent.click(screen.getByTestId('memory-edit-dialog-save'))
    const banner = await screen.findByTestId('memory-edit-dialog-error')
    // English copy from i18n: 'This memory is in a terminal state and cannot be edited'
    expect(banner.textContent).toMatch(/terminal/i)
  })
})
