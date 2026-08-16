// RFC-304 §6.4 (E9) — what "three attempts" is three attempts AT.
//
// The quota is keyed by `(work item, failure fingerprint)`, and the two ways to
// get this wrong are opposite and both bad:
//
//   too STABLE (keyed by work item alone) — a long-lived merge request loses
//   automatic repair permanently the third time it meets any CI problem, even
//   three unrelated ones months apart. Nobody can see it happen: the quota was
//   spent by failures the author has forgotten.
//
//   too VOLATILE (hashing raw error text) — line numbers, paths and timings
//   make every re-run look like a new failure, the quota never engages, and the
//   platform retries the same broken fix forever.
//
// So most of this file is about normalisation: the same failure must fingerprint
// the same across runs, and a genuinely different one must not.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_FIX_ATTEMPTS,
  fingerprintFailures,
  judgeFixQuota,
  normalizeFailureMessage,
  renderQuotaExhausted,
} from '../src/modules/code-capability/domain/failureFingerprint'
import type { ClassifiedIssue } from '../src/modules/code-capability/domain/monitorContracts'

const issue = (over: Partial<ClassifiedIssue> = {}): ClassifiedIssue => ({
  type: 'compile',
  message: 'cannot find name Foo',
  ...over,
})

describe('RFC-304 E9 — normalising a failure message', () => {
  test('a line/column reference does not make it a new failure', () => {
    expect(normalizeFailureMessage('src/a.ts:12:5 cannot find name Foo')).toBe(
      normalizeFailureMessage('src/a.ts:88:1 cannot find name Foo'),
    )
  })

  test('an absolute worktree path does not either', () => {
    // The worktree is per-round, so every single run has a different one. This
    // alone would disable the quota completely.
    expect(normalizeFailureMessage('/tmp/aw-round-abc/src/a.ts failed to compile')).toBe(
      normalizeFailureMessage('/tmp/aw-round-xyz/src/a.ts failed to compile'),
    )
  })

  test('durations, timestamps and job ids are all volatile', () => {
    expect(normalizeFailureMessage('timed out after 5001ms')).toBe(
      normalizeFailureMessage('timed out after 4998ms'),
    )
    expect(normalizeFailureMessage('job 8821 failed')).toBe(
      normalizeFailureMessage('job 9902 failed'),
    )
    expect(normalizeFailureMessage('at 2026-08-16T02:00:00Z the build broke')).toBe(
      normalizeFailureMessage('at 2026-08-15T21:14:03Z the build broke'),
    )
  })

  test('a commit sha is volatile', () => {
    expect(normalizeFailureMessage('build of a1b2c3d4e5f failed')).toBe(
      normalizeFailureMessage('build of 9988776655f failed'),
    )
  })

  test('a genuinely different message still differs', () => {
    // The other direction: over-normalising would collapse distinct failures
    // into one quota and stop repair on a problem nobody has tried yet.
    expect(normalizeFailureMessage('cannot find name Foo')).not.toBe(
      normalizeFailureMessage('cannot find name Bar'),
    )
  })

  test('case and whitespace do not matter', () => {
    expect(normalizeFailureMessage('  Cannot Find   Name Foo ')).toBe(
      normalizeFailureMessage('cannot find name foo'),
    )
  })
})

describe('RFC-304 E9 — the fingerprint', () => {
  test('the same failure fingerprints the same across runs', () => {
    const a = fingerprintFailures([issue({ file: 'src/a.ts', message: 'src/a.ts:12:5 boom' })])
    const b = fingerprintFailures([issue({ file: 'src/a.ts', message: 'src/a.ts:40:2 boom' })])
    expect(a.digest).toBe(b.digest)
  })

  test('issue ORDER does not change it', () => {
    // A classifier is free to emit in any order; a fingerprint that depended on
    // it would mint a new failure on every run.
    const a = fingerprintFailures([issue({ type: 'compile' }), issue({ type: 'unit-test' })])
    const b = fingerprintFailures([issue({ type: 'unit-test' }), issue({ type: 'compile' })])
    expect(a.digest).toBe(b.digest)
  })

  test('a different failure TYPE is a different failure', () => {
    expect(fingerprintFailures([issue({ type: 'compile' })]).digest).not.toBe(
      fingerprintFailures([issue({ type: 'codecheck' })]).digest,
    )
  })

  test('a different FILE is a different failure', () => {
    expect(fingerprintFailures([issue({ file: 'src/a.ts' })]).digest).not.toBe(
      fingerprintFailures([issue({ file: 'src/b.ts' })]).digest,
    )
  })

  test('an unclassified failure has its own stable fingerprint', () => {
    // "The pipeline is red and we cannot tell why" is a real recurring failure.
    // Left without a fingerprint it would retry forever.
    const a = fingerprintFailures([])
    const b = fingerprintFailures([])
    expect(a.digest).toBe(b.digest)
    expect(a.summary).toContain('unclassified')
  })

  test('the summary is readable, because a person reads it', () => {
    const print = fingerprintFailures([issue({ type: 'compile', file: 'src/retry.ts' })])
    expect(print.summary).toBe('compile in src/retry.ts')
  })
})

describe('RFC-304 E9 — the quota', () => {
  test('three attempts, then stop', () => {
    expect(DEFAULT_FIX_ATTEMPTS).toBe(3)
    expect(judgeFixQuota(0)).toEqual({ allowed: true, attempt: 1, remaining: 2 })
    expect(judgeFixQuota(2)).toEqual({ allowed: true, attempt: 3, remaining: 0 })
    expect(judgeFixQuota(3)).toEqual({ allowed: false, attempts: 3 })
  })

  test('the limit is configurable', () => {
    expect(judgeFixQuota(1, 1).allowed).toBe(false)
    expect(judgeFixQuota(4, 9).allowed).toBe(true)
  })

  test('the exhaustion notice lists every attempt AND what resets it', () => {
    // The reset condition is the part that gets forgotten, and without it the
    // reader concludes automatic repair is permanently off for this merge
    // request — which is untrue and a reason to distrust the whole feature.
    const text = renderQuotaExhausted({ digest: 'd', summary: 'compile in src/retry.ts' }, [
      { attempt: 1, summary: 'added a null check', outcome: 'still red: same error' },
      { attempt: 2, summary: 'reordered the imports', outcome: 'still red: same error' },
      { attempt: 3, summary: 'widened the type', outcome: 'still red: same error' },
    ])

    expect(text).toContain('compile in src/retry.ts')
    expect(text).toContain('1. added a null check')
    expect(text).toContain('3. widened the type')
    expect(text).toContain('needs a person')
    // The reset condition, in words a reader can act on.
    expect(text).toContain('starts again from zero')
  })
})
