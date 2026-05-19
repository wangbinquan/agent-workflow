// RFC-045 — MemoryNewDialog contract.
//
// Locks:
//   * Initially global scope; Save POSTs { scopeType: 'global', scopeId: null, ... }
//   * Save with empty title/body is blocked (button disabled).
//   * onCreated fires with the returned Memory; dialog closes.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Memory } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryNewDialog } from '../src/components/memory/MemoryNewDialog'
import '../src/i18n'

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

function mkMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_new',
    scopeType: 'global',
    scopeId: null,
    title: 'New rule',
    bodyMd: 'Body',
    tags: ['tg'],
    status: 'candidate',
    sourceKind: 'manual',
    sourceEventId: null,
    sourceTaskId: null,
    distillJobId: null,
    distillAction: null,
    supersedesId: null,
    supersededById: null,
    approvedByUserId: null,
    approvedAt: null,
    createdAt: 1,
    version: 1,
    ...overrides,
  }
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderDialog(onCreated?: (m: Memory) => void, onClose?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryNewDialog open onClose={onClose ?? (() => {})} onCreated={onCreated} />
    </QueryClientProvider>,
  )
}

describe('MemoryNewDialog — RFC-045', () => {
  test('renders all 4 scope radios with global selected', async () => {
    installFetch(
      () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    renderDialog()
    // Scope radios are now segmented <button role=radio> elements; the active
    // one carries aria-checked=true. All 4 options should be present.
    const global = await screen.findByTestId('memory-form-scope-global')
    expect(global.getAttribute('aria-checked')).toBe('true')
    for (const s of ['global', 'agent', 'workflow', 'repo']) {
      expect(screen.getByTestId(`memory-form-scope-${s}`)).toBeTruthy()
    }
  })

  test('empty title/body blocks Save (button disabled)', async () => {
    installFetch(
      () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    renderDialog()
    const save = (await screen.findByTestId('memory-new-dialog-save')) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  test('happy path: Save POSTs body and calls onCreated + onClose', async () => {
    const created = mkMemory()
    const calls = installFetch((call) => {
      if (call.method === 'POST') {
        return new Response(JSON.stringify({ memory: created }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    let createdReceived: Memory | null = null
    let closed = false
    renderDialog(
      (m) => (createdReceived = m),
      () => (closed = true),
    )
    fireEvent.change(await screen.findByTestId('memory-form-title'), {
      target: { value: 'New rule' },
    })
    fireEvent.change(screen.getByTestId('memory-form-body'), { target: { value: 'Body' } })
    const save = screen.getByTestId('memory-new-dialog-save') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.url).toContain('/api/memories')
      const body = post!.body as Record<string, unknown>
      expect(body.scopeType).toBe('global')
      expect(body.scopeId).toBeNull()
      expect(body.title).toBe('New rule')
      expect(body.bodyMd).toBe('Body')
    })
    await waitFor(() => expect(createdReceived).not.toBeNull())
    expect((createdReceived as unknown as Memory).id).toBe('mem_new')
    expect(closed).toBe(true)
  })

  test('422 from backend surfaces an inline error and dialog stays open', async () => {
    let closed = false
    installFetch((call) => {
      if (call.method === 'POST') {
        return new Response(JSON.stringify({ code: 'invalid-body', message: 'bad body' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    renderDialog(undefined, () => (closed = true))
    fireEvent.change(await screen.findByTestId('memory-form-title'), {
      target: { value: 'ok' },
    })
    fireEvent.change(screen.getByTestId('memory-form-body'), { target: { value: 'Body' } })
    fireEvent.click(screen.getByTestId('memory-new-dialog-save'))
    const banner = await screen.findByTestId('memory-new-dialog-error')
    expect(banner.textContent ?? '').not.toBe('')
    expect(closed).toBe(false)
  })
})
