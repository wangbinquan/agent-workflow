// RFC-026 — clarifyFallback decideResumeSessionId guard-ORDER precedence.
//
// Supplements clarify-fallback.test.ts / cross-clarify-inline-fallback.test.ts,
// which each exercise ONE failure condition at a time. This file locks the two
// cases where MULTIPLE short-circuits/failures are simultaneously true, so the
// ORDER of the guard clauses in sessionModeFallback.ts (L74 isolated short-circuit,
// L78 strict `opencodeSupportsResume === false`, L81 missing-session-id) is
// pinned down — operators triage off the exact fallbackReason recorded into
// node_run_events, so a refactor that reorders these guards (or loosens the
// strict `=== false` to `!opencodeSupportsResume`) must turn this file red.
//
// Coverage gaps locked (verifier-confirmed real, narrower than originally framed):
//   - version-before-missing-id: when sourceSessionId is null/empty AND
//     opencodeSupportsResume===false, the version reason wins (L78 before L81).
//   - isolated-short-circuit-wins: sessionMode 'isolated' returns {inlineMode:false}
//     with NO fallbackReason even though both inline-failure conditions hold (L74).
//
// (Redundant proposed assertions — inline+valid-id+unsupported, and
// inline+empty-id+undefined-support — are intentionally NOT duplicated here;
// they are already covered by the two existing fallback test files.)

import { describe, expect, test } from 'bun:test'
import { decideResumeSessionId } from '../src/services/sessionModeFallback'

describe('RFC-026 decideResumeSessionId guard precedence (simultaneous failures)', () => {
  test('inline + missing session id + unsupported version → version reason wins (L78 before L81), no resume', () => {
    expect(
      decideResumeSessionId({
        sessionMode: 'inline',
        sourceSessionId: null,
        opencodeSupportsResume: false,
      }),
    ).toEqual({
      inlineMode: false,
      fallbackReason: 'unsupported-opencode-version',
    })
  })

  test('isolated short-circuits (L74) with NO fallbackReason even when both inline-failure conditions hold', () => {
    expect(
      decideResumeSessionId({
        sessionMode: 'isolated',
        sourceSessionId: null,
        opencodeSupportsResume: false,
      }),
    ).toEqual({
      inlineMode: false,
    })
  })
})
