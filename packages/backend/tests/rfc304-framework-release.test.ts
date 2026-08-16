// RFC-304 §11.5 (T63) — the release lifecycle, and the failure it is shaped for.
//
// Publishing a department framework changes every repository at once: 200 repos
// share one `classify`/`arbitrate`, ~150 executions a day. But the failure this
// lifecycle is built around is NOT the script crashing.
//
//   A crash fails in a block, loudly, and somebody notices within the hour.
//   `exit 0` with a WRONG classification emits no failure signal at all — every
//   round "succeeds", and the first evidence is a developer complaining a
//   working day later that reviews have gone strange.
//
// Every gate below is placed to catch the silent kind. A test that only proved
// the loud kind is caught would be testing the easy half.

import { describe, expect, test } from 'bun:test'
import {
  CANARY_FAILURE_THRESHOLD,
  describeBlastRadius,
  judgeCanary,
  judgeTransition,
  judgeValidation,
  RELEASE_STATES,
  resolveRevision,
} from '../src/modules/code-capability/domain/frameworkRelease'

describe('RFC-304 T63 — the lifecycle', () => {
  test('the five states are the documented ones', () => {
    expect([...RELEASE_STATES]).toEqual(['draft', 'validated', 'canary', 'published', 'retired'])
  })

  test('the happy path walks every gate', () => {
    expect(judgeTransition('draft', 'validated').allowed).toBe(true)
    expect(judgeTransition('validated', 'canary').allowed).toBe(true)
    expect(judgeTransition('canary', 'published').allowed).toBe(true)
    expect(judgeTransition('published', 'retired').allowed).toBe(true)
  })

  test('draft → published is REFUSED, and the message says why', () => {
    // The single most important refusal here. A "publish now" shortcut gets
    // used exactly when somebody is in a hurry — which is when they are most
    // likely to be shipping the silent-wrong kind of change.
    const verdict = judgeTransition('draft', 'published')
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('exits 0')
  })

  test('validation and canary can fall back to draft', () => {
    // Failing validation is ordinary. Without a way back the author's only
    // options would be "retired" or nothing, and they would stop using the
    // gates rather than the gates catching anything.
    expect(judgeTransition('validated', 'draft').allowed).toBe(true)
    expect(judgeTransition('canary', 'draft').allowed).toBe(true)
  })

  test('retired is terminal — re-publishing means a NEW revision', () => {
    // Keeps the history a straight line. A revision that could come back would
    // make "which one ran on the 3rd" unanswerable.
    for (const to of RELEASE_STATES) {
      expect(judgeTransition('retired', to).allowed, `retired → ${to}`).toBe(false)
    }
  })
})

