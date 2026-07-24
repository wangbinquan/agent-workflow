// RFC-026 PR-B T12 — pure parser for the scheduler's RFC-026 event payloads.
//
// Locks the prefix contract `[rfc026/inline-session-resumed]` /
// `[rfc026/inline-fallback]` in lock-step with `services/scheduler.ts`
// (where the backend writes them). Changing the prefix on one side without
// the other would silently break the chip + event styling in the UI.

import { describe, expect, it } from 'vitest'
import { parseRfc026Event, isRfc026EventPayload } from '../src/lib/rfc026-events'

describe('parseRfc026Event', () => {
  it('parses the success info payload', () => {
    const payload =
      '[rfc026/inline-session-resumed] {"rfc":"rfc026","code":"clarify-session-resumed","sessionIdPrefix":"opc_abcd","clarifyGeneration":1}'
    const got = parseRfc026Event(payload)
    expect(got).toEqual({
      level: 'info',
      code: 'clarify-session-resumed',
      sessionIdPrefix: 'opc_abcd',
      clarifyGeneration: 1,
      raw: payload,
    })
  })

  it('parses the warning payload for each fallback reason', () => {
    for (const reason of [
      'missing-session-id',
      'session-not-found',
      'session-resume-unsupported',
    ] as const) {
      const payload = `[rfc026/inline-fallback] {"rfc":"rfc026","code":"inline-clarify-fallback-to-isolated","reason":"${reason}","clarifyGeneration":2}`
      const got = parseRfc026Event(payload)
      expect(got).not.toBeNull()
      expect(got!.level).toBe('warning')
      expect(got!.code).toBe('inline-clarify-fallback-to-isolated')
      // narrow the union for the field access
      if (got!.level === 'warning') {
        expect(got!.reason).toBe(reason)
        expect(got!.clarifyGeneration).toBe(2)
      }
    }
  })

  it('returns null for unrelated payloads (defaults render path keeps working)', () => {
    expect(parseRfc026Event('hello world')).toBeNull()
    expect(parseRfc026Event('{"foo":"bar"}')).toBeNull()
    expect(parseRfc026Event('')).toBeNull()
  })

  it('returns null when the prefix matches but JSON is malformed', () => {
    expect(parseRfc026Event('[rfc026/inline-fallback] {not json')).toBeNull()
  })

  it('returns null when code or reason is not one of the documented values', () => {
    // wrong code under the info tag → not RFC-026 info
    expect(
      parseRfc026Event(
        '[rfc026/inline-session-resumed] {"rfc":"rfc026","code":"other","sessionIdPrefix":"opc_x"}',
      ),
    ).toBeNull()
    // wrong reason under the warn tag → not a documented fallback
    expect(
      parseRfc026Event(
        '[rfc026/inline-fallback] {"rfc":"rfc026","code":"inline-clarify-fallback-to-isolated","reason":"who-knows"}',
      ),
    ).toBeNull()
  })

  it('isRfc026EventPayload narrows to the two known prefixes', () => {
    expect(isRfc026EventPayload('[rfc026/inline-session-resumed] {}')).toBe(true)
    expect(isRfc026EventPayload('[rfc026/inline-fallback] {}')).toBe(true)
    expect(isRfc026EventPayload('[rfc999/something] {}')).toBe(false)
    expect(isRfc026EventPayload('plain text')).toBe(false)
  })
})
