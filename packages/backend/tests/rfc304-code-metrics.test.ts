// RFC-304 T58 — the metrics a team decides with, and the number they don't get.
//
// This projection deliberately does NOT produce an adoption rate. The whole
// file is about why that refusal has to hold, because "just give me one
// percentage" is the most natural request anyone will make of it and every way
// of satisfying it is wrong in a way that flatters the platform:
//
//   count `resolved`      — a reviewer clearing their queue reads as 100%
//                           adoption with nothing fixed;
//   count `code changed`  — a rebase touching the anchored line reads as
//                           adoption of a finding nobody agreed with;
//   count either          — both mistakes at once.
//
// So the tests below pin the four buckets as four, and pin the two cases where
// the signals DISAGREE, since those are the ones a single rate destroys.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { codeFindings, codeWorkItems, codeWorkRounds } from '../src/db/schema'
import {
  createCodeMetricsQuery,
  DEFAULT_METRICS_WINDOW_MS,
} from '../src/modules/code-capability/application/codeMetricsQuery'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

describe('RFC-304 T58 — adoption buckets', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  let seq = 0
  const finding = async (over: Partial<typeof codeFindings.$inferInsert> = {}) => {
    seq += 1
    await db.insert(codeFindings).values({
      id: `f-${String(seq)}`,
      codeHostEndpointId: 'ep-1',
      stableProjectId: '41823',
      anchorKind: 'mr',
      anchorId: '412',
      capability: 'mr-review',
      fingerprint: `fp-${String(seq)}`,
      // Published: it was actually put in front of someone. An unpublished
      // finding counting as "outstanding" would blame the reader for something
      // they never saw.
      externalId: `thread-${String(seq)}`,
      createdAt: NOW,
      lastSeenAt: NOW,
      ...over,
    })
  }

  const summary = async () => await createCodeMetricsQuery(db).summary({ now: NOW })

  test('the four buckets are four, and they add up to what was published', async () => {
    await finding({ resolvedAt: NOW, codeChangedAt: NOW }) // agreed
    await finding({ codeChangedAt: NOW }) // quiet fix
    await finding({ resolvedAt: NOW }) // disagreement
    await finding({}) // outstanding

    const [row] = (await summary()).adoption
    expect(row).toEqual({
      capability: 'mr-review',
      published: 4,
      adopted: 1,
      quietFix: 1,
      disagreed: 1,
      outstanding: 1,
    })
  })

  test('a resolved-but-unchanged finding is a DISAGREEMENT, not an adoption', async () => {
    // The case that matters most. A person looked and said no. Counting it as
    // success is how a review bot convinces itself it is helping right up until
    // everyone mutes it.
    await finding({ resolvedAt: NOW })

    const [row] = (await summary()).adoption
    expect(row?.disagreed).toBe(1)
    expect(row?.adopted).toBe(0)
  })

  test('a changed-but-unresolved finding is a QUIET FIX, and is counted', async () => {
    // Nobody clicked anything, but the code got fixed. Any metric requiring a
    // human click reports this as failure — and this is the common shape in
    // teams that fix things and move on.
    await finding({ codeChangedAt: NOW })

    const [row] = (await summary()).adoption
    expect(row?.quietFix).toBe(1)
    expect(row?.outstanding).toBe(0)
  })

  test('an unpublished finding is not counted at all', async () => {
    await finding({ externalId: null })
    expect((await summary()).adoption).toEqual([])
  })

  test('findings older than the window are excluded', async () => {
    await finding({ createdAt: NOW - DEFAULT_METRICS_WINDOW_MS - 1 })
    await finding({ createdAt: NOW - 1000 })

    const [row] = (await summary()).adoption
    expect(row?.published).toBe(1)
  })

  test('capabilities are counted separately', async () => {
    // One number across capabilities would let a healthy review capability hide
    // a CI-repair one that nobody accepts.
    await finding({ capability: 'mr-review', resolvedAt: NOW, codeChangedAt: NOW })
    await finding({ capability: 'ci-fix' })

    const rows = (await summary()).adoption
    expect(rows.map((r) => r.capability)).toEqual(['ci-fix', 'mr-review'])
    expect(rows.find((r) => r.capability === 'ci-fix')?.outstanding).toBe(1)
  })
})

