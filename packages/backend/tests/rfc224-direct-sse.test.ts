// RFC-224 regression lock: the direct codec must parse OpenCode SSE under
// arbitrary transport chunking without accepting browser-only wire drift.

import { describe, expect, test } from 'bun:test'
import { BoundedSseParser, SseProtocolError, parseSseStream } from '@/services/runtime/opencode/sse'

const event = {
  id: 'evt_000000001001AAAAAAAAAAAAAA',
  type: 'server.connected',
  properties: {},
}

function frame(value: Record<string, unknown> = event, eol = '\n'): string {
  return `event: message${eol}data: ${JSON.stringify(value)}${eol}${eol}`
}

describe('RFC-224 bounded SSE parser', () => {
  test('supports arbitrary UTF-8 chunks, CRLF, comments, and multiple data lines', () => {
    const parser = new BoundedSseParser()
    const json = JSON.stringify({
      ...event,
      properties: { note: '你好' },
    })
    const split = json.indexOf(',"type"')
    const input =
      ': proxy heartbeat\r\n\r\n' +
      `event: message\r\ndata: ${json.slice(0, split + 1)}\r\n` +
      `data: ${json.slice(split + 1)}\r\n\r\n`
    const bytes = new TextEncoder().encode(input)
    const output = []
    for (const byte of bytes) output.push(...parser.push(new Uint8Array([byte])))
    output.push(...parser.finish())
    expect(output).toEqual([
      {
        ...event,
        properties: { note: '你好' },
      },
    ])
  })

  test('accepts LF and bare CR event terminators', () => {
    const lf = new BoundedSseParser()
    expect(lf.push(frame())).toEqual([event])
    expect(lf.finish()).toEqual([])

    const cr = new BoundedSseParser()
    // A trailing CR may be the first half of CRLF, so it is resolved at EOF.
    expect(cr.push(frame(event, '\r'))).toEqual([])
    expect(cr.finish()).toEqual([event])
  })

  test('requires explicit event: message and rejects extension fields', () => {
    const missing = new BoundedSseParser()
    expect(() => missing.push(`data: ${JSON.stringify(event)}\n\n`)).toThrow('missing-event-name')

    const wrong = new BoundedSseParser()
    expect(() => wrong.push(`event: other\ndata: ${JSON.stringify(event)}\n\n`)).toThrow(
      'unexpected-event-name',
    )

    const duplicate = new BoundedSseParser()
    expect(() =>
      duplicate.push(`event: message\nevent: message\ndata: ${JSON.stringify(event)}\n\n`),
    ).toThrow('duplicate-event-field')

    const browserField = new BoundedSseParser()
    expect(() =>
      browserField.push(`event: message\nid: 1\ndata: ${JSON.stringify(event)}\n\n`),
    ).toThrow('unexpected-field')
  })

  test('rejects invalid UTF-8, malformed JSON, strict-schema drift, and truncation', () => {
    const utf8 = new BoundedSseParser()
    expect(() => utf8.push(new Uint8Array([0xc3, 0x28]))).toThrow('invalid-utf8')

    const json = new BoundedSseParser()
    expect(() => json.push('event: message\ndata: {\n\n')).toThrow('malformed-json')

    const schema = new BoundedSseParser()
    expect(() =>
      schema.push(
        frame({
          ...event,
          extra: true,
        }),
      ),
    ).toThrow('unexpected-field')

    const truncated = new BoundedSseParser()
    truncated.push(`event: message\ndata: ${JSON.stringify(event)}\n`)
    expect(() => truncated.finish()).toThrow('truncated-event')
  })

  test('enforces line, event, buffered, total, and event-count budgets', () => {
    const line = new BoundedSseParser({ maxLineBytes: 8 })
    expect(() => line.push('data: 123456789')).toThrow('line-budget-exceeded')

    const eventBudget = new BoundedSseParser({
      maxLineBytes: 1024,
      maxEventBytes: 14,
    })
    expect(() => eventBudget.push('event: message\n')).toThrow('event-budget-exceeded')

    const total = new BoundedSseParser({ maxTotalBytes: 4 })
    expect(() => total.push('12345')).toThrow('total-budget-exceeded')

    const count = new BoundedSseParser({ maxEvents: 1 })
    count.push(frame())
    expect(() => count.push(frame())).toThrow('event-count-exceeded')
  })

  test('async stream adapter yields parsed events and rejects a dropped partial frame', async () => {
    const chunks = [frame(), 'event: message\ndata: {']
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk === undefined) {
          controller.close()
          return
        }
        controller.enqueue(new TextEncoder().encode(chunk))
      },
    })
    const iterator = parseSseStream(stream)
    expect((await iterator.next()).value).toEqual(event)
    let error: unknown
    try {
      await iterator.next()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(SseProtocolError)
    expect((error as SseProtocolError).reason).toBe('truncated-event')
  })
})
