// RFC-223 (PR-3a, impl-gate H3) — the shared node→agent resolver used by port
// derivation / validator / fanout resolves id-first and FAIL-CLOSED: an agentId
// that misses the lookup returns undefined, it does NOT fall back to the mutable
// name. The name fallback applies ONLY to a node with no id at all. Callers must
// key the lookup by id (buildNodeAgentLookup keys by BOTH id and name) so a
// stamped node still resolves. The prior lenient "id present but not found →
// name fallback" was the H3 fail-open (an ABA rename+recreate could bind a
// different tenant's agent); this file locks the corrected behavior.

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

  test('fail-closed: id present but not found → undefined, NOT a name fallback (H3)', () => {
    // A NAME-keyed lookup (no id keys) handed a STAMPED node must NOT resolve by
    // name — that lenient fallback was the H3 fail-open (an ABA rename+recreate
    // could bind a different tenant's agent). Callers must key by id
    // (buildNodeAgentLookup) instead; here the id misses → undefined.
    const nameKeyed = new Map(agents.map((a) => [a.name, a]))
    expect(
      resolveNodeAgent(node({ agentId: 'ID_X', agentName: 'writer' }), nameKeyed),
    ).toBeUndefined()
  })

  test('id-keyed lookup: a stamped node resolves by its id key (the correct wiring)', () => {
    // The fix for the case above: callers build an id+name lookup so the stamped
    // node resolves by id (and the name has even drifted).
    const lookup = buildNodeAgentLookup([{ id: 'ID_X', name: 'renamed', tag: 'X' }], (a) => a)
    expect(resolveNodeAgent(node({ agentId: 'ID_X', agentName: 'writer' }), lookup)?.tag).toBe('X')
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
