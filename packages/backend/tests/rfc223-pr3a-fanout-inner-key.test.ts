// RFC-223 (PR-3a impl-gate H2) — wrapper-fanout inner agent identity is keyed by
// the CANONICAL agentId, not the mutable display name.
//
// The bug: the inner-agent-map hydration deduped by `agentsMap.has(agentName)`
// and the per-shard dispatch read `agentsMap.get(agentName)`. Two inner nodes
// that froze the SAME stale display name but resolve to DIFFERENT agent ids (an
// ABA rename+recreate, or post-PR-8 same-name cross-tenant) collapsed into one —
// the second node was skipped at hydration and both dispatched under the FIRST
// node's agent. `fanoutInnerAgentKey` is the single key oracle both sites now
// share, so they can never drift back into the name-keyed collapse.
//
// If this reds, same-name different-id fanout inner nodes fold onto one agent.

import { describe, expect, test } from 'bun:test'
import { fanoutInnerAgentKey } from '../src/services/scheduler'

describe('fanoutInnerAgentKey — id-canonical fanout inner identity (H2)', () => {
  test('stamped node → its agentId (not the name)', () => {
    expect(fanoutInnerAgentKey({ agentId: 'ID_A', agentName: 'shared' })).toBe('ID_A')
  })

  test('name-only node fails closed', () => {
    expect(fanoutInnerAgentKey({ agentName: 'legacy' })).toBeNull()
  })

  test('neither → null', () => {
    expect(fanoutInnerAgentKey({})).toBeNull()
    expect(fanoutInnerAgentKey({ agentId: '', agentName: '' })).toBeNull()
  })

  test('empty agentId does not fall through to the name', () => {
    expect(fanoutInnerAgentKey({ agentId: '', agentName: 'n' })).toBeNull()
  })

  test('H2 no-collapse: two same-NAME different-ID inner nodes get DISTINCT keys', () => {
    // Both froze the stale name "shared"; they resolve to different agents. The
    // name-keyed dedup collapsed them — the id-keyed key keeps them apart.
    const n1 = { agentId: 'ID_A', agentName: 'shared' }
    const n2 = { agentId: 'ID_B', agentName: 'shared' }
    const k1 = fanoutInnerAgentKey(n1)
    const k2 = fanoutInnerAgentKey(n2)
    expect(k1).not.toBe(k2)

    // Simulate the hydration dedup Set: both survive (2 distinct entries), where
    // the old name key would have yielded a single "shared" entry.
    const seen = new Set<string>()
    for (const n of [n1, n2]) {
      const key = fanoutInnerAgentKey(n)
      if (key !== null) seen.add(key)
    }
    expect(seen.size).toBe(2)
  })
})
