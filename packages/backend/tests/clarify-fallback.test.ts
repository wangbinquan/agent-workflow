// RFC-026 T5 — clarifyFallback decision + stderr detection.
//
// Locks the three-way fallback contract from proposal §2.1 #5 (auto-degrade
// to isolated when inline can't run safely):
//   - isolated  → never inline, no warning
//   - missing source session id → fallback `missing-session-id`
//   - unsupported opencode CLI  → fallback `unsupported-opencode-version`
// Plus stderr pattern matching that flips the post-spawn path into
// `session-not-found`. If any of these go red, inline-mode's "fail soft to
// isolated, never hard-fail the task" guarantee is broken.

import { describe, expect, test } from 'bun:test'
import {
  decideResumeSessionId,
  detectSessionNotFoundFromStderr,
} from '../src/services/sessionModeFallback'

describe('RFC-026 decideResumeSessionId', () => {
  test('isolated mode never inline-rerides and emits no fallback warning', () => {
    expect(decideResumeSessionId({ sessionMode: 'isolated', sourceSessionId: 'opc_x' })).toEqual({
      inlineMode: false,
    })
  })

  test('inline + non-empty session id → resume', () => {
    expect(decideResumeSessionId({ sessionMode: 'inline', sourceSessionId: 'opc_abc' })).toEqual({
      inlineMode: true,
      resumeSessionId: 'opc_abc',
    })
  })

  test('inline + missing session id → fallback missing-session-id, NO resume', () => {
    for (const sid of [null, undefined, ''] as const) {
      expect(decideResumeSessionId({ sessionMode: 'inline', sourceSessionId: sid })).toEqual({
        inlineMode: false,
        fallbackReason: 'missing-session-id',
      })
    }
  })

  test('inline + opencode-without-support → fallback unsupported-opencode-version', () => {
    expect(
      decideResumeSessionId({
        sessionMode: 'inline',
        sourceSessionId: 'opc_abc',
        opencodeSupportsResume: false,
      }),
    ).toEqual({
      inlineMode: false,
      fallbackReason: 'unsupported-opencode-version',
    })
  })
})

describe('RFC-026 detectSessionNotFoundFromStderr', () => {
  test('empty stderr returns false (no false positives)', () => {
    expect(detectSessionNotFoundFromStderr('')).toBe(false)
  })

  test('common opencode-style "session not found" phrasings are detected', () => {
    const samples = [
      'error: session not found',
      'fatal: unknown session id\n',
      'Session ses_xxx does not exist on this host',
      'no such session: ses_xxx',
    ]
    for (const s of samples) {
      expect(detectSessionNotFoundFromStderr(s)).toBe(true)
    }
  })

  test('unrelated errors (network / fs / auth) do NOT trigger a false positive', () => {
    const negatives = [
      'connection reset by peer',
      'ENOENT: no such file or directory, /tmp/foo',
      'permission denied (publickey)',
      'failed to spawn child process',
      "git: 'session' is not a git command", // word "session" alone is fine
    ]
    for (const s of negatives) {
      expect(detectSessionNotFoundFromStderr(s)).toBe(false)
    }
  })
})
