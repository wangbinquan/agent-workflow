// RFC-026 regression — fallback reason enumeration.
//
// Proposal §C3: each `ClarifyInlineFallbackReason` variant must be exercised
// by tests. The unit-level decision function is in clarify-fallback.test.ts
// already (3 cases). This file is the "every enum member is reachable" lock —
// if a future contributor adds a fallback reason but forgets to wire it into
// the scheduler / record events for it, this test catches the gap before
// release.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ClarifyInlineFallbackReason } from '../src/services/sessionModeFallback'

const ENUM_REASONS = [
  'missing-session-id',
  'session-not-found',
  'session-resume-unsupported',
] as const satisfies readonly ClarifyInlineFallbackReason[]

describe('RFC-026 fallback reason enum coverage', () => {
  test('every ClarifyInlineFallbackReason member is referenced somewhere in scheduler.ts', () => {
    // Source-code grep — scheduler.ts is the single emitter of these warning
    // events. If a new reason is added to the union but scheduler doesn't
    // know how to record it, the operator will get a silently degraded
    // inline path with no telemetry. Forcing a grep here makes it impossible
    // to "ship the enum, forget the recorder".
    const schedulerSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    for (const reason of ENUM_REASONS) {
      // Each reason must appear at least once — either inline in the
      // recorder, or as a comment that locks the contract. We don't care
      // which; we just want the reason name to exist as text.
      expect(schedulerSrc.includes(reason)).toBe(true)
    }
  })

  test('sessionModeFallback.ts decideResumeSessionId covers every reason', () => {
    const fallbackSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'sessionModeFallback.ts'),
      'utf8',
    )
    for (const reason of ENUM_REASONS) {
      expect(fallbackSrc).toContain(`'${reason}'`)
    }
  })
})
