// Thin fetch wrapper for the daemon REST API.
//
// - Reads token + baseUrl from the auth store on every call so token changes
//   take effect without re-creating the client.
// - Surfaces backend DomainError responses (`{ error: { code, message } }`)
//   as ApiError so callers can branch on code without re-parsing.

import { clearToken, getBaseUrl, getToken } from '@/stores/auth'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = getBaseUrl()
  const url = new URL(path.startsWith('/') ? path : `/${path}`, base)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

// RFC-203 (Codex impl-gate P2): tag transport failures at the fetch boundary
// so ONLY genuine network errors become 'network-unreachable'. A bare fetch
// reject is a TypeError ("Failed to fetch"); classifying every TypeError that
// way (in the resolver) masked app-level TypeErrors as daemon outages, so the
// tagging lives here where we know it was the request that failed. AbortErrors
// propagate unchanged (caller-driven cancellation, not a network fault).
// Exported for the few raw-fetch boundaries outside this module (blob/preview
// readers that need response headers) — anything whose failure feeds
// resolveApiError must use this instead of bare fetch, or offline shows as
// verbatim "Failed to fetch".
export async function fetchOrNetworkError(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(0, 'network-unreachable', err instanceof Error ? err.message : String(err))
  }
}

// RFC-203 (Codex impl-gate P2): read at most `cap` bytes of an error response
// body and cancel the stream, so a large plain-text/HTML proxy error cannot
// buffer the whole body (memory / tab freeze) just to slice 2 KiB off it.
async function cappedErrorText(res: Response, cap = 2048): Promise<string> {
  const body = res.body
  if (body === null) return await res.text().catch(() => '')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < cap) {
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      chunks.push(value)
      total += value.length
    }
  } catch {
    /* partial body is fine */
  } finally {
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(Math.min(total, cap))
  let off = 0
  for (const c of chunks) {
    if (off >= out.length) break
    const take = Math.min(c.length, out.length - off)
    out.set(c.subarray(0, take), off)
    off += take
  }
  return new TextDecoder().decode(out)
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const res = await fetchOrNetworkError(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal: opts.signal,
  })

  if (res.status === 401) {
    // Token rejected; force re-auth flow.
    clearToken()
  }

  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false
  const payload: unknown = isJson ? await res.json().catch(() => null) : null

  if (!res.ok) {
    // RFC-203 T1: a non-JSON error response (proxy 502 page, plain-text
    // gateway error) used to collapse to `statusText` — read a capped slice
    // of the body so the only diagnostic survives into ApiError.message.
    const err = extractErrorBody(payload, res)
    if (!isJson && err.code === `http-${res.status}`) {
      const text = await cappedErrorText(res)
      if (text.trim() !== '') err.message = text
    }
    throw new ApiError(res.status, err.code, err.message, err.details)
  }
  return payload as T
}

/**
 * The daemon's `errorHandler` (packages/backend/src/util/errors.ts) emits
 * `{ ok: false, code, message, details? }` for every DomainError. Older
 * (pre-RFC-024) versions of this client looked for a nested `{ error: {...} }`
 * shape which the backend never actually used — every 4xx was therefore
 * surfaced as a generic `http-<status>: <statusText>`, hiding the structured
 * code/message from the user (most painfully for RFC-024 clone failures whose
 * stderr is the only useful debugging signal). Now we recognize both shapes
 * so any future endpoint that wraps in `{ error: ... }` still parses.
 *
 * Exported for the few hand-rolled fetches that can't go through `api.*`
 * (currently multipart/download surfaces). Structured JSON writers should
 * stay on the helpers below so they cannot re-grow a second error decoder.
 */
export function extractErrorBody(
  payload: unknown,
  res: Response,
): { code: string; message: string; details?: unknown } {
  if (typeof payload === 'object' && payload !== null) {
    const obj = payload as Record<string, unknown>
    // Flat shape (current backend convention).
    if (typeof obj.code === 'string' && typeof obj.message === 'string') {
      return {
        code: obj.code,
        message: obj.message,
        ...(obj.details !== undefined ? { details: obj.details } : {}),
      }
    }
    // Nested shape (defensive fallback for routes that might wrap later).
    const nested = obj.error
    if (
      typeof nested === 'object' &&
      nested !== null &&
      typeof (nested as { code?: unknown }).code === 'string' &&
      typeof (nested as { message?: unknown }).message === 'string'
    ) {
      const e = nested as { code: string; message: string; details?: unknown }
      return {
        code: e.code,
        message: e.message,
        ...(e.details !== undefined ? { details: e.details } : {}),
      }
    }
  }
  return { code: `http-${res.status}`, message: res.statusText || 'request failed' }
}

/**
 * RFC-020: POST a multipart/form-data body without the JSON Content-Type
 * default. The browser fills in the boundary header automatically when we
 * leave Content-Type unset; manually setting it would strip the boundary.
 */
export async function apiPostMultipart<T>(
  path: string,
  body: FormData,
  signal?: AbortSignal,
): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token !== null) headers.Authorization = `Bearer ${token}`

  const res = await fetchOrNetworkError(buildUrl(path), {
    method: 'POST',
    headers,
    body,
    signal,
  })

  if (res.status === 401) clearToken()

  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false
  const payload: unknown = isJson ? await res.json().catch(() => null) : null

  if (!res.ok) {
    // RFC-203 T1: a non-JSON error response (proxy 502 page, plain-text
    // gateway error) used to collapse to `statusText` — read a capped slice
    // of the body so the only diagnostic survives into ApiError.message.
    const err = extractErrorBody(payload, res)
    if (!isJson && err.code === `http-${res.status}`) {
      const text = await cappedErrorText(res)
      if (text.trim() !== '') err.message = text
    }
    throw new ApiError(res.status, err.code, err.message, err.details)
  }
  return payload as T
}

/**
 * Authenticated binary/text download. Unlike apiRequest this preserves the
 * successful response body as a Blob, while errors still use the one shared
 * structured decoder.
 */
export async function apiGetBlob(
  path: string,
  query?: RequestOptions['query'],
  signal?: AbortSignal,
): Promise<Blob> {
  const token = getToken()
  const headers: Record<string, string> = { Accept: '*/*' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetchOrNetworkError(buildUrl(path, query), { method: 'GET', headers, signal })
  if (res.status === 401) clearToken()
  if (!res.ok) {
    const isJson = res.headers.get('content-type')?.includes('application/json') ?? false
    const payload: unknown = isJson ? await res.json().catch(() => null) : null
    const err = extractErrorBody(payload, res)
    throw new ApiError(res.status, err.code, err.message, err.details)
  }
  return res.blob()
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    apiRequest<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'POST', body, signal }),
  postMultipart: apiPostMultipart,
  getBlob: apiGetBlob,
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'PUT', body, signal }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'PATCH', body, signal }),
  delete: <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'DELETE', signal }),
  /** JSON-fenced destructive writes (for example RFC-199 workflow delete).
   * Kept separate so existing `delete(path, signal?)` callers retain their
   * second-argument meaning. */
  deleteJson: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'DELETE', body, signal }),
}
