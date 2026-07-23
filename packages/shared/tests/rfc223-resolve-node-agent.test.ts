// RFC-223 T15 — workflow resource identity is id-only. A name-only node is
// corrupt/quarantined data and must never bind a current same-named tenant row.

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
    // The node froze id ID_X but its display name has drifted — id still wins.
    const lookup = buildNodeAgentLookup([{ id: 'ID_X', name: 'renamed', tag: 'X' }], (a) => a)
    const found = resolveNodeAgent(node({ agentId: 'ID_X', agentName: 'writer' }), lookup)
    expect(found?.tag).toBe('X')
  })

  test('name-only node fails closed', () => {
    const lookup = buildNodeAgentLookup(agents, (a) => a)
    expect(resolveNodeAgent(node({ agentName: 'auditor' }), lookup)).toBeUndefined()
  })

  test('fail-closed: id present but not found → undefined, NOT a name fallback (H3)', () => {
    // A name-keyed lookup handed a stamped node must not resolve by name.
    const nameKeyed = new Map(agents.map((a) => [a.name, a]))
    expect(
      resolveNodeAgent(node({ agentId: 'ID_X', agentName: 'writer' }), nameKeyed),
    ).toBeUndefined()
  })

  test('id-keyed lookup: a stamped node resolves by its id key (the correct wiring)', () => {
    // The fix for the case above: callers build an id lookup.
    const lookup = buildNodeAgentLookup([{ id: 'ID_X', name: 'renamed', tag: 'X' }], (a) => a)
    expect(resolveNodeAgent(node({ agentId: 'ID_X', agentName: 'writer' }), lookup)?.tag).toBe('X')
  })

  test('missing id → undefined regardless of display name', () => {
    const lookup = buildNodeAgentLookup(agents, (a) => a)
    expect(resolveNodeAgent(node({}), lookup)).toBeUndefined()
  })

  test('buildNodeAgentLookup keys only by id', () => {
    const lookup = buildNodeAgentLookup(agents, (a) => a.tag)
    expect(lookup.get('ID_X')).toBe('X')
    expect(lookup.get('writer')).toBeUndefined()
  })
})
