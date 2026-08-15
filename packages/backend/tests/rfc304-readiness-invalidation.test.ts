// RFC-304 §3.1 T16c — readiness invalidation.
//
// The failure is silent in both directions, which is why it needs its own
// tests rather than being covered incidentally by the derivation tests:
//
//   forget to invalidate ⇒ deleting one shared binding leaves every cell that
//     used it still showing `ready`, and nobody finds out until an event
//     arrives and the round fails;
//   invalidate too little ⇒ a user who FIXED a prerequisite stays stuck on
//     `misconfigured` with no way to ask the platform to look again.
//
// The two cases most easily missed have their own tests: a framework change
// reaches cells through their BINDING (their own binding did not change), and
// the age limit exists to catch dependencies nobody wired an event for — one
// unwired dependency otherwise produces a cell that is permanently and
// confidently wrong.

import { describe, expect, test } from 'bun:test'
import {
  cellsInvalidatedBy,
  isReadinessFresh,
  requiresWakeSource,
  WAKE_SOURCE_REQUIRED_CAPABILITIES,
  type CellDependencySnapshot,
} from '../src/modules/code-capability/domain/readinessInvalidation'

const cell = (over: Partial<CellDependencySnapshot> = {}): CellDependencySnapshot => ({
  cellId: 'cell-1',
  repoId: 'repo-1',
  bindingId: 'binding-1',
  frameworkId: 'framework-1',
  agentIds: ['agent-1'],
  codeHostEndpointId: 'ep_7',
  ...over,
})

describe('RFC-304 T16c — what a change invalidates', () => {
  const cells = [
    cell({ cellId: 'a' }),
    cell({ cellId: 'b' }),
    cell({
      cellId: 'c',
      bindingId: 'binding-2',
      frameworkId: 'framework-2',
      agentIds: ['agent-2'],
    }),
    cell({ cellId: 'd', repoId: 'repo-2' }),
  ]

  test('a shared binding change invalidates every cell using it — and only those', () => {
    // The headline case: one deleted binding, hundreds of cells still claiming
    // `ready` until an event arrives.
    expect(cellsInvalidatedBy({ kind: 'binding', bindingId: 'binding-1' }, cells)).toEqual([
      'a',
      'b',
      'd',
    ])
  })

  test('a FRAMEWORK change reaches cells through their binding', () => {
    // Easy to miss: these cells' own bindings did not change, so a naive
    // implementation watching only binding ids would leave them stale.
    expect(cellsInvalidatedBy({ kind: 'framework', frameworkId: 'framework-2' }, cells)).toEqual([
      'c',
    ])
  })

  test('an agent change invalidates the cells whose slots reference it', () => {
    expect(cellsInvalidatedBy({ kind: 'agent', agentId: 'agent-2' }, cells)).toEqual(['c'])
  })

  test('repo-scoped changes hit every capability of that repo', () => {
    // A trigger or wake-source change is per repo, so all its cells re-derive —
    // `mr-review` and `ci-fix` on one repo share the same trigger surface.
    expect(cellsInvalidatedBy({ kind: 'trigger', repoId: 'repo-1' }, cells)).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(cellsInvalidatedBy({ kind: 'wake-source', repoId: 'repo-2' }, cells)).toEqual(['d'])
  })

  test('a code-host change invalidates cells on that endpoint', () => {
    expect(cellsInvalidatedBy({ kind: 'code-host', endpointId: 'ep_7' }, cells)).toHaveLength(4)
    expect(cellsInvalidatedBy({ kind: 'code-host', endpointId: 'ep_9' }, cells)).toEqual([])
  })

  test('an unrelated change invalidates nothing', () => {
    // Reverse assertion: an implementation that invalidated everything would
    // satisfy every test above while making the cache useless.
    expect(cellsInvalidatedBy({ kind: 'binding', bindingId: 'binding-99' }, cells)).toEqual([])
  })

  test('a cell with no binding is unaffected by binding changes', () => {
    const orphan = [cell({ cellId: 'x', bindingId: null, frameworkId: null })]
    expect(cellsInvalidatedBy({ kind: 'binding', bindingId: 'binding-1' }, orphan)).toEqual([])
    // …but a repo-scoped change still reaches it: it is still a cell of that
    // repo, and its readiness still says "no binding selected".
    expect(cellsInvalidatedBy({ kind: 'trigger', repoId: 'repo-1' }, orphan)).toEqual(['x'])
  })
})

describe('RFC-304 T16c — when a cached readiness may be trusted', () => {
  const base = {
    cachedRevision: 5,
    currentRevision: 5,
    lastValidatedAt: 1_000,
    now: 1_500,
    maxAgeMs: 10_000,
  }

  test('same revision and within the age limit ⇒ fresh', () => {
    expect(isReadinessFresh(base)).toBe(true)
  })

  test('a revision bump makes it stale immediately', () => {
    expect(isReadinessFresh({ ...base, currentRevision: 6 })).toBe(false)
  })

  test('the age limit catches dependencies nobody wired an event for', () => {
    // The second, independent reason to distrust the cache. Without it, ONE
    // unwired dependency produces a cell that is permanently and confidently
    // wrong — the worst possible state for a diagnostic surface.
    expect(isReadinessFresh({ ...base, now: 1_000 + 10_001 })).toBe(false)
  })

  test('never-validated is never fresh', () => {
    // A row created by a migration or a raw insert has no validation stamp; a
    // truthiness check on the timestamp would also mis-handle epoch 0.
    expect(isReadinessFresh({ ...base, lastValidatedAt: null })).toBe(false)
    expect(isReadinessFresh({ ...base, lastValidatedAt: 0, now: 1 })).toBe(true)
  })
})

describe('RFC-304 AC-14d — which capabilities need a wake source', () => {
  test('ci-fix does', () => {
    // Everything else can be configured and the cell would still be unstartable.
    expect(requiresWakeSource('ci-fix')).toBe(true)
  })

  test('mr-monitor does', () => {
    expect(requiresWakeSource('mr-monitor')).toBe(true)
  })

  test('mr-review does not — its trigger IS the MR event', () => {
    // Requiring it unconditionally would leave every review-only repo
    // permanently `misconfigured`.
    expect(requiresWakeSource('mr-review')).toBe(false)
  })

  test('the list is data, so the derivation and this rule cannot drift apart', () => {
    for (const capability of WAKE_SOURCE_REQUIRED_CAPABILITIES) {
      expect(requiresWakeSource(capability)).toBe(true)
    }
  })
})
