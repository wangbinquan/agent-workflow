// RFC-370 v2 §5.2 — the CrewStation service-domain API, as a neutral transport.
//
// A hosted service slot calls the platform with its trusted Pod identity: the
// platform injects `CS_PLATFORM_API_URL` and recognizes the caller from the Pod,
// so no credential travels with the request. Execution authority, hosted
// executions and hosted workspaces each own their request shapes; this module
// only moves JSON, bounds every call, and retries what the platform declares
// safe to retry (rate limits and unavailability, always with the caller's
// unchanged requestKey).

import { timeoutSignal } from '@/util/timeoutSignal'

export const CREWSTATION_PLATFORM_API_URL_ENV = 'CS_PLATFORM_API_URL'

/** The platform's error body: `{ error: kind, message, details }`. */
export class CrewStationApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'CrewStationApiError'
  }

  /** A platform code carried in `details.code` (for example `stale_generation`). */
  get code(): string | undefined {
    const code = this.details.code
    return typeof code === 'string' ? code : undefined
  }
}

export function isCrewStationApiError(error: unknown): error is CrewStationApiError {
  return error instanceof CrewStationApiError
}

export interface CrewStationPlatformApi {
  get<T>(path: string, query?: Readonly<Record<string, string | number | undefined>>): Promise<T>
  /** POST with retries on 429 / 503 / transport failure; safe only for
   * requests the platform deduplicates (requestKey) or that are read-only.
   * Non-idempotent claim-next and rejection calls explicitly disable retries. */
  post<T>(path: string, body: unknown, options?: { readonly retry: false }): Promise<T>
  /** One bounded SSE connection. The caller owns durable cursors and reconnects. */
  stream<T>(
    path: string,
    query: Readonly<Record<string, string | number | undefined>>,
    signal?: AbortSignal,
  ): AsyncIterable<T>
}

export interface CrewStationPlatformApiOptions {
  readonly baseUrl: string
  readonly fetch?: typeof fetch
  /** Per attempt; the platform answers v3 calls well within this. */
  readonly timeoutMs?: number
  /** Rotate a live SSE connection without treating the rotation as an outage. */
  readonly streamWindowMs?: number
  /** Total attempts for a retryable failure (first attempt included). */
  readonly attempts?: number
  readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_ATTEMPTS = 5

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  const seconds = header === null ? Number.NaN : Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000)
  return Math.min(500 * 2 ** attempt, 5_000)
}

async function errorOf(response: Response): Promise<CrewStationApiError> {
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const record =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined
  const kind = typeof record?.error === 'string' ? record.error : `http-${response.status}`
  const message =
    typeof record?.message === 'string'
      ? record.message
      : `CrewStation responded ${response.status}${text.length > 0 ? `: ${text.slice(0, 200)}` : ''}`
  const details =
    record?.details !== null && typeof record?.details === 'object'
      ? (record.details as Record<string, unknown>)
      : {}
  return new CrewStationApiError(response.status, kind, message, details)
}

export function createCrewStationPlatformApi(
  options: CrewStationPlatformApiOptions,
): CrewStationPlatformApi {
  const fetcher = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS)
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const base = options.baseUrl.replace(/\/+$/, '')

  const request = async <T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    retry = true,
  ): Promise<T> => {
    const totalAttempts = retry ? attempts : 1
    let lastError: unknown
    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      let response: Response
      const deadline = timeoutSignal(timeoutMs)
      try {
        response = await fetcher(`${base}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: deadline.signal,
        })
      } catch (error) {
        deadline.cancel()
        // Transport failures leave the outcome unknown; the unchanged
        // requestKey makes the retry a lookup of the original operation.
        lastError = error
        if (attempt + 1 < totalAttempts) await sleep(Math.min(500 * 2 ** attempt, 5_000))
        continue
      }
      if (response.ok) {
        try {
          const text = await response.text()
          return (text.length === 0 ? undefined : JSON.parse(text)) as T
        } finally {
          deadline.cancel()
        }
      }
      deadline.cancel()
      if ((response.status === 429 || response.status === 503) && attempt + 1 < totalAttempts) {
        lastError = await errorOf(response)
        await sleep(retryAfterMs(response, attempt))
        continue
      }
      throw await errorOf(response)
    }
    throw lastError instanceof Error ? lastError : new Error('CrewStation request failed')
  }

  return Object.freeze({
    get<T>(path: string, query?: Readonly<Record<string, string | number | undefined>>) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) search.set(key, String(value))
      }
      const suffix = search.size === 0 ? '' : `?${search.toString()}`
      return request<T>('GET', `${path}${suffix}`)
    },
    post<T>(path: string, body: unknown, options?: { readonly retry: false }) {
      return request<T>('POST', path, body, options?.retry !== false)
    },
    async *stream<T>(
      path: string,
      query: Readonly<Record<string, string | number | undefined>>,
      signal?: AbortSignal,
    ) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) search.set(key, String(value))
      }
      const streamWindow = timeoutSignal(options.streamWindowMs ?? Math.max(timeoutMs, 35_000))
      const timeout = streamWindow.signal
      let response: Response
      try {
        response = await fetcher(`${base}${path}?${search}`, {
          headers: { accept: 'text/event-stream' },
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        })
      } catch (error) {
        streamWindow.cancel()
        throw error
      }
      if (!response.ok) {
        streamWindow.cancel()
        throw await errorOf(response)
      }
      if (response.body === null) {
        streamWindow.cancel()
        throw new Error('CrewStation returned an empty event stream')
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let data: string[] = []
      try {
        while (true) {
          const part = await reader.read()
          buffer += decoder.decode(part.value, { stream: !part.done })
          // An event is at most 256 KiB in the v3 contract. Include framing
          // overhead, and fail a broken stream before accumulating indefinitely.
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '')
            if (line.length + data.join('\n').length > 512 * 1024) {
              throw new Error('CrewStation event exceeds the v3 event limit')
            }
            buffer = buffer.slice(newline + 1)
            if (line === '') {
              if (data.length > 0) yield JSON.parse(data.join('\n')) as T
              data = []
            } else if (line.startsWith('data:')) {
              data.push(line.slice(5).replace(/^ /, ''))
            }
          }
          if (buffer.length + data.join('\n').length > 512 * 1024) {
            throw new Error('CrewStation event exceeds the v3 event limit')
          }
          if (part.done) return
        }
      } catch (error) {
        // A connection that delivered headers is deliberately bounded. Its
        // normal rotation resumes through the caller's durable cursor; only
        // actual stream failures count toward the outage budget. A caller's
        // cancellation still propagates so it can perform the cancel protocol.
        if (!timeout.aborted || signal?.aborted) throw error
      } finally {
        streamWindow.cancel()
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    },
  })
}
