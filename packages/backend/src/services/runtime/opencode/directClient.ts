// RFC-224 — authenticated, loopback-only client for the pinned OpenCode server.

import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'
import {
  CreateSessionRequestSchema,
  GlobalSessionInfoSchema,
  JsonValueSchema,
  PromptRequestSchema,
  SessionIdSchema,
  SessionInfoSchema,
  SESSION_INVENTORY_PAGE_SIZE,
  WithPartsSchema,
  parseDirectApiValue,
  type CreateSessionRequest,
  type GlobalSessionInfo,
  type PromptRequest,
  type SessionInfo,
  type WireEvent,
  type WithParts,
} from './directApiSchemas'
import { parseSseStream, type SseBudgets } from './sse'

export type DirectFetch = (url: string, init: RequestInit) => Promise<Response>

export interface DirectClientBudgets {
  maxJsonBytes: number
  requestTimeoutMs: number
  sse?: Partial<SseBudgets>
}

export const DEFAULT_DIRECT_CLIENT_BUDGETS: Readonly<DirectClientBudgets> = Object.freeze({
  maxJsonBytes: 4 * 1024 * 1024,
  requestTimeoutMs: 30_000,
})

export class DirectHttpError extends Error {
  readonly reason: string
  readonly status?: number

  constructor(reason: string, status?: number) {
    super(`OpenCode direct HTTP error: ${reason}${status === undefined ? '' : ` (${status})`}`)
    this.name = 'DirectHttpError'
    this.reason = reason
    this.status = status
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be positive`)
  return value
}

function normalizeOrigin(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new TypeError('origin must be an absolute loopback URL')
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new TypeError('origin must be http://127.0.0.1:<port>')
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('origin has an invalid port')
  }
  return `http://127.0.0.1:${port}`
}

function validateDirectory(input: string): string {
  if (
    input.includes('\0') ||
    !isAbsolute(input) ||
    normalize(input) !== input ||
    input.length === 0
  ) {
    throw new TypeError('directory must be a normalized canonical absolute path')
  }
  return input
}

function validateBasicCredential(field: 'username' | 'password', value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n') ||
    (field === 'username' && value.includes(':'))
  ) {
    throw new TypeError(`invalid Basic auth ${field}`)
  }
  return value
}

function contentType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) throw new DirectHttpError('missing-body', response.status)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (next.value === undefined) throw new DirectHttpError('empty-body-chunk', response.status)
      total += next.value.byteLength
      if (total > maxBytes) throw new DirectHttpError('body-budget-exceeded', response.status)
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function decodeJson(bytes: Uint8Array, status: number): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new DirectHttpError('invalid-utf8', status)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DirectHttpError('malformed-json', status)
  }
}

interface RequestOptions {
  method: 'GET' | 'POST'
  path: string
  query?: ReadonlyArray<readonly [string, string]>
  body?: unknown
  signal?: AbortSignal
  accept: 'application/json' | 'text/event-stream'
}

interface PendingResponse {
  response: Response
  cleanup: (abort?: boolean) => void
}

export interface InventoryHttpPage {
  sessions: GlobalSessionInfo[]
  nextCursorHeader: string | null
}

export class OpencodeDirectClient {
  readonly #origin: string
  readonly #directory: string
  readonly #authorization: string
  readonly #fetch: DirectFetch
  readonly #budgets: DirectClientBudgets

