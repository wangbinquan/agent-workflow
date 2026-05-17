// RFC-031 T10 — parse contract for plugin-load-failed event payloads.

import { describe, expect, test } from 'vitest'
import { isRfc031EventPayload, parseRfc031Event } from '../src/lib/rfc031-events'

const goodPayload = (extras: Record<string, unknown> = {}) =>
  `[rfc031/plugin-load-failed] ${JSON.stringify({
    rfc: 'RFC-031',
    code: 'plugin-load-failed',
    pluginName: 'dd-trace',
    message: 'TypeError: Cannot read properties of undefined',
    ...extras,
  })}`

describe('isRfc031EventPayload', () => {
  test('matches plugin-load-failed prefix', () => {
    expect(isRfc031EventPayload(goodPayload())).toBe(true)
  })

  test('rejects unrelated text', () => {
    expect(isRfc031EventPayload('hello world')).toBe(false)
    expect(isRfc031EventPayload('[rfc026/inline-fallback] {}')).toBe(false)
  })
})

describe('parseRfc031Event', () => {
  test('returns null for non-RFC-031 payloads', () => {
    expect(parseRfc031Event('hello')).toBeNull()
    expect(parseRfc031Event('[rfc026/inline-session-resumed] {}')).toBeNull()
  })

  test('happy path decodes pluginName + message', () => {
    const r = parseRfc031Event(goodPayload())
    expect(r?.level).toBe('warning')
    expect(r?.code).toBe('plugin-load-failed')
    expect(r?.pluginName).toBe('dd-trace')
    expect(r?.message).toContain('TypeError')
  })

  test('returns null when JSON body is unparseable', () => {
    expect(parseRfc031Event('[rfc031/plugin-load-failed] not-json')).toBeNull()
  })

  test('returns null when code field disagrees with prefix', () => {
    const payload = `[rfc031/plugin-load-failed] ${JSON.stringify({
      code: 'something-else',
      pluginName: 'x',
      message: 'y',
    })}`
    expect(parseRfc031Event(payload)).toBeNull()
  })

  test('missing pluginName defaults to empty string', () => {
    const payload = `[rfc031/plugin-load-failed] ${JSON.stringify({
      code: 'plugin-load-failed',
      message: 'm',
    })}`
    const r = parseRfc031Event(payload)
    expect(r?.pluginName).toBe('')
  })
})
