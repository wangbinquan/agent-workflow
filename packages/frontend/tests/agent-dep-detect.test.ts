// RFC-038 T1 — locks the pure detectAgentDeps contract: contains scan, four
// inventory groups, self/existing/empty/dedup filters, case sensitivity.

import { describe, expect, test } from 'vitest'
import { detectAgentDeps, totalCandidates, type DetectExisting } from '../src/lib/agent-dep-detect'

const emptyExisting: DetectExisting = {
  dependsOn: [],
  skills: [],
  mcp: [],
  plugins: [],
}

describe('detectAgentDeps', () => {
  test('empty body → all groups empty', () => {
    const r = detectAgentDeps(
      '',
      {
        agents: [{ id: 'agent-foo', name: 'foo' }],
        skills: [{ id: 'skill-bar', name: 'bar' }],
      },
      emptyExisting,
    )
    expect(totalCandidates(r)).toBe(0)
  })

  test('agent name in body → agents group hits, others stay empty', () => {
    const r = detectAgentDeps(
      'call git-diff-snapshot first',
      {
        agents: [{ id: 'agent-git-diff', name: 'git-diff-snapshot' }],
        skills: [{ id: 'skill-unused', name: 'unused-skill' }],
      },
      emptyExisting,
      'agent-self',
    )
    expect(r.agents.candidates.map((c) => c.id)).toEqual(['agent-git-diff'])
    expect(r.skills.candidates).toEqual([])
  })

  test('hit already in existing.dependsOn → excluded', () => {
    const r = detectAgentDeps(
      'call git-diff-snapshot',
      { agents: [{ id: 'agent-git-diff', name: 'git-diff-snapshot' }] },
      { ...emptyExisting, dependsOn: ['agent-git-diff'] },
    )
    expect(r.agents.candidates).toEqual([])
  })

  test('self id excluded from agents group without hiding a same-name peer', () => {
    const r = detectAgentDeps(
      'self-agent does the work',
      {
        agents: [
          { id: 'agent-self', name: 'self-agent' },
          { id: 'agent-peer', name: 'self-agent' },
          { id: 'agent-other', name: 'other' },
        ],
      },
      emptyExisting,
      'agent-self',
    )
    expect(r.agents.candidates.map((c) => c.id)).toEqual(['agent-peer'])
  })

  test('multi-group hits: skills + mcps + plugins', () => {
    const r = detectAgentDeps(
      'use playwright-runner skill, code-review-mcp tool, schema-validator plugin',
      {
        agents: [],
        skills: [{ id: 'skill-playwright', name: 'playwright-runner' }],
        mcps: [{ id: 'mcp-code-review', name: 'code-review-mcp' }],
        plugins: [{ id: 'plugin-schema', name: 'schema-validator' }],
      },
      emptyExisting,
    )
    expect(r.skills.candidates.map((c) => c.id)).toEqual(['skill-playwright'])
    expect(r.mcps.candidates.map((c) => c.id)).toEqual(['mcp-code-review'])
    expect(r.plugins.candidates.map((c) => c.id)).toEqual(['plugin-schema'])
  })

  test('preserves inventory ordering for candidates', () => {
    const r = detectAgentDeps(
      'mentions c, then b, then a — but order should follow inventory',
      {
        agents: [
          { id: 'agent-a', name: 'a' },
          { id: 'agent-b', name: 'b' },
          { id: 'agent-c', name: 'c' },
        ],
      },
      emptyExisting,
    )
    expect(r.agents.candidates.map((c) => c.id)).toEqual(['agent-a', 'agent-b', 'agent-c'])
  })

  test('inventory dupes → kept once, first occurrence', () => {
    const r = detectAgentDeps(
      'foo here',
      {
        agents: [
          { id: 'agent-foo', name: 'foo', description: 'first' },
          { id: 'agent-foo', name: 'foo', description: 'second' },
        ],
      },
      emptyExisting,
    )
    expect(r.agents.candidates).toHaveLength(1)
    expect(r.agents.candidates[0]?.description).toBe('first')
  })

  test('same display name with distinct ids keeps both owner-scoped candidates', () => {
    const r = detectAgentDeps(
      'foo here',
      {
        agents: [
          { id: 'agent-owner-a', name: 'foo', ownerUserId: 'owner-a' },
          { id: 'agent-owner-b', name: 'foo', ownerUserId: 'owner-b' },
        ],
      },
      emptyExisting,
    )
    expect(r.agents.candidates.map((c) => c.id)).toEqual(['agent-owner-a', 'agent-owner-b'])
  })

  test('empty inventory name string → not matched (no includes("") degenerate hit)', () => {
    const r = detectAgentDeps(
      'any body',
      {
        agents: [
          { id: 'agent-empty', name: '' },
          { id: 'agent-real', name: 'real' },
        ],
      },
      emptyExisting,
    )
    expect(r.agents.candidates.map((c) => c.name)).toEqual([])
  })

  test('inventory.skills undefined (query failed) → skills group empty, others work', () => {
    const r = detectAgentDeps(
      'hit-agent here',
      { agents: [{ id: 'agent-hit', name: 'hit-agent' }], skills: undefined },
      emptyExisting,
    )
    expect(r.agents.candidates.map((c) => c.id)).toEqual(['agent-hit'])
    expect(r.skills.candidates).toEqual([])
  })

  test('case sensitive: body "Foo" vs inventory "foo" → no match', () => {
    const r = detectAgentDeps(
      'Foo appears here',
      { agents: [{ id: 'agent-foo', name: 'foo' }] },
      emptyExisting,
    )
    expect(r.agents.candidates).toEqual([])
  })

  test('substring containment still matches: body "digit-validator-extra" hits "digit-validator"', () => {
    const r = detectAgentDeps(
      'see digit-validator-extra docs',
      { plugins: [{ id: 'plugin-digit', name: 'digit-validator' }] },
      emptyExisting,
    )
    expect(r.plugins.candidates.map((c) => c.id)).toEqual(['plugin-digit'])
  })

  test('missing self id + inventory empty-name → no degenerate matches', () => {
    const r = detectAgentDeps(
      'any',
      {
        agents: [
          { id: 'agent-empty', name: '' },
          { id: 'agent-x', name: 'x' },
        ],
      },
      emptyExisting,
    )
    expect(r.agents.candidates.map((c) => c.name)).toEqual([])
  })
})
