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

/**
 * RFC-208 — no request may wait forever.
 *
 * The browser imposes no response timeout, so a half-open socket (daemon event
 * loop blocked on sync git/exec, laptop sleep/wake, black-holing proxy) used to
 * leave `fetch` pending with no error and no escape. That is not a cosmetic
 * stall: the pending mutation holds the split page's busy token, which feeds a
 * ROUTER-GLOBAL `useBlocker`, and while busy the unsaved-changes guard hides its
 * Discard button — so one wedged request locks navigation app-wide until reload.
 *
 * Two budgets, because "how long is legitimate" has two different shapes:
 *
 *  - `CLIENT_HARD_DEADLINE_MS` — requests whose duration does NOT scale with
 *    payload size. Comfortably above the daemon's own `idleTimeout` (255s, see
 *    backend `cli/start.ts`), so anything the daemon would still answer comes
 *    back — or the daemon closes the socket and we get a real error.
 *
 *  - `payloadDeadlineMs(bytes)` — uploads/downloads, where a slow-but-healthy
 *    link legitimately takes longer the bigger the body.
 *
 * NOTE, deliberately: clearing `idleTimeout` is NOT a proof that this can never
 * misfire. `idleTimeout` bounds INACTIVITY; `AbortSignal.timeout` bounds TOTAL
 * ELAPSED time. An upload that keeps the socket busy is never idle, which is
 * exactly why the payload budget exists (and why an earlier revision of this
 * design, which claimed the fixed budget was "constructively safe", was wrong).
 */
export const CLIENT_HARD_DEADLINE_MS = 300_000
/** Transfer allowance floor, on top of which payload time is added. */
export const PAYLOAD_DEADLINE_BASE_MS = 60_000
/** ≈64 KiB/s — tolerates a genuinely bad 512 Kbit/s link. */
export const PAYLOAD_MIN_BYTES_PER_MS = 64

/**
 * Deadline for a body-size-bound request. The `max` floor is load-bearing: a
 * zero-byte multipart is still a real request (an upload-kind workflow input
 * submits multipart even with no files picked, so the backend's min/max gate
 * runs) and the server may spend its normal budget on repo resolution and
 * worktree creation. Transfer time is ADDED to the fixed budget, never
 * substituted for it.
 */
export function payloadDeadlineMs(bytes: number): number {
  const transfer =
    Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes / PAYLOAD_MIN_BYTES_PER_MS) : 0
  return Math.max(CLIENT_HARD_DEADLINE_MS, PAYLOAD_DEADLINE_BASE_MS + transfer)
}

export interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
  /** Override the deadline. Omit for the budget appropriate to the entry point. */
  deadlineMs?: number
}

/**
 * Combine the caller's signal with this request's deadline.
 *
 * Returns the deadline signal separately so callers can tell the two apart
 * afterwards: a caller-driven abort must stay an AbortError (the user cancelled;
 * that is not a fault), while the deadline firing is a reportable timeout.
 */
function withDeadline(
  signal: AbortSignal | undefined,
  deadlineMs: number,
): { signal: AbortSignal; deadline: AbortSignal } {
  const deadline = AbortSignal.timeout(deadlineMs)
  return {
    signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    deadline,
  }
}

/**
 * Bound a body read (`res.json()` / `res.text()` / `res.blob()`).
 *
 * Bounding `fetch` alone is not enough: a proxy can deliver headers and then
 * stall, leaving the body stream awaiting an EOF that never arrives. `fetch`
 * has already resolved by then, so its signal no longer helps — we race the
 * read against the deadline and cancel the stream so the socket is released.
 */
async function readWithDeadline<T>(
  res: Response,
  deadline: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  if (deadline.aborted) throw new ApiError(0, 'request-timeout', 'request timed out')
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      void res.body?.cancel().catch(() => {})
      reject(new ApiError(0, 'request-timeout', 'request timed out'))
    }
    deadline.addEventListener('abort', onAbort, { once: true })
    read().then(
      (value) => {
        deadline.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        deadline.removeEventListener('abort', onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
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
    // RFC-208: a deadline firing must be reported as a timeout, never as
    // "daemon unreachable" — the daemon may well be up and merely wedged, and
    // the two need different remedies.
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(0, 'request-timeout', err.message)
    }
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

  const { signal, deadline } = withDeadline(opts.signal, opts.deadlineMs ?? CLIENT_HARD_DEADLINE_MS)

  const res = await fetchOrNetworkError(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal,
  })

  if (res.status === 401) {
    // Token rejected; force re-auth flow.
    clearToken()
  }

  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false
  const payload: unknown = isJson
    ? await readWithDeadline(res, deadline, () => res.json()).catch((err: unknown) => {
        // A malformed body is still a null payload (historical behavior); a
        // deadline is a real failure and must not be swallowed into it.
        if (err instanceof ApiError) throw err
        return null
      })
    : null

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
  opts?: { signal?: AbortSignal; deadlineMs?: number },
): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token !== null) headers.Authorization = `Bearer ${token}`

  // Body-size-bound: budget from the bytes actually being uploaded.
  const { signal, deadline } = withDeadline(
    opts?.signal,
    opts?.deadlineMs ?? payloadDeadlineMs(formDataByteLength(body)),
  )

  const res = await fetchOrNetworkError(buildUrl(path), {
    method: 'POST',
    headers,
    body,
    signal,
  })

  if (res.status === 401) clearToken()

  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false
  const payload: unknown = isJson
    ? await readWithDeadline(res, deadline, () => res.json()).catch((err: unknown) => {
        if (err instanceof ApiError) throw err
        return null
      })
    : null

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
  opts?: { signal?: AbortSignal; deadlineMs?: number },
): Promise<Blob> {
  const token = getToken()
  const headers: Record<string, string> = { Accept: '*/*' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  // Fixed budget by default: the caller cannot know the byte count before the
  // response arrives, and the server does not guarantee Content-Length — so a
  // payload-derived budget would be guesswork. A genuinely large download must
  // pass `deadlineMs` explicitly rather than rely on an invented default.
  const { signal, deadline } = withDeadline(
    opts?.signal,
    opts?.deadlineMs ?? CLIENT_HARD_DEADLINE_MS,
  )
  const res = await fetchOrNetworkError(buildUrl(path, query), { method: 'GET', headers, signal })
  if (res.status === 401) clearToken()
  if (!res.ok) {
    const isJson = res.headers.get('content-type')?.includes('application/json') ?? false
    const payload: unknown = isJson
      ? await readWithDeadline(res, deadline, () => res.json()).catch(() => null)
      : null
    const err = extractErrorBody(payload, res)
    throw new ApiError(res.status, err.code, err.message, err.details)
  }
  return await readWithDeadline(res, deadline, () => res.blob())
}

/** Best-effort byte count of a multipart body (used only to size its deadline). */
function formDataByteLength(body: FormData): number {
  let total = 0
  for (const [, value] of body.entries()) {
    total += value instanceof Blob ? value.size : new TextEncoder().encode(String(value)).length
  }
  return total
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