  constructor(input: {
    origin: string
    directory: string
    username: string
    password: string
    fetch?: DirectFetch
    budgets?: Partial<DirectClientBudgets>
  }) {
    this.#origin = normalizeOrigin(input.origin)
    this.#directory = validateDirectory(input.directory)
    const username = validateBasicCredential('username', input.username)
    const password = validateBasicCredential('password', input.password)
    this.#authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
    this.#fetch = input.fetch ?? ((url, init) => fetch(url, init))
    const budgets = { ...DEFAULT_DIRECT_CLIENT_BUDGETS, ...input.budgets }
    this.#budgets = {
      maxJsonBytes: positiveInteger(budgets.maxJsonBytes, 'maxJsonBytes'),
      requestTimeoutMs: positiveInteger(budgets.requestTimeoutMs, 'requestTimeoutMs'),
      ...(budgets.sse === undefined ? {} : { sse: budgets.sse }),
    }
  }

  async createSession(body: CreateSessionRequest, signal?: AbortSignal): Promise<SessionInfo> {
    const request = parseDirectApiValue(CreateSessionRequestSchema, body, 'create-request')
    return this.#jsonRequest(
      SessionInfoSchema,
      {
        method: 'POST',
        path: '/session',
        body: request,
        signal,
        accept: 'application/json',
      },
      'create-response',
    )
  }

  /** Same-instance identity endpoints. Values stay pinned to finite plain JSON;
   * the complete semantic comparison lives in executionIdentity.ts. */
  async getConfig(signal?: AbortSignal): Promise<unknown> {
    return this.#jsonRequest(
      JsonValueSchema,
      { method: 'GET', path: '/config', signal, accept: 'application/json' },
      'config-response',
    )
  }

  async getConfigProviders(signal?: AbortSignal): Promise<unknown> {
    return this.#jsonRequest(
      JsonValueSchema,
      { method: 'GET', path: '/config/providers', signal, accept: 'application/json' },
      'providers-response',
    )
  }

  async getAgents(signal?: AbortSignal): Promise<unknown> {
    return this.#jsonRequest(
      JsonValueSchema,
      { method: 'GET', path: '/agent', signal, accept: 'application/json' },
      'agents-response',
    )
  }

  async getSkills(signal?: AbortSignal): Promise<unknown> {
    return this.#jsonRequest(
      JsonValueSchema,
      { method: 'GET', path: '/skill', signal, accept: 'application/json' },
      'skills-response',
    )
  }

  async listRootSessions(input: {
    title: string
    cursor?: number
    signal?: AbortSignal
  }): Promise<InventoryHttpPage> {
    if (input.title.length === 0) throw new TypeError('title must not be empty')
    if (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || input.cursor < 0)) {
      throw new TypeError('cursor must be a non-negative safe integer')
    }
    const pending = await this.#request({
      method: 'GET',
      path: '/experimental/session',
      query: [
        ['roots', 'true'],
        ['search', input.title],
        ['limit', String(SESSION_INVENTORY_PAGE_SIZE)],
        ...(input.cursor === undefined ? [] : ([['cursor', String(input.cursor)]] as const)),
      ],
      signal: input.signal,
      accept: 'application/json',
    })
    try {
      const value = await this.#readJsonResponse(pending.response)
      return {
        sessions: parseDirectApiValue(
          z.array(GlobalSessionInfoSchema).max(SESSION_INVENTORY_PAGE_SIZE),
          value,
          'session-inventory',
        ),
        nextCursorHeader: pending.response.headers.get('x-next-cursor'),
      }
    } finally {
      pending.cleanup()
    }
  }

  async getLatestMessage(sessionID: string, signal?: AbortSignal): Promise<WithParts[]> {
    const id = parseDirectApiValue(SessionIdSchema, sessionID, 'session-id')
    return this.#jsonRequest(
      z.array(WithPartsSchema).max(1),
      {
        method: 'GET',
        path: `/session/${encodeURIComponent(id)}/message`,
        query: [['limit', '1']],
        signal,
        accept: 'application/json',
      },
      'message-inventory',
    )
  }

  async postMessage(
    sessionID: string,
    body: PromptRequest,
    signal?: AbortSignal,
  ): Promise<WithParts> {
    const id = parseDirectApiValue(SessionIdSchema, sessionID, 'session-id')
    const request = parseDirectApiValue(PromptRequestSchema, body, 'prompt-request')
    return this.#jsonRequest(
      WithPartsSchema,
      {
        method: 'POST',
        path: `/session/${encodeURIComponent(id)}/message`,
        body: request,
        signal,
        accept: 'application/json',
      },
      'prompt-response',
    )
  }

  async abortSession(sessionID: string, signal?: AbortSignal): Promise<boolean> {
    const id = parseDirectApiValue(SessionIdSchema, sessionID, 'session-id')
    return this.#jsonRequest(
      z.boolean(),
      {
        method: 'POST',
        path: `/session/${encodeURIComponent(id)}/abort`,
        signal,
        accept: 'application/json',
      },
      'abort-response',
    )
  }

  async subscribeEvents(signal?: AbortSignal): Promise<AsyncGenerator<WireEvent>> {
    const pending = await this.#request({
      method: 'GET',
      path: '/event',
      signal,
      accept: 'text/event-stream',
    })
    const { response } = pending
    if (contentType(response) !== 'text/event-stream') {
      await response.body?.cancel().catch(() => undefined)
      pending.cleanup()
      throw new DirectHttpError('unexpected-content-type', response.status)
    }
    if (response.body === null) {
      pending.cleanup()
      throw new DirectHttpError('missing-body', response.status)
    }
    const stream = response.body
    const budgets = this.#budgets.sse
    async function* events(): AsyncGenerator<WireEvent> {
      try {
        yield* parseSseStream(stream, budgets)
      } finally {
        pending.cleanup(true)
      }
    }
    return events()
  }

  async #jsonRequest<T>(
    schema: z.ZodType<T>,
    options: RequestOptions,
    context: string,
  ): Promise<T> {
    const pending = await this.#request(options)
    try {
      const value = await this.#readJsonResponse(pending.response)
      return parseDirectApiValue(schema, value, context)
    } finally {
      pending.cleanup()
    }
  }

  async #readJsonResponse(response: Response): Promise<unknown> {
    if (contentType(response) !== 'application/json') {
      response.body?.cancel().catch(() => undefined)
      throw new DirectHttpError('unexpected-content-type', response.status)
    }
    return decodeJson(await readBoundedBody(response, this.#budgets.maxJsonBytes), response.status)
  }

  async #request(options: RequestOptions): Promise<PendingResponse> {
    if (
      !options.path.startsWith('/') ||
      options.path.startsWith('//') ||
      options.path.includes('?') ||
      options.path.includes('#')
    ) {
      throw new TypeError('invalid direct API path')
    }
    const url = new URL(`${this.#origin}${options.path}`)
    url.searchParams.append('directory', this.#directory)
    for (const [key, value] of options.query ?? []) {
      if (key === 'directory') throw new TypeError('directory query is client-owned')
      url.searchParams.append(key, value)
    }

    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) abortFromCaller()
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error('direct-request-timeout')),
      this.#budgets.requestTimeoutMs,
    )
    timer.unref?.()

    const headers: Record<string, string> = {
      Accept: options.accept,
      Authorization: this.#authorization,
    }
    let body: string | undefined
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.body)
    }

    let cleaned = false
    const cleanup = (abort = false) => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortFromCaller)
      if (abort && !controller.signal.aborted) controller.abort(new Error('direct-request-closed'))
    }

    let response: Response
    try {
      response = await this.#fetch(url.toString(), {
        method: options.method,
        headers,
        redirect: 'error',
        signal: controller.signal,
        ...(body === undefined ? {} : { body }),
      })
    } catch {
      cleanup()
      throw new DirectHttpError(controller.signal.aborted ? 'request-aborted' : 'request-failed')
    }
    if (response.status < 200 || response.status >= 300 || response.redirected) {
      await response.body?.cancel().catch(() => undefined)
      cleanup()
      throw new DirectHttpError('unexpected-status', response.status)
    }
    return { response, cleanup }
  }
}
