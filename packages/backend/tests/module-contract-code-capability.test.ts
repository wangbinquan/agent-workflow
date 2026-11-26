// Module contract audit: legacy history caps its returned projection through the
// composition entry. Fixtures are frozen history packages, not live legacy writers.
// Counts below constrain table-reader invocations, not rows scanned: history.rows
// still loads complete history tables, so this is NOT bounded database pagination.
import { expect, test } from 'bun:test'
import {
  composeCodeHistoryQueries,
  type CodeHistoryReader,
} from '@/modules/code-capability/composition/historyQueries'
import { describeEachProvider } from './helpers/eachProvider'
import {
  historyFixtureReader,
  seedCodeHistoryRows,
  seedEmptyCodeHistory,
} from './helpers/legacyCapabilitySeed'

const NOW = 1_800_000_000_000

describeEachProvider('module contract: code-capability historical reads', (harness) => {
  function compose() {
    const history = historyFixtureReader(harness.db)
    const reads: string[] = []
    const counted: CodeHistoryReader = {
      rows(table) {
        reads.push(table)
        return history.rows(table)
      },
      find: (table, id) => history.find(table, id),
    }
    return {
      reads,
      queries: composeCodeHistoryQueries(
        harness.db,
        {
          async existingIds() {
            return []
          },
        },
        counted,
      ),
    }
  }

  test('work-item pages cap items and rounds while loading three history tables once per request', async () => {
    await seedCodeHistoryRows(
      harness.db,
      'code_work_items',
      Array.from({ length: 105 }, (_, index) => ({
        id: `item-${index}`,
        codeHostEndpointId: 'ep',
        stableProjectId: 'project',
        capability: 'review',
        anchorKind: 'mr',
        anchorId: String(index),
        status: 'open',
        epoch: 1,
        createdAt: NOW - index,
      })),
    )
    await seedCodeHistoryRows(
      harness.db,
      'code_work_rounds',
      Array.from({ length: 25 }, (_, index) => ({
        id: `round-${index}`,
        workItemId: 'item-0',
        roundSeq: index + 1,
        outcome: index === 24 ? null : 'published',
        stageContractVer: 1,
        baselineSha: 'a'.repeat(40),
        startedAt: NOW + index,
        endedAt: index === 24 ? null : NOW + index + 1,
      })),
    )
    await seedCodeHistoryRows(harness.db, 'code_round_stages', [
      {
        id: 'stage-2',
        roundId: 'round-24',
        stageName: 'publish',
        stageSeq: 2,
        stageKind: 'program',
        status: 'pending',
        error: null,
        startedAt: null,
        endedAt: null,
      },
      {
        id: 'stage-1',
        roundId: 'round-24',
        stageName: 'review',
        stageSeq: 1,
        stageKind: 'ai',
        status: 'running',
        error: null,
        startedAt: NOW,
        endedAt: null,
      },
    ])
    const { queries, reads } = compose()
    const first = await queries.workItems.page({
      stableProjectId: 'project',
      limit: 500,
      roundLimit: 500,
    })
    expect(first.items).toHaveLength(100)
    expect(first.items[0]).toMatchObject({ workItemId: 'item-0', roundsHidden: 5 })
    expect(first.items[0]?.rounds).toHaveLength(20)
    expect(first.items[0]?.rounds[0]).toMatchObject({ roundId: 'round-24', status: 'running' })
    expect(first.items[0]?.rounds[0]?.stages.map((stage) => stage.stageName)).toEqual([
      'review',
      'publish',
    ])
    expect(reads).toEqual(['code_work_items', 'code_work_rounds', 'code_round_stages'])
    expect(first.nextCursor).not.toBeNull()
    const next = await queries.workItems.page({
      stableProjectId: 'project',
      limit: 500,
      cursor: first.nextCursor,
    })
    expect(next.items.map((item) => item.workItemId)).toEqual([
      'item-100',
      'item-101',
      'item-102',
      'item-103',
      'item-104',
    ])
    expect(next.nextCursor).toBeNull()
    expect(new Set([...first.items, ...next.items].map((item) => item.workItemId)).size).toBe(105)
    expect(reads).toEqual([
      'code_work_items',
      'code_work_rounds',
      'code_round_stages',
      'code_work_items',
      'code_work_rounds',
      'code_round_stages',
    ])
  })

  test('work-item cursors retain timestamp ties across pages without mixing projects or capabilities', async () => {
    // application/codeMatrixQuery documents createdAt DESC + id DESC as the
    // cursor contract. Keep this oracle explicit: neither the frozen epoch-1
    // query nor the production cursor/sort helpers define expected results here.
    const fixtures = [
      { id: 'c-tied', createdAt: NOW },
      { id: 'newest', createdAt: NOW + 1 },
      { id: 'foreign-project', createdAt: NOW + 3, stableProjectId: 'other-project' },
      { id: 'older-2', createdAt: NOW - 2 },
      { id: 'z-tied', createdAt: NOW },
      { id: 'foreign-capability', createdAt: NOW + 2, capability: 'repair' },
      { id: 'a-tied', createdAt: NOW },
      { id: 'older-1', createdAt: NOW - 1 },
      { id: 'm-tied', createdAt: NOW },
    ]
    await seedCodeHistoryRows(
      harness.db,
      'code_work_items',
      fixtures.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        codeHostEndpointId: 'ep',
        stableProjectId: row.stableProjectId ?? 'project-ties',
        capability: row.capability ?? 'review',
        anchorKind: 'mr',
        anchorId: row.id,
        status: 'open',
        epoch: 1,
      })),
    )
    const { queries } = compose()
    const expectedPages = [
      { ids: ['newest', 'z-tied', 'm-tied'], cursor: `${NOW}:m-tied` },
      { ids: ['c-tied', 'a-tied', 'older-1'], cursor: `${NOW - 1}:older-1` },
      { ids: ['older-2'], cursor: null },
    ]
    let cursor: string | null = null
    const seen: string[] = []
    for (const expected of expectedPages) {
      const page = await queries.workItems.page({
        stableProjectId: 'project-ties',
        capability: 'review',
        limit: 3,
        cursor,
      })
      const ids = page.items.map((item) => item.workItemId)
      expect(ids).toEqual(expected.ids)
      expect(page.nextCursor).toBe(expected.cursor)
      seen.push(...ids)
      cursor = page.nextCursor
    }
    expect(seen).toEqual(['newest', 'z-tied', 'm-tied', 'c-tied', 'a-tied', 'older-1', 'older-2'])
    expect(new Set(seen).size).toBe(7)
    expect(cursor).toBeNull()
  })

  test('expanded attempts are ordered and capped independently of unrelated rounds', async () => {
    await seedCodeHistoryRows(
      harness.db,
      'code_ai_attempts',
      Array.from({ length: 205 }, (_, index) => ({
        id: `attempt-${index}`,
        roundId: 'wanted-round',
        stageName: 'review',
        shardKey: `shard-${index}`,
        rerunSeq: 0,
        attemptSeq: index,
        status: 'done',
        validationOutcome: 'accepted',
        sessionRef: `session-${index}`,
        nodeRunId: null,
        startedAt: NOW + index,
        endedAt: NOW + index + 1,
      })).reverse(),
    )
    await seedCodeHistoryRows(harness.db, 'code_ai_attempts', {
      id: 'unrelated',
      roundId: 'other-round',
      stageName: 'review',
      shardKey: '',
      rerunSeq: 0,
      attemptSeq: 0,
      status: 'failed',
      validationOutcome: 'invalid',
      sessionRef: null,
      nodeRunId: null,
      startedAt: NOW - 1,
      endedAt: NOW,
    })
    const { queries, reads } = compose()
    const attempts = await queries.attempts.forRound('wanted-round')
    expect(attempts).toHaveLength(200)
    expect(attempts[0]).toMatchObject({
      attemptId: 'attempt-0',
      shardKey: 'shard-0',
      validationOutcome: 'accepted',
    })
    expect(attempts.at(-1)?.attemptId).toBe('attempt-199')
    expect(attempts.some((attempt) => attempt.attemptId === 'unrelated')).toBe(false)
    expect(reads).toEqual(['code_ai_attempts'])
    expect(await queries.attempts.forRound('missing-round')).toEqual([])
  })

  test('delivery filters preserve failure diagnostics and correlation chains across bounded project reads', async () => {
    await seedCodeHistoryRows(harness.db, 'code_trigger_deliveries', [
      {
        id: 'd-old',
        correlationId: 'trace',
        stableProjectId: 'project',
        capability: 'review',
        step: 'received',
        outcome: 'failed',
        reason: 'adapter-unavailable',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'd-new',
        correlationId: 'trace',
        stableProjectId: 'project',
        capability: 'review',
        step: 'dispatch',
        outcome: 'launched',
        reason: null,
        createdAt: NOW + 1,
        updatedAt: NOW + 1,
      },
      {
        id: 'other',
        correlationId: 'another-trace',
        stableProjectId: 'other-project',
        capability: 'review',
        step: 'received',
        outcome: 'failed',
        reason: 'no-source',
        createdAt: NOW + 2,
        updatedAt: NOW + 2,
      },
    ])
    const { queries } = compose()
    expect(
      (await queries.deliveries.forProject({ stableProjectId: 'project', limit: 1 })).map(
        (row) => row.id,
      ),
    ).toEqual(['d-new'])
    expect((await queries.deliveries.forCorrelation('trace')).map((row) => row.id)).toEqual([
      'd-new',
      'd-old',
    ])
    expect(await queries.deliveries.failures({ stableProjectId: 'project', limit: 10 })).toEqual([
      expect.objectContaining({ id: 'd-old', outcome: 'failed', reason: 'adapter-unavailable' }),
    ])
    expect(await queries.deliveries.forProject({ stableProjectId: 'project', limit: 0 })).toEqual(
      [],
    )
  })

  test('invalid page sizes do no history IO and history-reader failure is not an empty successful page', async () => {
    const missingArchive = compose().queries
    await expect(
      missingArchive.deliveries.forProject({ stableProjectId: 'project' }),
    ).rejects.toThrow('code-history-package-missing')
    await expect(missingArchive.deliveries.forCorrelation('trace')).rejects.toThrow(
      'code-history-package-missing',
    )
    await expect(missingArchive.deliveries.failures({})).rejects.toThrow(
      'code-history-package-missing',
    )
    await seedEmptyCodeHistory(harness.db)
    const { queries, reads } = compose()
    await expect(queries.workItems.page({ limit: 1.5 })).rejects.toThrow(
      'code-history-limit-not-integer',
    )
    expect(reads).toEqual([])
    const failure = new Error('history-package-read-failed')
    const failed = composeCodeHistoryQueries(
      harness.db,
      {
        async existingIds() {
          return []
        },
      },
      {
        async rows() {
          throw failure
        },
        async find() {
          throw failure
        },
      },
    )
    await expect(failed.workItems.page({ limit: 10 })).rejects.toBe(failure)
    await expect(failed.attempts.forRound('round')).rejects.toBe(failure)
    await expect(failed.deliveries.forCorrelation('trace')).rejects.toBe(failure)
    expect(await queries.workItems.page({ limit: 10 })).toEqual({ items: [], nextCursor: null })
    expect(await queries.deliveries.forProject({ stableProjectId: 'project' })).toEqual([])
    expect(await queries.deliveries.forCorrelation('trace')).toEqual([])
    expect(await queries.deliveries.failures({})).toEqual([])
  })
})
