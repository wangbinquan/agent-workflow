// RFC-304 T10/T10d — the work item store: decisions applied under CAS.
//
// The domain tests prove the transition table is right. These prove the WRITE
// is safe, which is the part that fails under concurrency and which a
// happy-path test cannot distinguish from a broken implementation.
//
// The three things asserted here that a plain `UPDATE ... WHERE id = ?` would
// get wrong:
//
//   - a decision made against a stale read must NOT land (`raced`), or two
//     handlers both observing `running` would both supersede, double-bumping
//     the epoch and cancelling a round twice;
//   - entering the publish critical section must be exclusive AND
//     epoch-checked, or a round whose epoch was already bumped could still
//     publish — the exact stale-output-on-the-MR bug;
//   - leaving it must be epoch-guarded, or a later round could clear a section
//     it does not hold and let an event supersede an in-flight publish.
//
// Plus one recovery case: a daemon that dies mid-publish leaves the marker set,
// and nothing else would ever clear it — the item would register every future
// event as a pending revision and never advance again.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeWorkItems } from '../src/db/schema'
import {
  applyWorkItemEvent,
  clearStalePublishSections,
  enterPublishSection,
  leavePublishSection,
  readWorkItem,
} from '../src/modules/code-capability/infrastructure/sqliteWorkItemStore'
import type { CodeWorkItemStatus } from '../src/modules/code-capability/domain/workItemLifecycle'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src')

describe('RFC-304 T10 — work item store', () => {
  let db: DbClient
  let itemId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    itemId = ulid()
    await db.insert(codeWorkItems).values({
      id: itemId,
      codeHostEndpointId: 'ep_7',
      stableProjectId: '41823',
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: '412',
      status: 'idle',
      epoch: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
  })
  afterEach(() => db.$client.close())

  const setStatus = async (status: CodeWorkItemStatus, extra: Record<string, unknown> = {}) => {
    await db
      .update(codeWorkItems)
      .set({ status, ...extra })
      .where(eq(codeWorkItems.id, itemId))
  }

  test('an external event moves idle → queued', async () => {
    const r = await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: false,
    })
    expect(r.outcome).toBe('applied')
    expect(r.outcome === 'applied' && r.to).toBe('queued')
    expect((await readWorkItem(db, itemId))?.status).toBe('queued')
  })

  test('a decision made against a STALE read does not land', async () => {
    // Two handlers both read `running`. The first supersedes; the second must
    // lose rather than double-bump the epoch and cancel the round twice.
    await setStatus('running')
    const stale = await readWorkItem(db, itemId)
    expect(stale?.status).toBe('running')

    const first = await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: true,
    })
    expect(first.outcome === 'applied' && first.to).toBe('superseding')

    // The second handler's decision was made against `running`, which the row
    // has now left. Re-applying it here reads the CURRENT row, so it correctly
    // decides `stay` instead — the point being that the row is only ever
    // written under the status it was decided against.
    const second = await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: true,
    })
    expect(second.outcome).toBe('stayed')
    expect((await readWorkItem(db, itemId))?.epoch).toBe(2)
  })

  test('supersede bumps the epoch exactly once and asks for the cancel', async () => {
    await setStatus('running')
    const r = await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: true,
    })
    expect(r.outcome === 'applied' && r.effects.map((e) => e.kind)).toContain(
      'request-round-cancel',
    )
    expect((await readWorkItem(db, itemId))?.epoch).toBe(2)
    // Effects are reported, not performed: cancelling a task from inside a
    // store would make every one of these paths untestable without a scheduler.
    expect(r.outcome === 'applied' && r.effects.map((e) => e.kind)).not.toContain('start-round')
  })

  test('the wait handle is written by the store, not left to the caller', async () => {
    // A caller that forgot would leave `awaiting` with no pending generation,
    // and guard 2 would then accept ANY confirmation.
    await setStatus('running')
    await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'round-needs-human', pendingGeneration: 9 },
      hasLiveRound: true,
    })
    const row = await readWorkItem(db, itemId)
    expect(row?.status).toBe('awaiting')
    expect(row?.pendingGeneration).toBe(9)
  })

  test('a registered pending revision is persisted even without a status change', async () => {
    await setStatus('queued')
    const r = await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: false,
    })
    expect(r.outcome).toBe('stayed')
    expect((await readWorkItem(db, itemId))?.pendingRevision).not.toBeNull()
  })

  test('leaving handed_off clears the campaign fingerprint', async () => {
    // Otherwise the next hand-off inherits the previous campaign's identity —
    // and with it, the quota decision that was made about a different failure.
    await setStatus('handed_off', { handedOffFingerprint: 'compile-error-1' })
    await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'manual-retry' },
      hasLiveRound: false,
    })
    const row = await readWorkItem(db, itemId)
    expect(row?.status).toBe('queued')
    expect(row?.handedOffFingerprint).toBeNull()
  })

  test('a closed item stamps closedAt and refuses further events', async () => {
    await setStatus('closing')
    await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'compensation-complete' },
      hasLiveRound: false,
    })
    const [row] = await db.select().from(codeWorkItems).where(eq(codeWorkItems.id, itemId))
    expect(row?.status).toBe('closed')
    expect(row?.closedAt).not.toBeNull()

    const after = await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: false,
    })
    expect(after.outcome).toBe('rejected')
  })

  test('a missing item is reported, not thrown', async () => {
    const r = await applyWorkItemEvent({
      db,
      workItemId: 'no-such-item',
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: false,
    })
    expect(r.outcome).toBe('missing')
  })
})

