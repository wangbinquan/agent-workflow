// RFC-304 — the three joins the system-mock E2E found broken, locked here.
//
// `e2e/rfc304-capability-platform.spec.ts` is what caught these, by running a
// real webhook through a compiled daemon. That file only runs in CI, so this
// one puts the same three regressions in front of `gate:local`.
//
// All three are the pattern this RFC keeps rediscovering — both halves correct,
// no join — and all three were invisible to unit tests for the same reason:
// every unit test HANDS IN the thing that was wrong in production.
//
//   1. The round's host task launched as `scratch: true`, so `repoPath` was an
//      empty directory with no remote. `prepare-worktree` fetches the merge
//      request head from `origin` (design §5.2 — from the TARGET remote), so
//      every round died at stage two with "'origin' does not appear to be a git
//      repository". Unit tests pass `repoPath` in as an already-cloned fixture,
//      so the stage was always given exactly what production never gave it.
//
//   2. `resolveReviewerAgent` and `resolveCapabilityHooks` were called with
//      `repoId: task.repoPath` — a filesystem PATH where a cached-repo ULID
//      belongs. Both are `string`, so it compiled and simply never matched:
//      every round reported "no capability configuration exists for this
//      repository" and every AI stage refused, in every deployment. No team's
//      stage hook had ever fired either.
//
//   3. Nothing ever wrote a round's terminal outcome. `openRound` inserted, and
//      the only later write attached a task id — so a round whose thirteen
//      stages had all finished, and whose review was already on the merge
//      request, still read `running`. Every READER was built for the
//      vocabulary: `deriveRoundStatus`, the metrics buckets, the lifetime GC.
//      Only the writer was missing, and a missing writer never errors.
//
// The first two are locked as source-level assertions. That is the weaker kind
// of test and is used deliberately: the defect is a call-site argument inside a
// 5000-line scheduler branch that needs a live task, a resolved repository and
// a webhook to reach, and the argument is type-correct, so no type or runtime
// check can catch its return. What CAN be checked cheaply is that the exact
// wrong expression is not there.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeWorkItems, codeWorkRounds } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import {
  closeRound,
  openRound,
} from '../src/modules/code-capability/infrastructure/sqliteMonitorStore'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src')

const read = (relative: string): string => readFileSync(resolve(SRC, relative), 'utf8')

describe('RFC-304 — a round reaches a terminal outcome', () => {
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

  const rowOf = async (roundId: string) => {
    const [row] = await db.select().from(codeWorkRounds).where(eq(codeWorkRounds.id, roundId))
    return row
  }

  test('closing writes the outcome AND the end time', async () => {
    // Both, because the readers use both: `deriveRoundStatus` needs the outcome
    // and the metrics window filters on `endedAt`. A round with an outcome and
    // no end time is counted as still in flight, which is the state this whole
    // fix exists to stop producing.
    const round = await openRound({ db, workItemId: 'item-1', epoch: 1, now: 1_000 })
    expect((await rowOf(round.roundId))?.endedAt).toBeNull()

    await closeRound(db, round.roundId, 'published', 5_000)

    const row = await rowOf(round.roundId)
    expect({ outcome: row?.outcome, endedAt: row?.endedAt }).toEqual({
      outcome: 'published',
      endedAt: 5_000,
    })
  })

  test('the FIRST terminal answer wins — a second close does not move it', async () => {
    // Idempotence matters because finalisation is reachable more than once: a
    // retried node run, a recovery pass after a daemon restart. Letting a later
    // call overwrite would rewrite history — a round that failed at 10:00 would
    // report `published` at 10:05 because a retry of the same round succeeded.
    const round = await openRound({ db, workItemId: 'item-1', epoch: 1, now: 1_000 })
    await closeRound(db, round.roundId, 'failed', 5_000)
    await closeRound(db, round.roundId, 'published', 9_000)

    const row = await rowOf(round.roundId)
    expect({ outcome: row?.outcome, endedAt: row?.endedAt }).toEqual({
      outcome: 'failed',
      endedAt: 5_000,
    })
  })

  test('closing one round leaves the others alone', async () => {
    // The `WHERE id` guard, asserted rather than assumed: an accidental blanket
    // update would close every round of the work item, and on a long-lived
    // merge request that is a history of eighty rounds rewritten at once.
    const first = await openRound({ db, workItemId: 'item-1', epoch: 1, now: 1_000 })
    const second = await openRound({ db, workItemId: 'item-1', epoch: 1, now: 2_000 })

    await closeRound(db, second.roundId, 'published', 5_000)

    expect((await rowOf(first.roundId))?.endedAt).toBeNull()
    expect((await rowOf(second.roundId))?.outcome).toBe('published')
  })

  test('every terminal outcome the schema allows can actually be written', async () => {
    // Enumerated rather than spot-checked. `superseded` in particular has no
    // caller yet; if the column and the writer ever disagree about the
    // vocabulary, that should surface here rather than as a constraint failure
    // on the one production path that uses the rare value.
    for (const outcome of ['published', 'awaiting', 'failed', 'canceled', 'superseded'] as const) {
      const round = await openRound({ db, workItemId: 'item-1', epoch: 1, now: 1_000 })
      await closeRound(db, round.roundId, outcome, 5_000)
      expect((await rowOf(round.roundId))?.outcome).toBe(outcome)
    }
  })
})

describe('RFC-304 — the capability-cell key is an id, never a path', () => {
  test('the scheduler does not resolve capability config by `task.repoPath`', () => {
    // The exact defect: `repo_capability_config.repo_id` holds a cached-repo
    // ULID, so a path matches nothing and the round refuses with a message that
    // reads like a configuration mistake by the operator.
    const scheduler = read('services/scheduler.ts')
    expect(scheduler).not.toContain('repoId: task.repoPath')
  })

  test('both consumers of the cell are resolved through the same helper', () => {
    // Agent slots AND hooks read the same table, and both were wrong. Naming
    // the helper here means a third consumer added later either uses it or
    // makes this red — rather than quietly reintroducing the same mismatch in a
    // place nobody thinks to check.
    const scheduler = read('services/scheduler.ts')
    const uses = scheduler.split('cachedRepoIdForTask(db, taskId)').length - 1
    expect(uses).toBeGreaterThanOrEqual(3)
  })
})

describe('RFC-304 — a round runs inside the repository, not a scratch space', () => {
  test('neither launch site starts a round with `scratch: true`', () => {
    // `prepare-worktree` fetches the merge-request head from `origin` of the
    // round's repo path. A scratch launch hands it an empty directory with no
    // remote, so the stage cannot succeed no matter what else is correct — and
    // it fails with a git error that names neither the capability nor the
    // launch decision that caused it.
    const wake = read('services/codeCapabilityWake.ts')
    expect(wake).not.toContain('scratch: true')
  })

  test('both launch sites attach the repository the delivery resolved', () => {
    // Two sites — the monitor's dispatch and the direct round — and they are
    // easy to fix one at a time, which would leave whichever capability uses
    // the other path broken in exactly the way this test exists to prevent.
    const wake = read('services/codeCapabilityWake.ts')
    const attachments = wake.split('cachedRepoId: input.repoId').length - 1
    expect(attachments).toBe(2)
  })
})
