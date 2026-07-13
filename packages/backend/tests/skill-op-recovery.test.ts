// RFC-170 §6a — recovery completeness-theorem oracle.
//
// The crux this locks in: recovery direction is NOT a function of phase alone.
// `fs-published` precedes db-committed in `reserve` (→ rollback) but follows it
// in `version-write` (→ rollforward). Any regression that flattens the oracle to
// a global phase order reds the cross-kind test below. Also pins: strict
// boundary at db-committed (belongs to rollforward), done→noop, and impossible
// (phase ∉ kind spine) → quarantine.

import { describe, expect, test } from 'bun:test'
import type { SkillOpKind, SkillOpPhase } from '../src/services/skillOperations'
import { SKILL_OP_PHASE_SEQUENCES, recoveryDirection } from '../src/services/skillOpRecovery'

const ALL_PHASES: SkillOpPhase[] = [
  'intent',
  'fs-staged',
  'fs-captured',
  'fs-versioned',
  'fs-published',
  'db-committed',
  'done',
]
const ALL_KINDS = Object.keys(SKILL_OP_PHASE_SEQUENCES) as SkillOpKind[]

describe('recoveryDirection — §6a completeness theorem', () => {
  test('db-committed is always rollforward; done is always noop', () => {
    for (const kind of ALL_KINDS) {
      expect(recoveryDirection(kind, 'db-committed')).toBe('rollforward')
      expect(recoveryDirection(kind, 'done')).toBe('noop')
    }
  })

  test('intent is always rollback (pre-authority)', () => {
    for (const kind of ALL_KINDS) {
      expect(recoveryDirection(kind, 'intent')).toBe('rollback')
    }
  })

  test('CRUX: fs-published is rollback in reserve but rollforward in version-write', () => {
    expect(recoveryDirection('reserve', 'fs-published')).toBe('rollback')
    expect(recoveryDirection('version-write', 'fs-published')).toBe('rollforward')
  })

  test('a phase absent from the kind spine → quarantine (impossible state)', () => {
    // reserve never captures; version-write never captures either.
    expect(recoveryDirection('reserve', 'fs-captured')).toBe('quarantine')
    expect(recoveryDirection('delete', 'fs-versioned')).toBe('quarantine')
    // RFC-178: a removed/unknown kind (the DB CHECK still admits the wider
    // superset) has no spine → quarantine, never crash.
    expect(recoveryDirection('adopt-managed' as SkillOpKind, 'fs-captured')).toBe('quarantine')
  })

  test('exhaustive: every (kind, phase) verdict matches the boundary derived from its own spine', () => {
    for (const kind of ALL_KINDS) {
      const spine = SKILL_OP_PHASE_SEQUENCES[kind]
      const boundary = spine.indexOf('db-committed')
      for (const phase of ALL_PHASES) {
        const got = recoveryDirection(kind, phase)
        const idx = spine.indexOf(phase)
        let expected: string
        if (idx === -1) expected = 'quarantine'
        else if (phase === 'done') expected = 'noop'
        else expected = idx < boundary ? 'rollback' : 'rollforward'
        expect(got).toBe(expected as ReturnType<typeof recoveryDirection>)
      }
    }
  })

  test('every kind spine starts at intent, contains db-committed, ends at done', () => {
    for (const kind of ALL_KINDS) {
      const spine = SKILL_OP_PHASE_SEQUENCES[kind]
      expect(spine[0]).toBe('intent')
      expect(spine).toContain('db-committed')
      expect(spine[spine.length - 1]).toBe('done')
    }
  })
})
