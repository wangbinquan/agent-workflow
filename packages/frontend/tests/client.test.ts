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
    expect(legacyInit.signal).toBe(controller.signal)
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
})
