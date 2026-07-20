// API client wrapper: token header, query string, error mapping, 401 → clearToken.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, ApiError, apiRequest } from '../src/api/client'
import { clearToken, setBaseUrl, setToken } from '../src/stores/auth'

const realFetch = globalThis.fetch
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('apiRequest', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setBaseUrl('http://daemon.test')
    setToken('tok')
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    window.localStorage.clear()
  })

  test('sends Authorization header from store', async () => {
    const fetchMock = vi.fn(async (_req: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await apiRequest('/api/health')
    const call = fetchMock.mock.calls[0]
    const init = call?.[1] as RequestInit | undefined
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(String(call?.[0])).toBe('http://daemon.test/api/health')
  })

  test('appends query parameters', async () => {
    const fetchMock = vi.fn(async (_req: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse([]),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await apiRequest('/api/tasks', { query: { status: 'running', skip: undefined, limit: 10 } })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://daemon.test/api/tasks?status=running&limit=10',
    )
  })

  test('serializes body as JSON for POST', async () => {
    const fetchMock = vi.fn(async (_req: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 'x' }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await apiRequest('/api/tasks', { method: 'POST', body: { foo: 'bar' } })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ foo: 'bar' }))
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  test('deleteJson sends a fenced DELETE body without changing delete(path, signal)', async () => {
    const fetchMock = vi.fn(async (_req: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await api.deleteJson('/api/workflows/w1', {
      expectedVersion: 3,
      clientMutationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
    const controller = new AbortController()
    await api.delete('/api/agents/a1', controller.signal)

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('DELETE')
    expect(init.body).toBe(
      JSON.stringify({
        expectedVersion: 3,
        clientMutationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    )
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    const legacyInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(legacyInit.method).toBe('DELETE')
    expect(legacyInit.body).toBeUndefined()
    // RFC-208: the signal reaching fetch is now a composite of the caller's
    // signal and this request's deadline, so it is deliberately NOT the same
    // object. What the caller is promised is unchanged and is what we assert:
    // aborting their controller still aborts the request.
    expect(legacyInit.signal).toBeInstanceOf(AbortSignal)
    expect(legacyInit.signal?.aborted).toBe(false)
    controller.abort()
    expect(legacyInit.signal?.aborted).toBe(true)
  })

  test('getBlob sends auth plus exact query and preserves successful bytes', async () => {
    const fetchMock = vi.fn(
      async (_req: RequestInfo | URL, _init?: RequestInit) =>
        new Response('name: workflow', {
          headers: { 'Content-Type': 'application/yaml' },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const blob = await api.getBlob('/api/workflows/w1/export', {
      expectedVersion: 4,
      expectedSnapshotHash: 'a'.repeat(64),
    })
    expect(await blob.text()).toBe('name: workflow')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(
      `http://daemon.test/api/workflows/w1/export?expectedVersion=4&expectedSnapshotHash=${'a'.repeat(64)}`,
    )
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(init?.method).toBe('GET')
  })

  test('getBlob keeps the shared structured error decoder', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        {
          ok: false,
          code: 'workflow-version-mismatch',
          message: 'workflow changed',
          details: { current: { version: 5 } },
        },
        { status: 409 },
      )) as unknown as typeof fetch

    await expect(
      api.getBlob('/api/workflows/w1/export', { expectedVersion: 4 }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'workflow-version-mismatch',
      details: { current: { version: 5 } },
    })
  })

  test('throws ApiError preserving code/message/details on backend error (nested shape)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        { error: { code: 'task-not-found', message: "task 'x' not found", details: { id: 'x' } } },
        { status: 404 },
      )) as unknown as typeof fetch

    await expect(apiRequest('/api/tasks/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'task-not-found',
      message: "task 'x' not found",
    })
  })

  // RFC-024 regression: the daemon's `errorHandler` actually returns the FLAT
  // shape `{ ok: false, code, message, details? }` — not wrapped in
  // `{ error: ... }`. Pre-RFC-024 this client only recognized the nested
  // shape, so users saw `http-400: Bad Request` instead of the real
  // `repo-clone-failed: ...` message. If anyone re-tightens isErrorPayload to
  // the nested shape only, this test catches it.
  test("throws ApiError reading the daemon's flat error payload", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        {
          ok: false,
          code: 'repo-clone-failed',
          message: 'git clone failed for https://***@host.example/foo.git: fatal: ...',
          details: { url: 'https://***@host.example/foo.git', stderr: 'fatal: ...' },
        },
        { status: 400 },
      )) as unknown as typeof fetch

    await expect(apiRequest('/api/tasks', { method: 'POST', body: {} })).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'repo-clone-failed',
    })
  })

  test('401 clears the stored token', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        { error: { code: 'auth-required', message: 'token rejected' } },
        {
          status: 401,
        },
      )) as unknown as typeof fetch

    await expect(apiRequest('/api/agents')).rejects.toBeInstanceOf(ApiError)
    expect(window.localStorage.getItem('agent-workflow.token')).toBeNull()
  })

  test('non-JSON 500 still surfaces as ApiError', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', {
        status: 500,
        statusText: 'Internal Server Error',
      })) as unknown as typeof fetch

    await expect(apiRequest('/api/agents')).rejects.toMatchObject({
      status: 500,
      code: 'http-500',
    })
  })

  test('falls back to no Authorization header when token absent', async () => {
    clearToken()
    const fetchMock = vi.fn(async (_req: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await apiRequest('/api/health')
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  // RFC-203 (Codex impl-gate P2) — transport failures are tagged AT the fetch
  // boundary. Locks: (1) a fetch reject (TypeError) becomes
  // ApiError('network-unreachable') so every resolver surface localizes it;
  // (2) caller-driven aborts pass through untouched (they are not outages);
  // (3) a huge non-JSON error body is capped, never buffered whole.
  test('fetch rejection becomes ApiError network-unreachable (status 0)', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    await expect(apiRequest('/api/agents')).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'network-unreachable',
      message: 'Failed to fetch',
    })
  })

  test('AbortError from fetch propagates unchanged (not wrapped as ApiError)', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    globalThis.fetch = (async () => {
      throw abort
    }) as unknown as typeof fetch

    await expect(apiRequest('/api/agents')).rejects.toBe(abort)
  })

  test('non-JSON error body is capped at 2 KiB without buffering the whole body', async () => {
    const big = 'x'.repeat(1 << 20) // 1 MiB proxy error page
    globalThis.fetch = (async () =>
      new Response(big, {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/html' },
      })) as unknown as typeof fetch

    const err = await apiRequest('/api/agents').then(
      () => null,
      (e: unknown) => e as ApiError,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(err?.code).toBe('http-502')
    expect(err?.message.length).toBeLessThanOrEqual(2048)
    expect(err?.message.startsWith('xxx')).toBe(true)
  })
})
