// RFC-304 §3.1 — the repo × capability matrix.
//
// This is the switch that decides whether a webhook delivery starts anything at
// all, so its failure modes are the two opposite kinds of silence:
//
//   off when it should be on   — the bot "never responds", and the only place
//                                that shows is a row nobody thinks to look at;
//   on when it cannot work     — a round starts, fails at some later stage, and
//                                does so on the MR in front of the author, when
//                                the honest answer was available beforehand.
//
// The second is why `wantsCapability` demands `ready` and not merely `enabled`:
// `enabled` is a person's intent, `ready` is whether acting on it can work.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  disableCapabilityCell,
  listCapabilityCells,
  readCapabilityCell,
  upsertCapabilityCell,
  wantsCapability,
} from '../src/modules/code-capability/infrastructure/sqliteCapabilityMatrix'
import { repoCapabilityConfig } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

/** Everything present and visible — the only combination that yields `ready`. */
const goodFacts = {
  hasBinding: true,
  frameworkExists: true,
  hasTrigger: true,
  codeHostConfigured: true,
  invisibleAgentSlots: [] as string[],
  requiresWakeSource: false,
  hasWakeSource: false,
}

const enable = (db: DbClient, over: Record<string, unknown> = {}) =>
  upsertCapabilityCell(db, {
    repoId: 'repo-1',
    capability: 'mr-review',
    bindingId: 'binding-1',
    enabled: true,
    facts: goodFacts,
    dependencyRevision: 7,
    now: NOW,
    ...over,
  })

describe('RFC-304 — turning a capability on', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a fully configured cell comes out ready', async () => {
    const cell = await enable(db)
    expect(cell).toMatchObject({
      repoId: 'repo-1',
      capability: 'mr-review',
      bindingId: 'binding-1',
      enabled: true,
      readiness: 'ready',
    })
    expect(cell.readinessIssues).toEqual([])
  })

  test('a missing piece yields misconfigured WITH the specific reason', async () => {
    // "Configured, silent, and no way to tell why" is the failure this state
    // exists to prevent, so a bare `misconfigured` would be half a feature.
    const cell = await enable(db, { facts: { ...goodFacts, codeHostConfigured: false } })
    expect(cell.readiness).toBe('misconfigured')
    expect(cell.readinessIssues.map((i) => i.code)).toEqual(['code-host-unconfigured'])
    expect(cell.readinessIssues[0]?.detail).toContain('cannot be published')
  })

  test('several missing pieces are all reported, not just the first', async () => {
    // Fixing one thing per round-trip is how a first-time setup takes an
    // afternoon — the same rule `resolve-target` follows for trigger fields.
    const cell = await enable(db, {
      facts: {
        ...goodFacts,
        hasTrigger: false,
        codeHostConfigured: false,
        invisibleAgentSlots: ['reviewer'],
      },
    })
    expect(cell.readinessIssues.map((i) => i.code).sort()).toEqual([
      'agent-not-visible',
      'code-host-unconfigured',
      'no-trigger',
    ])
  })

  test('readiness is DERIVED, never accepted from the caller', async () => {
    // The input type takes facts only. A caller that could assert `ready`
    // directly would eventually assert it from somewhere that had not checked,
    // and the matrix would show green for a cell that cannot run.
    const cell = await enable(db, { facts: { ...goodFacts, hasBinding: false } })
    expect(cell.readiness).toBe('misconfigured')
  })

  test('the revision the facts were read at is recorded', async () => {
    // Without it a cached `ready` is trusted forever, including after the
    // binding it depended on was deleted.
    expect((await enable(db, { dependencyRevision: 42 })).dependencyRevision).toBe(42)
  })
})

