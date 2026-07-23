// RFC-038 T1 — locks mergeAgentDeps semantics: append + dedupe per array,
// untouched fields preserved, no-op returns same reference.

import { describe, expect, test } from 'vitest'
import { mergeAgentDeps } from '../src/lib/agent-dep-detect'
import { emptyAgent } from '../src/components/AgentForm'

const EMPTY_SELECTION = {
  agents: [],
  skills: [],
  mcps: [],
  plugins: [],
}

describe('mergeAgentDeps', () => {
  test('empty selection → same reference returned', () => {
    const value = emptyAgent()
    const next = mergeAgentDeps(value, EMPTY_SELECTION)
    expect(next).toBe(value)
  })

  test('appends new agent name to empty dependsOn', () => {
    const value = emptyAgent()
    const next = mergeAgentDeps(value, { ...EMPTY_SELECTION, agents: ['a'] })
    expect(next.dependsOn).toEqual(['a'])
    expect(next).not.toBe(value)
  })

  test('dedupes against existing dependsOn, preserves order', () => {
    const value = { ...emptyAgent(), dependsOn: ['a', 'b'] }
    const next = mergeAgentDeps(value, { ...EMPTY_SELECTION, agents: ['a', 'c'] })
    expect(next.dependsOn).toEqual(['a', 'b', 'c'])
  })

  test('merges all four arrays, leaves unrelated fields intact', () => {
    const value = {
      ...emptyAgent(),
      bodyMd: 'preserve me',
      permission: { edit: 'allow' as const },
      dependsOn: ['existing-a'],
      // RFC-223 (PR-1): skills are typed refs; detected names merge as MANAGED
      // refs (skillId = name, resolved server-side).
      skills: [{ kind: 'managed' as const, skillId: 'existing-s' }],
      mcp: ['existing-m'],
      plugins: ['existing-p'],
    }
    const next = mergeAgentDeps(value, {
      agents: ['existing-a', 'new-a'], // first dupe, second new
      skills: ['new-s'],
      mcps: ['new-m'],
      plugins: ['new-p'],
    })
    expect(next.dependsOn).toEqual(['existing-a', 'new-a'])
    expect(next.skills).toEqual([
      { kind: 'managed', skillId: 'existing-s' },
      { kind: 'managed', skillId: 'new-s' },
    ])
    expect(next.mcp).toEqual(['existing-m', 'new-m'])
    expect(next.plugins).toEqual(['existing-p', 'new-p'])
    expect(next.bodyMd).toBe('preserve me')
    expect(next.permission).toBe(value.permission) // reference preserved
  })

  test('selection that is fully duplicate → same reference returned', () => {
    const value = {
      ...emptyAgent(),
      dependsOn: ['a'],
      skills: [{ kind: 'managed' as const, skillId: 's' }],
    }
    const next = mergeAgentDeps(value, {
      ...EMPTY_SELECTION,
      agents: ['a'],
      skills: ['s'],
    })
    expect(next).toBe(value)
  })
})
