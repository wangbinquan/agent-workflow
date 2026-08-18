// RFC-304 T61 — the delivery chain, readable.
//
// The table has been WRITTEN since T61 (`openDelivery` and `advanceDelivery` are
// called from the dispatch path) and its three queries had no caller and no
// route. So the thing it exists to answer could not be asked.
//
// The migration's own header states that thing: an administrator reporting
// "review stopped on this repository" has `readiness = ready` — which says the
// CONFIG is complete, not that anything ran — and a last-trigger time, which
// does not separate
//
//   the webhook was never sent  ·  it arrived and routing dropped it  ·
//   it is queued behind a merge-request lease
//
// and those three have different fixes. Without a reader the operator picks one
// and hopes.
//
// These cases pin the three questions the query object answers, and the one it
// refuses: "show me everything" is not a troubleshooting view, and answering it
// would bury the incident the operator came for.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createCodeDeliveryChainQuery } from '../src/modules/code-capability/application/codeMatrixQuery'
import { seedDelivery } from './helpers/legacyCapabilitySeed'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-304 T61 — reading the delivery chain', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  /** One delivery that got as far as `step`, with the given outcome. */
  // T105 后写面已删：读面测试自持种子（表仍在——历史投递链可追溯）。行的
  // 终态就是 openDelivery→advanceDelivery 曾写出的最终形状。
  const seed = async (input: {
    correlationId: string
    project: string
    outcome?: { kind: 'dropped' | 'failed'; step: 'matched' | 'routed' | 'queued'; reason: string }
    now: number
  }): Promise<string> =>
    await seedDelivery(db, {
      correlationId: input.correlationId,
      stableProjectId: input.project,
      step: input.outcome?.step ?? 'received',
      outcome: input.outcome?.kind ?? 'ok',
      reason: input.outcome?.reason ?? null,
      now: input.now,
    })

  test('what happened on THIS project, newest first', async () => {
    await seed({ correlationId: 'c1', project: 'proj-1', now: 1_000 })
    await seed({ correlationId: 'c2', project: 'proj-1', now: 2_000 })
    await seed({ correlationId: 'other', project: 'proj-2', now: 3_000 })

    const rows = await createCodeDeliveryChainQuery(db).forProject({ stableProjectId: 'proj-1' })

    // Only this project's — an operator looking at one repository is not helped
    // by another's traffic.
    expect(rows.map((r) => r.correlationId)).toEqual(['c2', 'c1'])
  })

  test('what happened to ONE delivery, by the id that follows it across tables', async () => {
    // The correlation id is shared with the round and the ingress event on
    // purpose: without it the chain reconstructs by timestamp proximity, which
    // is wrong exactly when the platform is busy.
    await seed({ correlationId: 'c1', project: 'proj-1', now: 1_000 })
    await seed({ correlationId: 'c2', project: 'proj-1', now: 2_000 })

    const rows = await createCodeDeliveryChainQuery(db).forCorrelation('c2')
    expect(rows.map((r) => r.correlationId)).toEqual(['c2'])
  })

  test('what has been FAILING, and how a DROP differs from a failure', async () => {
    // The distinction is the point. "Routing dropped it" and "the round died"
    // have different fixes, and only one of them is an incident: a repository
    // that enabled no capability drops every delivery by design.
    await seed({ correlationId: 'ok-1', project: 'proj-1', now: 1_000 })
    await seed({
      correlationId: 'dropped-1',
      project: 'proj-1',
      outcome: { kind: 'dropped', step: 'routed', reason: 'no capability cell is enabled' },
      now: 2_000,
    })
    await seed({
      correlationId: 'failed-1',
      project: 'proj-1',
      outcome: { kind: 'failed', step: 'queued', reason: 'the merge-request lease was held' },
      now: 3_000,
    })

    const failures = await createCodeDeliveryChainQuery(db).failures({
      stableProjectId: 'proj-1',
    })
    // FAILED only — `dropped` is deliberately not a failure. A repository with
    // no capability cell enabled drops every delivery it receives, and that is
    // normal; folding those in would bury the genuine failures under routine
    // ones, which is the same wall of noise the view exists to cut through.
    expect(failures.map((r) => r.correlationId)).toEqual(['failed-1'])
    // And the REASON travels: "failed" on its own moves the question rather
    // than answering it.
    expect(failures[0]?.reason).toContain('merge-request lease')

    // The drop is not lost — it is in the project's own chain, with its reason,
    // which is where an operator asking "why did nothing happen here" looks.
    const chain = await createCodeDeliveryChainQuery(db).forProject({
      stableProjectId: 'proj-1',
    })
    const dropped = chain.find((r) => r.correlationId === 'dropped-1')
    expect(dropped?.outcome).toBe('dropped')
    expect(dropped?.reason).toContain('no capability cell is enabled')
  })

  test('failures across every project, for the operator who does not know where to look', async () => {
    await seed({
      correlationId: 'a',
      project: 'proj-1',
      outcome: { kind: 'failed', step: 'routed', reason: 'x' },
      now: 1_000,
    })
    await seed({
      correlationId: 'b',
      project: 'proj-2',
      outcome: { kind: 'failed', step: 'routed', reason: 'y' },
      now: 2_000,
    })

    const rows = await createCodeDeliveryChainQuery(db).failures({})
    expect(rows.map((r) => r.correlationId).sort()).toEqual(['a', 'b'])
  })

  test('a limit is honoured — a busy repository is not a wall of rows', async () => {
    for (let i = 0; i < 5; i++) {
      await seed({ correlationId: `c${String(i)}`, project: 'proj-1', now: 1_000 + i })
    }
    const rows = await createCodeDeliveryChainQuery(db).forProject({
      stableProjectId: 'proj-1',
      limit: 2,
    })
    expect(rows).toHaveLength(2)
    // The newest two, not an arbitrary two: an operator troubleshooting now
    // cares about what just happened.
    expect(rows.map((r) => r.correlationId)).toEqual(['c4', 'c3'])
  })
})