describe('RFC-304 — one cell per (repo, capability)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('toggling twice updates one row rather than accumulating rows', async () => {
    // Two rows for one cell would eventually disagree about whether the
    // capability is on, and which one wins would depend on query order.
    await enable(db)
    await enable(db, { bindingId: 'binding-2' })
    const rows = await db.select().from(repoCapabilityConfig)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.bindingId).toBe('binding-2')
  })

  test('two capabilities on one repo are separate cells', async () => {
    await enable(db)
    await enable(db, { capability: 'mr-monitor' })
    const cells = await listCapabilityCells(db, 'repo-1')
    expect(cells.map((c) => c.capability).sort()).toEqual(['mr-monitor', 'mr-review'])
  })

  test('the same capability on two repos are separate cells', async () => {
    await enable(db)
    await enable(db, { repoId: 'repo-2' })
    expect(await listCapabilityCells(db, 'repo-1')).toHaveLength(1)
    expect(await listCapabilityCells(db, 'repo-2')).toHaveLength(1)
  })

  test('an unconfigured cell reads as null, not as a default-on row', async () => {
    expect(await readCapabilityCell(db, 'repo-nope', 'mr-review')).toBeNull()
  })
})

describe('RFC-304 — turning a capability off', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('disabling keeps the binding and trigger config', async () => {
    // Toggling off and on is routine while diagnosing; making it destructive
    // turns a two-second toggle into redoing the setup.
    await enable(db, { triggerConfig: { events: ['mr_opened'] } })
    const cell = await disableCapabilityCell(db, 'repo-1', 'mr-review', NOW + 1)
    expect(cell).toMatchObject({ enabled: false, readiness: 'disabled', bindingId: 'binding-1' })
    expect(cell?.triggerConfig).toEqual({ events: ['mr_opened'] })
  })

  test('disabling clears the issue list', async () => {
    // Issues describe why an ENABLED cell cannot run. Keeping them on a
    // disabled row shows a list of problems about something nobody asked for.
    await enable(db, { facts: { ...goodFacts, hasTrigger: false } })
    const cell = await disableCapabilityCell(db, 'repo-1', 'mr-review', NOW + 1)
    expect(cell?.readinessIssues).toEqual([])
  })

  test('disabling a cell that does not exist is a no-op, not an error', async () => {
    expect(await disableCapabilityCell(db, 'repo-nope', 'mr-review', NOW)).toBeNull()
  })
})

describe('RFC-304 — what the webhook path asks', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a ready cell wants the capability', async () => {
    await enable(db)
    expect(await wantsCapability(db, 'repo-1', 'mr-review')).toBe(true)
  })

  test('an enabled but MISCONFIGURED cell does not', async () => {
    // The load-bearing one. Starting here produces a round that fails at a
    // later stage, on the MR, in front of the author — when the honest answer
    // was available before anything started.
    await enable(db, { facts: { ...goodFacts, codeHostConfigured: false } })
    expect(await wantsCapability(db, 'repo-1', 'mr-review')).toBe(false)
  })

  test('a disabled cell does not', async () => {
    await enable(db)
    await disableCapabilityCell(db, 'repo-1', 'mr-review', NOW + 1)
    expect(await wantsCapability(db, 'repo-1', 'mr-review')).toBe(false)
  })

  test('an unconfigured repo does not — silence by default', async () => {
    // A platform that commented on repos nobody switched on would be worse than
    // one that never commented at all.
    expect(await wantsCapability(db, 'repo-never-configured', 'mr-review')).toBe(false)
  })

  test('enabling one capability does not enable its neighbour', async () => {
    await enable(db)
    expect(await wantsCapability(db, 'repo-1', 'mr-monitor')).toBe(false)
  })
})

describe('RFC-304 — a malformed row stays readable', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('unparsable JSON columns fall back instead of throwing', async () => {
    // One hand-edited or older-shape row must not break the whole matrix view.
    await enable(db)
    await db
      .update(repoCapabilityConfig)
      .set({ triggerConfigJson: '{not json', readinessIssuesJson: 'also not json' })
    const cell = await readCapabilityCell(db, 'repo-1', 'mr-review')
    expect(cell?.triggerConfig).toEqual({})
    expect(cell?.readinessIssues).toEqual([])
  })
})