describe('RFC-304 T63 — which revision a binding runs', () => {
  const known = [1, 2, 3]

  test('a pin wins over whatever is published', () => {
    const r = resolveRevision({
      selector: { kind: 'pinned', revision: 1 },
      publishedRevision: 3,
      canaryRevision: null,
      knownRevisions: known,
    })
    expect(r).toEqual({ ok: true, revision: 1, source: 'pinned' })
  })

  test('a pin to a RETIRED revision still resolves', () => {
    // That is what pinning is for. Silently upgrading somebody who deliberately
    // pinned would defeat the only mechanism they have for staying put.
    const r = resolveRevision({
      selector: { kind: 'pinned', revision: 1 },
      publishedRevision: 3,
      canaryRevision: null,
      knownRevisions: [1, 2, 3],
    })
    expect(r.ok).toBe(true)
  })

  test('a pin to a revision that never existed FAILS rather than falling back', () => {
    // Quietly running something other than what the binding names is how a team
    // ends up debugging a framework they are not using.
    const r = resolveRevision({
      selector: { kind: 'pinned', revision: 99 },
      publishedRevision: 3,
      canaryRevision: null,
      knownRevisions: known,
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('no longer exists')
  })

  test('a channel follower gets the published revision', () => {
    const r = resolveRevision({
      selector: { kind: 'channel', channel: 'stable' },
      publishedRevision: 3,
      canaryRevision: 4,
      knownRevisions: [1, 2, 3, 4],
    })
    expect(r).toEqual({ ok: true, revision: 3, source: 'channel' })
  })

  test('the canary channel is separate from stable', () => {
    const r = resolveRevision({
      selector: { kind: 'channel', channel: 'canary' },
      publishedRevision: 3,
      canaryRevision: 4,
      knownRevisions: [1, 2, 3, 4],
    })
    expect(r.ok === true && r.revision).toBe(4)
  })

  test('an empty channel fails rather than picking something', () => {
    const r = resolveRevision({
      selector: { kind: 'channel', channel: 'stable' },
      publishedRevision: null,
      canaryRevision: 4,
      knownRevisions: [4],
    })
    expect(r.ok).toBe(false)
  })
})

describe('RFC-304 T63 — the replay gate', () => {
  test('all samples matching passes', () => {
    const v = judgeValidation([
      { sample: 'compile-error', matched: true },
      { sample: 'flaky-test', matched: true },
    ])
    expect(v.passed).toBe(true)
  })

  test('an EMPTY sample set fails rather than passing vacuously', () => {
    // Otherwise the gate that exists to catch silent-wrong scripts becomes a
    // rubber stamp — and most often for a brand-new framework, which is the
    // least-tested kind.
    const v = judgeValidation([])
    expect(v.passed).toBe(false)
    expect(v.message).toContain('vacuously')
  })

  test('a mismatch names the samples, not just the count', () => {
    // The author's next action is to open one of them. A bare count sends them
    // to re-run everything to find out which.
    const v = judgeValidation([
      { sample: 'compile-error', matched: true },
      { sample: 'flaky-test', matched: false, actual: { type: 'compile' } },
    ])
    expect(v.passed).toBe(false)
    expect(v.message).toContain('flaky-test')
    expect(v.mismatches).toHaveLength(1)
  })
})

describe('RFC-304 T63 — the canary', () => {
  test('too few rounds HOLDS rather than promoting', () => {
    // Two rounds both passing says almost nothing; promoting on it turns the
    // canary into a delay that carries no information.
    const v = judgeCanary({ rounds: 2, failures: 0 })
    expect(v.action).toBe('hold')
    expect(v.message).toContain('not enough')
  })

  test('a clean canary promotes', () => {
    expect(judgeCanary({ rounds: 20, failures: 0 }).action).toBe('promote')
  })

  test('a modest excess of failures rolls back', () => {
    // The threshold is low on purpose: a WRONG framework shows up as a modest
    // excess, not a cliff. A threshold set where a crash would trip it would
    // sail straight past the failure mode this lifecycle exists for.
    const v = judgeCanary({ rounds: 20, failures: 3 })
    expect(v.action).toBe('roll-back')
    expect(CANARY_FAILURE_THRESHOLD).toBeLessThanOrEqual(0.15)
  })

  test('exactly at the threshold promotes rather than rolling back', () => {
    // Stated so the boundary is a decision rather than an accident of `>` vs
    // `>=` — someone will change this line eventually and should see which way
    // it was meant.
    expect(judgeCanary({ rounds: 10, failures: 1 }).action).toBe('promote')
  })
})

describe('RFC-304 T63 — the blast radius is shown before publishing', () => {
  test('the count is in the sentence', () => {
    // "Publish?" invites yes. "Publish to 187 repositories?" is a different
    // question, and it is the one the author is actually answering.
    expect(describeBlastRadius(187)).toContain('187')
    expect(describeBlastRadius(187)).toContain('immediately')
  })

  test('one repository is not written as “1 repositories”', () => {
    expect(describeBlastRadius(1)).toContain('1 repository')
  })

  test('nobody following says so plainly', () => {
    expect(describeBlastRadius(0)).toContain('No repository')
  })
})
