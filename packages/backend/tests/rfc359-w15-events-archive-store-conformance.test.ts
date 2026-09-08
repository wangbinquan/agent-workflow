// RFC-359 AC1: the two established archive owners must retain their actual
// numeric rows, state watermarks and inclusive/exclusive deletion boundaries.
// The original events-archive suite separately exercises all four DB/FS faults.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { maintenanceState, nodeRunEvents, nodeRuns, tasks, workflows } from '@/db/schema'
import { createEventsArchiveStore } from '@/platform/persistence/eventsArchiveStore'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlEventsArchiveStore } from '@/platform/persistence/postgresqlEventsArchive'
import { createSqliteEventsArchiveStore } from '@/platform/persistence/sqlite/systemEventsArchive'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_788_001_734_000

function isPostgresql(db: ProviderNeutralDatabase): db is PostgresqlDatabaseClient {
  return '$provider' in db && db.$provider === 'postgresql'
}

function assertSqlite(db: ProviderNeutralDatabase): asserts db is DbClient {
  if ('$provider' in db) throw new Error('unexpected-archive-fixture-provider')
}

function originalConstructor(db: ProviderNeutralDatabase) {
  if (isPostgresql(db)) return createPostgresqlEventsArchiveStore(db)
  assertSqlite(db)
  return createSqliteEventsArchiveStore(db)
}

async function seed(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(workflows).values({
    id: 'archive-wf',
    name: 'archive-wf',
    definition: '{}',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(tasks).values({
    id: 'archive-task',
    name: 'archive-task',
    workflowId: 'archive-wf',
    workflowSnapshot: '{}',
    repoPath: '/tmp/archive-source',
    worktreePath: '/tmp/archive-task',
    baseBranch: 'main',
    branch: 'archive-task',
    status: 'running',
    inputs: '{}',
    startedAt: NOW,
  })
  await db.insert(nodeRuns).values(
    ['archive-a', 'archive-b', 'archive-empty'].map((id) => ({
      id,
      taskId: 'archive-task',
      nodeId: id,
      status: 'running' as const,
      startedAt: NOW,
    })),
  )
  await db.insert(nodeRunEvents).values([
    { id: 7, nodeRunId: 'archive-a', ts: NOW, kind: 'text', payload: '雪🌲' },
    {
      id: 9,
      nodeRunId: 'archive-a',
      ts: NOW + 1,
      kind: 'stderr',
      payload: 'tail',
      sessionId: 'session-a',
      parentSessionId: 'parent-a',
    },
    { id: 11, nodeRunId: 'archive-b', ts: NOW + 2, kind: 'text', payload: '' },
    { id: 250_001, nodeRunId: 'archive-a', ts: NOW + 3, kind: 'text', payload: 'last' },
  ])
}

describeEachProvider('RFC-359 events archive store preserves original owner behavior', (h) => {
  test('empty tables retain nulls, numeric zeroes and durable state upsert semantics', async () => {
    const store = originalConstructor(h.db)
    expect(Object.isFrozen(store)).toBe(true)
    expect(await store.readState('archive-fixture')).toBeNull()
    expect(await store.averageRecentPayloadBytes(10)).toBeNull()
    expect(await store.maxEventId()).toBe(0)
    expect(await store.countAllEvents()).toBe(0)
    expect(await store.oldestEvent()).toBeNull()
    expect(await store.countEventIds({ afterId: 0, throughId: 250_000 })).toBe(0)
    expect(await store.listDistinctNodeRunIds({ afterId: 0, throughId: 250_000 })).toEqual([])
    expect(await store.countEventsByNodeRunIds([])).toEqual([])
    expect(await store.countEventsForNodeRun('missing')).toBe(0)
    expect(await store.findTaskIdForNodeRun('missing')).toBeNull()
    expect(await store.listOldestEvents('missing', 2)).toEqual([])

    await store.writeState('archive-fixture', '7', NOW)
    await store.writeState('archive-fixture', '{"throughId":9}', NOW + 1)
    expect(await store.readState('archive-fixture')).toBe('{"throughId":9}')
    expect(
      await h.db.select().from(maintenanceState).where(eq(maintenanceState.key, 'archive-fixture')),
    ).toEqual([{ key: 'archive-fixture', value: '{"throughId":9}', updatedAt: NOW + 1 }])
  })

  test('sparse IDs, mixed channels and numeric projections survive exact range deletion', async () => {
    await seed(h.db)
    const store = originalConstructor(h.db)
    const shared = createEventsArchiveStore(h.db)
    expect(await store.maxEventId()).toBe(250_001)
    expect(await store.countAllEvents()).toBe(4)
    expect(await store.averageRecentPayloadBytes(2)).toBe(2)
    expect(await store.averageRecentPayloadBytes(4)).toBe(2.5)
    expect(await store.countEventIds({ afterId: 7, throughId: 11 })).toBe(2)
    expect(await store.countEventIds({ afterId: 7, throughId: 11, nodeRunId: 'archive-a' })).toBe(1)
    expect([...(await store.listDistinctNodeRunIds({ afterId: 7, throughId: 11 }))].sort()).toEqual(
      ['archive-a', 'archive-b'],
    )
    expect(
      [...(await store.countEventsByNodeRunIds(['archive-a', 'archive-b', 'archive-empty']))].sort(
        (a, b) => a.nodeRunId.localeCompare(b.nodeRunId),
      ),
    ).toEqual([
      { nodeRunId: 'archive-a', count: 3 },
      { nodeRunId: 'archive-b', count: 1 },
    ])
    expect(await store.oldestEvent()).toEqual({ id: 7, nodeRunId: 'archive-a' })
    expect(await store.countEventsForNodeRun('archive-a')).toBe(3)
    expect(await store.findTaskIdForNodeRun('archive-empty')).toBe('archive-task')
    const expectedRows = [
      {
        id: 7,
        ts: NOW,
        kind: 'text',
        payload: '雪🌲',
        sessionId: null,
        parentSessionId: null,
      },
      {
        id: 9,
        ts: NOW + 1,
        kind: 'stderr',
        payload: 'tail',
        sessionId: 'session-a',
        parentSessionId: 'parent-a',
      },
    ]
    expect(await store.listOldestEvents('archive-a', 2)).toEqual(expectedRows)
    expect(await shared.listOldestEvents('archive-a', 2)).toEqual(expectedRows)

    await store.deleteNodeRunEventsRange({ nodeRunId: 'archive-a', afterId: 7, throughId: 11 })
    expect(await shared.countAllEvents()).toBe(3)
    expect((await shared.listOldestEvents('archive-a', 10)).map((row) => row.id)).toEqual([
      7, 250_001,
    ])
    expect((await shared.listOldestEvents('archive-b', 10)).map((row) => row.id)).toEqual([11])
    await store.deleteNodeRunEventsThrough('archive-a', 7)
    expect(await shared.countAllEvents()).toBe(2)
    expect(await shared.oldestEvent()).toEqual({ id: 11, nodeRunId: 'archive-b' })
    expect(await shared.countEventIds({ afterId: 250_000, throughId: 250_001 })).toBe(1)
  })
})