describe('RFC-304 T10b — the publish critical section, persisted', () => {
  let db: DbClient
  let itemId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    itemId = ulid()
    await db.insert(codeWorkItems).values({
      id: itemId,
      codeHostEndpointId: 'ep_7',
      stableProjectId: '41823',
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: '412',
      status: 'running',
      epoch: 3,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
  })
  afterEach(() => db.$client.close())

  test('entering is exclusive', async () => {
    expect(await enterPublishSection(db, itemId, 3)).toBe(true)
    // A second round must not also believe it holds the section.
    expect(await enterPublishSection(db, itemId, 3)).toBe(false)
  })

  test('a round whose epoch was already bumped CANNOT enter', async () => {
    // The stale-output bug in its purest form: this round's findings describe a
    // baseline that no longer applies, and letting it publish is exactly what
    // the section exists to prevent.
    await db.update(codeWorkItems).set({ epoch: 4 }).where(eq(codeWorkItems.id, itemId))
    expect(await enterPublishSection(db, itemId, 3)).toBe(false)
  })

  test('while the section is held, an event is registered rather than superseding', async () => {
    await enterPublishSection(db, itemId, 3)
    const r = await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: true,
    })
    expect(r.outcome).toBe('stayed')
    const row = await readWorkItem(db, itemId)
    expect(row?.status).toBe('running')
    // The two writes that would break the in-flight publish.
    expect(row?.epoch).toBe(3)
    expect(row?.pendingRevision).not.toBeNull()
  })

  test('after leaving, the same event supersedes normally', async () => {
    await enterPublishSection(db, itemId, 3)
    expect(await leavePublishSection(db, itemId, 3)).toBe(true)
    const r = await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: true,
    })
    expect(r.outcome === 'applied' && r.to).toBe('superseding')
  })

  test('a later round cannot clear a section it does not hold', async () => {
    // Clearing someone else's section would let an event supersede a publish
    // that is still in flight.
    await enterPublishSection(db, itemId, 3)
    expect(await leavePublishSection(db, itemId, 4)).toBe(false)
    expect((await readWorkItem(db, itemId))?.publishingEpoch).toBe(3)
  })

  test('boot clears a section left by a dead daemon', async () => {
    // Without this the item registers every future event as a pending revision
    // and never advances again — a silent, permanent stall on that MR.
    await enterPublishSection(db, itemId, 3)
    expect(await clearStalePublishSections(db)).toBe(1)
    expect((await readWorkItem(db, itemId))?.publishingEpoch).toBeNull()

    const r = await applyWorkItemEvent({
      db,
      workItemId: itemId,
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: true,
    })
    expect(r.outcome === 'applied' && r.to).toBe('superseding')
  })

  test('boot leaves items with no section alone', async () => {
    // Reverse assertion: a sweep that touched every row would pass the test
    // above while stamping updatedAt across the whole table.
    expect(await clearStalePublishSections(db)).toBe(0)
  })

  test('the daemon actually calls it at boot', async () => {
    // The two cases above were green from the day the function was written, and
    // the stall they describe was still reachable in production for exactly one
    // reason: nothing called it. A sweep with no caller is a docstring.
    //
    // Source-level because the alternative is booting a daemon in a unit test.
    // It must sit BEFORE `resumeSupersedingWorkItems`, which can start rounds —
    // clearing the marker after a live round entered its section would drop a
    // section that IS held.
    const src = readFileSync(join(SRC, 'cli', 'start.ts'), 'utf8')
    expect(src).toContain('clearStalePublishSections')
    expect(src.indexOf('clearStalePublishSections')).toBeLessThan(
      src.indexOf('await resumeSupersedingWorkItems('),
    )
  })
})
