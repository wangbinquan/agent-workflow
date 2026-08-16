// RFC-304 §2.2 不变量一 — the preemption performers, and what they refuse.
//
// The transition table produced `request-round-cancel` and `start-round` from
// the beginning and NOTHING performed either. `superseding` was a state the
// machine could enter and never leave: no caller cancelled a round, nothing
// emitted `round-task-terminal`, and `start-round` appeared in no code path
// outside the table that produced it. Production simply opened a round for
// every delivery instead, so three pushes gave one merge request three
// concurrent rounds — each reviewing a revision the next had already replaced.
//
// The e2e drives the whole chain. What is pinned HERE is the part that is about
// refusing rather than doing, because those are the branches an end-to-end run
// only exercises by accident:
//
//   * advancing while the preempted round is still alive (the replacement would
//     run beside it, writing the same worktree);
//   * advancing an item that is not being preempted at all;
//   * advancing with nothing recorded to launch — which is what a revision
//     registered before the payload existed looks like.
//
// The publish critical section is pinned in the same spirit: `enterPublishSection`
// has a CAS that refuses a round whose epoch has moved, and had no caller, so a
// round preempted mid-flight published its review anyway.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeWorkItems, codeWorkRounds, tasks } from '../src/db/schema'
import {
  enterPublishSection,
  leavePublishSection,
  applyWorkItemEvent,
} from '../src/modules/code-capability/infrastructure/sqliteWorkItemStore'
import { advanceSupersedingWorkItem } from '../src/services/codeCapabilitySupersede'
import { eq } from 'drizzle-orm'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-304 — preemption performers', () => {
  let db: DbClient

  const seedItem = async (over: Partial<typeof codeWorkItems.$inferInsert> = {}) => {
    await db.insert(codeWorkItems).values({
      id: 'item-1',
      codeHostEndpointId: 'ep-1',
      stableProjectId: 'proj-1',
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: '412',
      status: 'superseding',
      epoch: 2,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    })
  }

  /** A round with a task in the given status. */
  const seedRound = async (opts: { taskStatus: string; ended?: boolean }) => {
    await db.insert(tasks).values({
      id: 'task-1',
      workflowId: 'wf-1',
      workflowVersion: 1,
      name: 'round',
      status: opts.taskStatus,
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      branch: 'agent-workflow/task-1',
      worktreePath: '/tmp/wt',
      workflowSnapshot: '{}',
      inputs: '{}',
      codeRoundId: 'round-1',
      startedAt: 1,
    } as typeof tasks.$inferInsert)
    await db.insert(codeWorkRounds).values({
      id: 'round-1',
      workItemId: 'item-1',
      roundSeq: 1,
      epoch: 1,
      taskId: 'task-1',
      startedAt: 1,
      ...(opts.ended === true ? { endedAt: 2, outcome: 'canceled' } : {}),
    } as typeof codeWorkRounds.$inferInsert)
  }

  const deps = () => ({ db, launchDeps: { db } as never })

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('the replacement does NOT start while the preempted round is still running', async () => {
    // The invariant, checked in the performer rather than trusted from the
    // caller: three different callers can reach it (the in-process wait, the
    // boot sweep, the next delivery) and any of them being early would put two
    // rounds on one worktree.
    await seedItem()
    await seedRound({ taskStatus: 'running' })

    const outcome = await advanceSupersedingWorkItem(deps(), 'item-1')
    expect(outcome.started).toBe(false)
    expect(outcome.reason).toContain('still')

    const [item] = await db.select().from(codeWorkItems).where(eq(codeWorkItems.id, 'item-1'))
    expect(item?.status).toBe('superseding')
  })

  test('an item that is not being preempted is left entirely alone', async () => {
    // Called on every delivery to heal a lost wait, so the no-op path is the
    // common one and must not touch the row.
    await seedItem({ status: 'running' })
    await seedRound({ taskStatus: 'running' })

    const outcome = await advanceSupersedingWorkItem(deps(), 'item-1')
    expect(outcome.started).toBe(false)
    expect(outcome.reason).toContain('not superseding')
  })

  test('a preempted item with nothing recorded to launch says so instead of starting a round', async () => {
    // What a revision registered before the payload existed looks like: `{at}`
    // and nothing else. Starting a round from it would produce one that fails
    // at `resolve-target` and reads as a broken capability, so the platform
    // refuses and says why.
    await seedItem({ pendingRevision: JSON.stringify({ at: 1 }) })
    await seedRound({ taskStatus: 'canceled', ended: true })

    const outcome = await advanceSupersedingWorkItem(deps(), 'item-1')
    expect(outcome.started).toBe(false)
    expect(outcome.reason).toContain('nothing to launch')
  })

  test('the pending revision keeps what the replacement round needs', async () => {
    // The write half of the same story: `register-pending-revision` used to
    // store a timestamp, which records THAT something arrived but not what.
    await db.insert(codeWorkItems).values({
      id: 'item-2',
      codeHostEndpointId: 'ep-1',
      stableProjectId: 'proj-1',
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: '99',
      status: 'queued',
      epoch: 1,
      createdAt: 1,
      updatedAt: 1,
    })

    await applyWorkItemEvent({
      db,
      workItemId: 'item-2',
      event: { kind: 'external-signal', signal: { kind: 'note' } },
      hasLiveRound: false,
      pendingRevision: { capability: 'mr-review', repoId: 'repo-1' },
    })

    const [row] = await db.select().from(codeWorkItems).where(eq(codeWorkItems.id, 'item-2'))
    const stored = JSON.parse(row?.pendingRevision ?? '{}') as Record<string, unknown>
    expect(stored.capability).toBe('mr-review')
    expect(stored.repoId).toBe('repo-1')
    // The timestamp stays: it is what "when did this arrive" reads.
    expect(typeof stored.at).toBe('number')
  })
})

describe('RFC-304 §2.2 — the publish critical section', () => {
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
      status: 'running',
      epoch: 3,
      createdAt: 1,
      updatedAt: 1,
    })
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a round at the current epoch may enter, and only one at a time', async () => {
    expect(await enterPublishSection(db, 'item-1', 3)).toBe(true)
    // A second round cannot join it: two rounds writing the same merge request
    // is what the section exists to make impossible.
    expect(await enterPublishSection(db, 'item-1', 3)).toBe(false)
    expect(await leavePublishSection(db, 'item-1', 3)).toBe(true)
    expect(await enterPublishSection(db, 'item-1', 3)).toBe(true)
  })

  test('a round whose epoch has been bumped may NOT enter', async () => {
    // The load-bearing refusal, and the one that had no caller. A preempted
    // round that reaches its publish stage anyway — because the cancel landed a
    // moment too late — describes a revision the author has already replaced,
    // and its remarks look current to whoever reads them.
    expect(await enterPublishSection(db, 'item-1', 2)).toBe(false)
    const [row] = await db.select().from(codeWorkItems).where(eq(codeWorkItems.id, 'item-1'))
    expect(row?.publishingEpoch).toBeNull()
  })

  test('leaving is scoped to the epoch that entered', async () => {
    // Otherwise a later round could clear a section it does not hold, which
    // re-opens exactly the window the section closes.
    expect(await enterPublishSection(db, 'item-1', 3)).toBe(true)
    expect(await leavePublishSection(db, 'item-1', 2)).toBe(false)
    const [row] = await db.select().from(codeWorkItems).where(eq(codeWorkItems.id, 'item-1'))
    expect(row?.publishingEpoch).toBe(3)
  })
})
