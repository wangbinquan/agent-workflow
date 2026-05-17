// RFC-026 — ClarifyNode.sessionMode + resolveClarifySessionMode default.
//
// Locks in the additive `sessionMode` field on ClarifyNode and the central
// default-fallback helper. If any of these go red, RFC-026's "default isolated
// preserves RFC-023 byte-for-byte" promise (proposal §2.1 + A1) is in jeopardy
// — investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import {
  ClarifyNodeSchema,
  ClarifySessionModeSchema,
  resolveClarifySessionMode,
} from '@agent-workflow/shared'

describe('RFC-026 ClarifyNode.sessionMode + helper', () => {
  test('missing sessionMode parses fine and resolveClarifySessionMode returns "isolated"', () => {
    // Older v3 workflow JSON authored before RFC-026 omits the field entirely.
    const parsed = ClarifyNodeSchema.parse({
      id: 'c1',
      kind: 'clarify',
      title: 'Clarify',
      description: '',
    })
    expect(parsed.sessionMode).toBeUndefined()
    expect(resolveClarifySessionMode(parsed)).toBe('isolated')
  })

  test('explicit "isolated" round-trips and stays "isolated"', () => {
    const parsed = ClarifyNodeSchema.parse({
      id: 'c1',
      kind: 'clarify',
      title: '',
      description: '',
      sessionMode: 'isolated',
    })
    expect(parsed.sessionMode).toBe('isolated')
    expect(resolveClarifySessionMode(parsed)).toBe('isolated')
  })

  test('explicit "inline" round-trips and helper returns "inline"', () => {
    const parsed = ClarifyNodeSchema.parse({
      id: 'c1',
      kind: 'clarify',
      title: '',
      description: '',
      sessionMode: 'inline',
    })
    expect(parsed.sessionMode).toBe('inline')
    expect(resolveClarifySessionMode(parsed)).toBe('inline')
  })

  test('unknown sessionMode strings are rejected by zod', () => {
    expect(() =>
      ClarifyNodeSchema.parse({
        id: 'c1',
        kind: 'clarify',
        title: '',
        description: '',
        sessionMode: 'streaming', // not a member of the enum
      }),
    ).toThrow()
    // Standalone schema mirror: enum stays the 2-member contract; expanding
    // it (e.g. to add a third mode) must update the regression target.
    expect(ClarifySessionModeSchema.options).toEqual(['isolated', 'inline'])
  })
})
