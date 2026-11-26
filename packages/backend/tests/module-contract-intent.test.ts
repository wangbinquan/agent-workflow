// Module contract audit: existing Intent suites cover generation/apply and mocked maintenance.
// Exercise the public maintenance commands with real persistence, including admission-time
// recovery snapshots, scratch retention boundaries and one batched running-turn lookup.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { composeIntentMaintenanceCommandsForDatabase } from '@/modules/intent/composition/maintenance'
import { createAgentExecutionQueries } from '@/modules/resource-catalog/composition'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { IntentScratchStore } from '@/modules/intent/application/ports/intentScratchStore'
import { describeEachProvider } from './helpers/eachProvider'

async function seedSession(db: PersistenceDb, id: string, inFlightTurnId: string | null = null) {
  const { intentSessions } = tablesOf(db)
  await insertOne(db, intentSessions, {
    id,
    ownerUserId: 'intent-contract-owner',
    inFlightTurnId,
    createdAt: 1,
    updatedAt: 1,
  })
}

async function seedTurn(
  db: PersistenceDb,
  input: {
    id: string
    sessionId: string
    seq: number
    createdAt: number
    kind: 'running' | 'message'
    captureState?: 'live' | 'complete'
  },
) {
  const { intentTurns } = tablesOf(db)
  await insertOne(db, intentTurns, {
    ...input,
    role: 'agent',
    contentJson: '{}',
    scratchRetained: true,
  })
}

describeEachProvider('module contract — intent maintenance', (harness) => {
  function commands(scratch: IntentScratchStore = { staleTurnIds: () => [], remove() {} }) {
    return composeIntentMaintenanceCommandsForDatabase({
      db: harness.db,
      createAgentExecutionQueries,
      scratch,
    })
  }

  test('boot recovery settles only the captured turns, preserves complete capture and is repeatable', async () => {
    await seedSession(harness.db, 'intent-a', 'turn-live')
    await seedSession(harness.db, 'intent-b', 'turn-complete')
    await seedTurn(harness.db, {
      id: 'turn-live',
      sessionId: 'intent-a',
      seq: 1,
      createdAt: 1,
      kind: 'running',
      captureState: 'live',
    })
    await seedTurn(harness.db, {
      id: 'turn-complete',
      sessionId: 'intent-b',
      seq: 1,
      createdAt: 1,
      kind: 'running',
      captureState: 'complete',
    })
    const maintenance = commands()
    const snapshot = await maintenance.recovery.bootTurnIds()
    expect(snapshot).toEqual(['turn-live', 'turn-complete'])
    await seedSession(harness.db, 'intent-c', 'turn-new')
    await seedTurn(harness.db, {
      id: 'turn-new',
      sessionId: 'intent-c',
      seq: 1,
      createdAt: 2,
      kind: 'running',
      captureState: 'live',
    })
    expect(await maintenance.recovery.recover({ recoverTurnIds: snapshot, now: 500 })).toEqual({
      orphanedTurns: 2,
      queuedWorkingSets: 0,
      queuedSessionIds: [],
    })
    const { intentTurns, intentSessions } = tablesOf(harness.db)
    const turns = await harness.db.select().from(intentTurns)
    expect(turns.find((row) => row.id === 'turn-live')).toMatchObject({
      kind: 'error',
      captureState: 'incomplete',
      captureIncompleteReason: 'post-exit-flush-timeout',
      scratchRetained: true,
      contentJson: JSON.stringify({ code: 'intent-run-daemon-restart' }),
    })
    expect(turns.find((row) => row.id === 'turn-complete')).toMatchObject({
      kind: 'error',
      captureState: 'complete',
      captureIncompleteReason: null,
    })
    expect(turns.find((row) => row.id === 'turn-new')).toMatchObject({
      kind: 'running',
      captureState: 'live',
    })
    expect(
      await harness.db
        .select({ id: intentSessions.id })
        .from(intentSessions)
        .where(eq(intentSessions.updatedAt, 500))
        .orderBy(intentSessions.id),
    ).toEqual([{ id: 'intent-a' }, { id: 'intent-b' }])
    expect(await maintenance.recovery.recover({ recoverTurnIds: snapshot, now: 600 })).toEqual({
      orphanedTurns: 0,
      queuedWorkingSets: 0,
      queuedSessionIds: [],
    })
    expect(await maintenance.recovery.bootTurnIds()).toEqual(['turn-new'])
  })

  test('scratch sweep keeps running, failed-removal and exact-cutoff turns while clearing successfully removed older turns', async () => {
    await seedSession(harness.db, 'intent-scratch')
    for (const [index, id] of [
      'scratch-removed',
      'scratch-failed',
      'scratch-running',
      'scratch-boundary',
    ].entries()) {
      await seedTurn(harness.db, {
        id,
        sessionId: 'intent-scratch',
        seq: index + 1,
        createdAt: id === 'scratch-boundary' ? 100 : 99,
        kind: id === 'scratch-running' ? 'running' : 'message',
      })
    }
    const removed: string[] = []
    const maintenance = commands({
      staleTurnIds(cutoff) {
        expect(cutoff).toBe(100)
        return ['scratch-removed', 'scratch-failed', 'scratch-running']
      },
      async remove(id) {
        if (id === 'scratch-failed') throw new Error('fixture scratch filesystem unavailable')
        removed.push(id)
      },
    })
    const recording = harness.recordStatements()
    try {
      expect(await maintenance.scratch.sweep({ retentionHours: 1, now: 3_600_100 })).toEqual({
        removed: 1,
      })
    } finally {
      recording.stop()
    }
    expect(removed).toEqual(['scratch-removed'])
    const { intentTurns } = tablesOf(harness.db)
    const rows = await harness.db
      .select({ id: intentTurns.id, retained: intentTurns.scratchRetained })
      .from(intentTurns)
    expect(Object.fromEntries(rows.map((row) => [row.id, row.retained]))).toEqual({
      'scratch-removed': false,
      'scratch-failed': true,
      'scratch-running': true,
      'scratch-boundary': true,
    })
    const reads = recording.selects().filter(({ sql }) => /"intent_turns"/.test(sql))
    expect(reads).toHaveLength(2)
    const writes = recording.statements.filter(
      ({ sql }) => /^\s*update\b/i.test(sql) && /"intent_turns"/.test(sql),
    )
    expect(writes).toHaveLength(1)
  })

  test('a scratch inventory failure propagates without changing persisted retention or attempting removal', async () => {
    await seedSession(harness.db, 'intent-failure')
    await seedTurn(harness.db, {
      id: 'scratch-unchanged',
      sessionId: 'intent-failure',
      seq: 1,
      createdAt: 1,
      kind: 'message',
    })
    const failure = new Error('scratch listing unavailable')
    let removals = 0
    const maintenance = commands({
      staleTurnIds() {
        throw failure
      },
      remove() {
        removals += 1
      },
    })
    await expect(maintenance.scratch.sweep({ retentionHours: 0, now: 10 })).rejects.toBe(failure)
    expect(removals).toBe(0)
    const { intentTurns } = tablesOf(harness.db)
    expect(
      await harness.db
        .select({ retained: intentTurns.scratchRetained })
        .from(intentTurns)
        .where(eq(intentTurns.id, 'scratch-unchanged')),
    ).toEqual([{ retained: true }])
  })
})
