// RFC-170 (T2) — locks the composite precondition-token codec contract:
// round-trip, fail-closed decode of garbage, and the CAS match semantics that
// defeat the same-name delete/recreate ABA + metadata-only bypass.

import { describe, expect, test } from 'bun:test'
import {
  decodeSkillToken,
  encodeSkillToken,
  skillTokenMatches,
  type SkillPreconditionToken,
} from '../src/services/skillToken'

const T = (
  skillId: string,
  contentVersion: number,
  metaRevision: number,
): SkillPreconditionToken => ({
  skillId,
  contentVersion,
  metaRevision,
})

describe('encode/decode round-trip', () => {
  test('a token round-trips exactly', () => {
    const tok = T('sk_01ABC', 3, 7)
    const decoded = decodeSkillToken(encodeSkillToken(tok))
    expect(decoded).toEqual(tok)
  })

  test('the encoded token is an opaque non-empty string (base64url, no JSON structure visible)', () => {
    const s = encodeSkillToken(T('sk_x', 0, 0))
    expect(typeof s).toBe('string')
    expect(s.length).toBeGreaterThan(0)
    expect(s).not.toContain('{')
    expect(s).not.toContain('"')
  })

  test('version 0 / metaRevision 0 (fresh skill) round-trips', () => {
    expect(decodeSkillToken(encodeSkillToken(T('sk_new', 0, 0)))).toEqual(T('sk_new', 0, 0))
  })
})

describe('decode is fail-closed on malformed input', () => {
  test('non-base64 / non-JSON → null', () => {
    expect(decodeSkillToken('')).toBeNull()
    expect(decodeSkillToken('!!!not base64!!!')).toBeNull()
    expect(decodeSkillToken(Buffer.from('not json', 'utf-8').toString('base64url'))).toBeNull()
  })

  test('wrong JSON shape (not a 3-tuple) → null', () => {
    for (const bad of [[], ['a', 1], ['a', 1, 2, 3], { skillId: 'a' }, 'a', 42]) {
      const enc = Buffer.from(JSON.stringify(bad), 'utf-8').toString('base64url')
      expect(decodeSkillToken(enc)).toBeNull()
    }
  })

  test('wrong component types → null', () => {
    const cases: unknown[][] = [
      ['', 1, 1], // empty skillId
      [123, 1, 1], // non-string skillId
      ['a', 1.5, 1], // non-integer contentVersion
      ['a', '1', 1], // string version
      ['a', 1, -1], // negative metaRevision
      ['a', -1, 1], // negative version
      ['a', null, 1],
    ]
    for (const c of cases) {
      const enc = Buffer.from(JSON.stringify(c), 'utf-8').toString('base64url')
      expect(decodeSkillToken(enc)).toBeNull()
    }
  })
})

describe('skillTokenMatches — CAS semantics', () => {
  test('identical token matches', () => {
    expect(skillTokenMatches(T('sk1', 5, 2), T('sk1', 5, 2))).toBe(true)
  })

  test('same-name delete/recreate ABA: different skillId → no match (V1)', () => {
    // Old page holds a token for skillId sk_OLD, contentVersion 5. The skill was
    // deleted and a new skill with the same NAME (skillId sk_NEW) was created,
    // whose version counter restarts — so contentVersion could coincide. The
    // skillId component still rejects it.
    expect(skillTokenMatches(T('sk_OLD', 5, 2), T('sk_NEW', 5, 2))).toBe(false)
  })

  test('content advanced → no match (stale version fence, V2)', () => {
    expect(skillTokenMatches(T('sk1', 4, 2), T('sk1', 5, 2))).toBe(false)
  })

  test('metadata-only change → no match (metaRevision bump, V1 bypass)', () => {
    // Description edited (metaRevision 2→3) without touching content: a stale
    // ZIP-overwrite/save decision must still be rejected.
    expect(skillTokenMatches(T('sk1', 5, 2), T('sk1', 5, 3))).toBe(false)
  })
})
