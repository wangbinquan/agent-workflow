// RFC-304 §2.2 — the work-item state machine, driven by real round outcomes.
//
// The transition table and its CAS writer were built in PR-1a and had ONLY test
// callers. Design D2 chose that machine deliberately — a second lifecycle
// beside the task's, because an item spans many rounds and `awaiting` must
// outlive a task rather than suspend one for three days — and §2.1–2.2 calls it
// 整个系统的骨架. Nothing hung on the skeleton.
//
// What production did instead: `ensureWorkItem` wrote `idle`, `closeWorkItem`
// wrote `closed`, and the row never moved in between. Consequences a person
// could see: `/code` showed every item `idle` while its rounds ran, and
// `awaiting` — the state the entire human-confirmation design turns on — was
// never reached, so nothing could distinguish "this MR is waiting for you" from
// "nothing is happening".
//
// These tests pin the CHAIN rather than the table (the table has its own unit
// tests): a delivery queues the item, the take runs it, and each round outcome
// lands it where the design says. A missing emission point shows up here as a
// state that never advances.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeWorkItems } from '../src/db/schema'
import { noteWorkItemEvent } from '../src/modules/code-capability/application/workItemProgress'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-304 — a work item advances through its designed states', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(codeWorkItems).values({
      id: 'item-1',
      codeHostEndpointId: 'ep-1',
      stableProjectId: 'proj-1',
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: '412',
      status: 'idle',
      epoch: 1,
      createdAt: 1,
      updatedAt: 1,
    })
  })
  afterEach(() => {
    db.$client.close()
  })

  const statusOf = async (): Promise<string> => {
    const [row] = await db.select().from(codeWorkItems).where(eq(codeWorkItems.id, 'item-1'))
    return row?.status ?? 'missing'
  }

  const note = async (
    event: Parameters<typeof noteWorkItemEvent>[0]['event'],
    hasLiveRound = false,
  ) => await noteWorkItemEvent({ db, workItemId: 'item-1', event, hasLiveRound })

  /** Delivery → queued → running, the prefix every round shares. */
  const startRound = async (): Promise<void> => {
    await note({ kind: 'external-signal', signal: { kind: 'note' } })
    await note({ kind: 'scheduler-take' }, true)
  }

  test('a delivery queues the item, and the take runs it', async () => {
    // Before this chain existed the row sat at `idle` for the whole life of a
    // round, so the state view could not tell a busy merge request from a
    // silent one.
    expect(await statusOf()).toBe('idle')

    await note({ kind: 'external-signal', signal: { kind: 'note' } })
    expect(await statusOf()).toBe('queued')

    await note({ kind: 'scheduler-take' }, true)
    expect(await statusOf()).toBe('running')
  })

  test('a published round SETTLES the item', async () => {
    await startRound()
    await note({ kind: 'round-published' })
    expect(await statusOf()).toBe('settled')
  })

  test('a round that needs a human leaves the item AWAITING', async () => {
    // The state the human-confirmation design turns on, and the one production
    // could never reach. `/aw apply` is answered from here.
    await startRound()
    await note({ kind: 'round-needs-human', pendingGeneration: 3 })

    expect(await statusOf()).toBe('awaiting')
    const [row] = await db.select().from(codeWorkItems).where(eq(codeWorkItems.id, 'item-1'))
    // The generation travels with the state: guard 2 refuses a confirmation
    // from an older one, so an unrecorded generation would either reject every
    // confirmation or accept a stale one.
    expect(row?.pendingGeneration).toBe(3)
  })

  test('a failed round marks the item FAILED without touching the merge request', async () => {
    // Platform-side only (design §2.2). A failure the author did not cause
    // should not appear on their merge request as if they had.
    await startRound()
    await note({ kind: 'round-failed' })
    expect(await statusOf()).toBe('failed')
  })

  test('a settled item can be woken again — the item outlives its round', async () => {
    // The reason this is a separate lifecycle at all: one work item spans many
    // rounds across days, and a settled one must accept the next push.
    await startRound()
    await note({ kind: 'round-published' })

    await note({ kind: 'external-signal', signal: { kind: 'note' } })
    expect(await statusOf()).toBe('queued')
  })

  test('an out-of-order event is REJECTED, never thrown, and never wedges the item', async () => {
    // The safety property that lets this be wired at all. Bookkeeping must not
    // fail a round that already published its review, so a rejected transition
    // is recorded and swallowed — and the next delivery still re-queues the
    // item, so the machine self-heals rather than sticking.
    const outcome = await note({ kind: 'round-published' })
    expect(outcome.outcome).toBe('rejected')
    expect(await statusOf()).toBe('idle')

    await note({ kind: 'external-signal', signal: { kind: 'note' } })
    expect(await statusOf()).toBe('queued')
  })

  test('a round with no work item is a no-op, not an error', async () => {
    // The ordinary case for a direct round on an anchor nobody registered.
    const outcome = await noteWorkItemEvent({
      db,
      workItemId: null,
      hasLiveRound: false,
      event: { kind: 'round-published' },
    })
    expect(outcome.outcome).toBe('missing')
  })

  test('a merged merge request CLOSES the item from wherever it was', async () => {
    // Closure outranks everything: a merged MR must stop costing rounds, and
    // the rule is written once rather than repeated in eight status arms.
    await startRound()
    await note({ kind: 'external-signal', signal: { kind: 'closure', cause: 'merged' } }, true)
    expect(await statusOf()).toBe('closing')
  })
})
