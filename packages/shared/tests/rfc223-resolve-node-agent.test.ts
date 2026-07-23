// RFC-223 (PR-3a) — the shared node→agent resolver used by port derivation /
// validator / fanout resolves id-first (rename/ABA-safe), name only as a
// fallback so legacy name-keyed lookups (the canvas' Map(agents.map([name,a])))
// never break under global uniqueness.

import { describe, expect, test } from 'bun:test'
import { buildNodeAgentLookup, resolveNodeAgent } from '../src/wrapperFanout'
import type { WorkflowNode } from '../src/schemas/workflow'

const agents = [
  { id: 'ID_X', name: 'writer', tag: 'X' },
  { id: 'ID_Y', name: 'auditor', tag: 'Y' },
]
const node = (fields: Record<string, unknown>) =>
  ({ id: 'n1', kind: 'agent-single', ...fields }) as unknown as WorkflowNode

describe('resolveNodeAgent (RFC-223)', () => {
  test('id-keyed lookup: resolves by agentId even when the name has drifted', () => {
    // Lookup keyed by BOTH id and name. The node froze id ID_X but its name in
    // the lookup is now "renamed" — id must still win.
    const lookup = buildNodeAgentLookup([{ id: 'ID_X', name: 'renamed', tag: 'X' }], (a) => a)
    const found = resolveNodeAgent(node({ agentId: 'ID_X', agentName: 'writer' }), lookup)
    expect(found?.tag).toBe('X')
  })

  test('name fallback: a node with agentId absent resolves by name', () => {
    const lookup = buildNodeAgentLookup(agents, (a) => a)
    expect(resolveNodeAgent(node({ agentName: 'auditor' }), lookup)?.tag).toBe('Y')
  })

  test('name fallback: id present but not in a name-only lookup → falls back to name', () => {
    // The canvas passes a NAME-keyed Map; a node that already stamps agentId must
    // still resolve (id misses, name hits) — no broken ports under 1:1.
    const nameKeyed = new Map(agents.map((a) => [a.name, a]))
    expect(resolveNodeAgent(node({ agentId: 'ID_X', agentName: 'writer' }), nameKeyed)?.tag).toBe(
      'X',
    )
  })

  test('neither id nor name → undefined', () => {
    const lookup = buildNodeAgentLookup(agents, (a) => a)
    expect(resolveNodeAgent(node({}), lookup)).toBeUndefined()
  })

  test('buildNodeAgentLookup keys by both id and name', () => {
    const lookup = buildNodeAgentLookup(agents, (a) => a.tag)
    expect(lookup.get('ID_X')).toBe('X')
    expect(lookup.get('writer')).toBe('X')
  })
})