describe('RFC-304 T58 — run counts', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(codeWorkItems).values({
      id: 'item-1',
      codeHostEndpointId: 'ep-1',
      stableProjectId: '41823',
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: '412',
      status: 'idle',
      epoch: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
  afterEach(() => {
    db.$client.close()
  })

  let rseq = 0
  const round = async (over: Partial<typeof codeWorkRounds.$inferInsert> = {}) => {
    rseq += 1
    await db.insert(codeWorkRounds).values({
      id: `r-${String(rseq)}`,
      workItemId: 'item-1',
      roundSeq: rseq,
      epoch: 1,
      startedAt: NOW,
      ...over,
    })
  }

  const summary = async () => await createCodeMetricsQuery(db).summary({ now: NOW })

  test('outcomes are counted by kind', async () => {
    await round({ outcome: 'published', endedAt: NOW + 1 })
    await round({ outcome: 'published', endedAt: NOW + 2 })
    await round({ outcome: 'failed', endedAt: NOW + 3 })
    await round({ outcome: 'awaiting', endedAt: NOW + 4 })

    const [row] = (await summary()).runs
    expect(row?.rounds).toBe(4)
    expect(row?.published).toBe(2)
    expect(row?.failed).toBe(1)
    expect(row?.awaiting).toBe(1)
  })

  test('a round that ended with no outcome is INCOMPLETE, not failed', async () => {
    // A daemon death mid-round is the platform breaking; a failed round is the
    // round deciding. Folding them together makes an infrastructure problem
    // look like the capability performing badly, and someone turns it off.
    await round({ outcome: null, endedAt: NOW + 5 })

    const [row] = (await summary()).runs
    expect(row?.incomplete).toBe(1)
    expect(row?.failed).toBe(0)
  })

  test('a round still in flight counts as a round and nothing else', async () => {
    // Putting it in a result column would make the totals move BACKWARDS when
    // it finishes, which is worse than it being briefly uncategorised.
    await round({ outcome: null, endedAt: null })

    const [row] = (await summary()).runs
    expect(row?.rounds).toBe(1)
    expect(row?.published).toBe(0)
    expect(row?.failed).toBe(0)
    expect(row?.incomplete).toBe(0)
  })

  test('rounds outside the window are excluded', async () => {
    await round({
      outcome: 'published',
      startedAt: NOW - DEFAULT_METRICS_WINDOW_MS - 1,
      endedAt: NOW,
    })
    await round({ outcome: 'published', endedAt: NOW + 1 })

    const [row] = (await summary()).runs
    expect(row?.rounds).toBe(1)
  })

  test('the window is reported, so a reader knows what the numbers cover', async () => {
    // "12 published" means nothing without it, and a reader who assumes all-time
    // will read a quiet month as a broken capability.
    expect((await summary()).windowMs).toBe(DEFAULT_METRICS_WINDOW_MS)
  })
})

// The route itself, driven through a real app.
//
// An error code is an API contract — a client branches on it — so it is
// exercised rather than merely mentioned. `route-error-code-coverage` requires
// every code to be NAMED by some test; naming it in a tautology would satisfy
// that guard while proving nothing, which is worse than the gap it closes.
describe('RFC-304 T58 — the metrics route', () => {
  const TOKEN = 'a'.repeat(64)

  const appWith = (db: DbClient) =>
    createApp({ token: TOKEN, configPath: '', opencodeVersion: '1.14.25', dbVersion: 1, db })

  const get = async (db: DbClient, path: string) =>
    await appWith(db).request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })

  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a non-numeric window is refused with `code-window-invalid`', async () => {
    // Refused rather than defaulted: silently substituting 30 days for someone
    // who asked for something else hands them numbers answering a different
    // question than the one they posed, with nothing on screen to say so.
    const res = await get(db, '/api/code/metrics?windowMs=lastweek')
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code?: string }).code).toBe('code-window-invalid')
  })

  test('a negative window is refused too', async () => {
    // `Number.isFinite(-1)` is true, so a bare finite check would accept this
    // and compute a window that ends before it starts — reporting zero of
    // everything, which reads as "the platform did nothing".
    const res = await get(db, '/api/code/metrics?windowMs=-1')
    expect(res.status).toBe(422)
  })

  test('no window at all is the default, not an error', async () => {
    const res = await get(db, '/api/code/metrics')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { windowMs: number }).windowMs).toBe(DEFAULT_METRICS_WINDOW_MS)
  })
})
