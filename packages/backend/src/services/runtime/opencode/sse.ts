// RFC-224 — bounded, strict parser for OpenCode's loopback SSE stream.

import {
  DirectApiValidationError,
  parseDirectApiValue,
  WireEventSchema,
  type WireEvent,
} from './directApiSchemas'

export interface SseBudgets {
  maxLineBytes: number
  maxEventBytes: number
  maxBufferedBytes: number
  maxTotalBytes: number
  maxEvents: number
}

export const DEFAULT_SSE_BUDGETS: Readonly<SseBudgets> = Object.freeze({
  maxLineBytes: 64 * 1024,
  maxEventBytes: 1024 * 1024,
  maxBufferedBytes: 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEvents: 100_000,
})

export class SseProtocolError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`OpenCode SSE protocol error: ${reason}`)
    this.name = 'SseProtocolError'
    this.reason = reason
  }
}

function positiveBudget(value: number, key: keyof SseBudgets): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${key} must be a positive safe integer`)
  }
  return value
}

function normalizeBudgets(overrides?: Partial<SseBudgets>): SseBudgets {
  const merged = { ...DEFAULT_SSE_BUDGETS, ...overrides }
  return {
    maxLineBytes: positiveBudget(merged.maxLineBytes, 'maxLineBytes'),
    maxEventBytes: positiveBudget(merged.maxEventBytes, 'maxEventBytes'),
    maxBufferedBytes: positiveBudget(merged.maxBufferedBytes, 'maxBufferedBytes'),
    maxTotalBytes: positiveBudget(merged.maxTotalBytes, 'maxTotalBytes'),
    maxEvents: positiveBudget(merged.maxEvents, 'maxEvents'),
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Incremental SSE parser. It accepts arbitrary UTF-8 chunk boundaries, CRLF,
 * LF, or CR line endings, multi-line `data:`, and heartbeat comments. The
 * pinned server emits an explicit `event: message`; missing/duplicate/unknown
 * fields are rejected rather than treated as browser-compatible extensions.
 */
export class BoundedSseParser {
  readonly #budgets: SseBudgets
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  #buffer = ''
  #eventName: string | undefined
  #dataLines: string[] = []
  #eventBytes = 0
  #totalBytes = 0
  #eventCount = 0
  #finished = false

  constructor(budgets?: Partial<SseBudgets>) {
    this.#budgets = normalizeBudgets(budgets)
  }

  push(chunk: Uint8Array | string): WireEvent[] {
    if (this.#finished) throw new SseProtocolError('write-after-finish')
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    this.#totalBytes += bytes.byteLength
    if (this.#totalBytes > this.#budgets.maxTotalBytes) {
      throw new SseProtocolError('total-budget-exceeded')
    }

    let decoded: string
    try {
      decoded = this.#decoder.decode(bytes, { stream: true })
    } catch {
      throw new SseProtocolError('invalid-utf8')
    }
    this.#buffer += decoded
    const events = this.#drain(false)
    if (utf8Bytes(this.#buffer) > this.#budgets.maxBufferedBytes) {
      throw new SseProtocolError('buffer-budget-exceeded')
    }
    if (utf8Bytes(this.#buffer) > this.#budgets.maxLineBytes) {
      throw new SseProtocolError('line-budget-exceeded')
    }
    return events
  }

  finish(): WireEvent[] {
    if (this.#finished) throw new SseProtocolError('duplicate-finish')
    this.#finished = true
    try {
      this.#buffer += this.#decoder.decode()
    } catch {
      throw new SseProtocolError('invalid-utf8')
    }
    const events = this.#drain(true)
    if (
      this.#buffer.length !== 0 ||
      this.#eventName !== undefined ||
      this.#dataLines.length !== 0 ||
      this.#eventBytes !== 0
    ) {
      throw new SseProtocolError('truncated-event')
    }
    return events
  }

  #drain(atEof: boolean): WireEvent[] {
    const events: WireEvent[] = []
    while (this.#buffer.length > 0) {
      let lineEnd = -1
      let terminatorBytes = 0
      for (let index = 0; index < this.#buffer.length; index += 1) {
        const char = this.#buffer[index]
        if (char === '\n') {
          lineEnd = index
          terminatorBytes = 1
          break
        }
        if (char === '\r') {
          if (index + 1 === this.#buffer.length && !atEof) return events
          lineEnd = index
          terminatorBytes = this.#buffer[index + 1] === '\n' ? 2 : 1
          break
        }
      }
      if (lineEnd === -1) {
        if (!atEof) return events
        const line = this.#buffer
        this.#buffer = ''
        this.#consumeLine(line, 0, events)
        return events
      }
      const line = this.#buffer.slice(0, lineEnd)
      this.#buffer = this.#buffer.slice(lineEnd + terminatorBytes)
      this.#consumeLine(line, terminatorBytes, events)
    }
    return events
  }

  #consumeLine(line: string, terminatorBytes: number, output: WireEvent[]): void {
    const lineBytes = utf8Bytes(line)
    if (lineBytes > this.#budgets.maxLineBytes) {
      throw new SseProtocolError('line-budget-exceeded')
    }
    this.#eventBytes += lineBytes + terminatorBytes
    if (this.#eventBytes > this.#budgets.maxEventBytes) {
      throw new SseProtocolError('event-budget-exceeded')
    }

    if (line === '') {
      if (this.#eventName === undefined && this.#dataLines.length === 0) {
        this.#eventBytes = 0
        return
      }
      if (this.#eventName !== 'message') {
        throw new SseProtocolError(
          this.#eventName === undefined ? 'missing-event-name' : 'unexpected-event-name',
        )
      }
      if (this.#dataLines.length === 0) throw new SseProtocolError('missing-data')
      const data = this.#dataLines.join('\n')
      let json: unknown
      try {
        json = JSON.parse(data)
      } catch {
        throw new SseProtocolError('malformed-json')
      }
      try {
        output.push(parseDirectApiValue(WireEventSchema, json, 'sse-event'))
      } catch (error) {
        if (error instanceof DirectApiValidationError) {
          throw new SseProtocolError(error.reason)
        }
        throw error
      }
      this.#eventCount += 1
      if (this.#eventCount > this.#budgets.maxEvents) {
        throw new SseProtocolError('event-count-exceeded')
      }
      this.#eventName = undefined
      this.#dataLines = []
      this.#eventBytes = 0
      return
    }

    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') {
      if (this.#eventName !== undefined) throw new SseProtocolError('duplicate-event-field')
      this.#eventName = value
      return
    }
    if (field === 'data') {
      this.#dataLines.push(value)
      return
    }
    // The pinned server never emits browser reconnection fields (`id`, `retry`)
    // or arbitrary extensions. Treat them as version drift.
    throw new SseProtocolError('unexpected-field')
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  budgets?: Partial<SseBudgets>,
): AsyncGenerator<WireEvent, void, void> {
  const parser = new BoundedSseParser(budgets)
  const reader = stream.getReader()
  let ended = false
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        ended = true
        break
      }
      if (result.value === undefined) throw new SseProtocolError('empty-stream-chunk')
      for (const event of parser.push(result.value)) yield event
    }
    for (const event of parser.finish()) yield event
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
