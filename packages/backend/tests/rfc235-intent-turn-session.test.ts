import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import { intentSessions, intentTurnEvents, intentTurns } from '../src/db/schema'
import {
  INTENT_TURN_EVENT_BYTE_LIMIT,
  IntentTurnSessionEventSink,
  getIntentTurnSession,
} from '../src/services/intent/turnSession'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedAgentTurn(id: string) {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(intentSessions)
    .values({
      id: 'session-1',
      ownerUserId: 'owner-1',
      title: 'goal',
      status: 'active',
      contextRevision: 0,
      contextManifestJson: '[]',
      turnSeq: 1,
      commitSeq: 0,
      budgetJson: '{}',
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  db.insert(intentTurns)
    .values({
      id,
      sessionId: 'session-1',
      seq: 1,
      role: 'agent',
      kind: 'running',
      contentJson: '{}',
      contextRevision: 0,
      captureState: 'live',
      createdAt: 1,
    })
    .run()
  return db
}

describe('RFC-235 Intent turn Session capture', () => {
  test('persists ordered runtime rows and projects them through the shared SessionTree', async () => {
    const db = seedAgentTurn('turn-1')
    const observed: number[] = []
    const sink = new IntentTurnSessionEventSink(db, 'turn-1', (seq) => observed.push(seq))
    await sink.setRootSessionId('runtime-root')
    await sink.append({
      ts: 2,
      kind: 'text',
      payload: JSON.stringify({
        type: 'text',
        sessionID: 'runtime-root',
        messageID: 'message-1',
        part: { type: 'text', text: 'I am building the draft.' },
      }),
      sessionId: 'runtime-root',
      parentSessionId: null,
      source: 'stream',
      externalEventId: 'part-1',
    })
    // Exact source/external id replay is idempotent.
    await sink.append({
      ts: 3,
      kind: 'text',
      payload: '{}',
      sessionId: 'runtime-root',
      parentSessionId: null,
      source: 'stream',
      externalEventId: 'part-1',
    })
    await sink.markTerminal('complete')

    const response = await getIntentTurnSession(db, 'session-1', 'turn-1')
    expect(response.tree.sessionId).toBe('runtime-root')
    expect(response.tree.captureComplete).toBe(true)
    expect(response.tree.messages).toEqual([
      expect.objectContaining({
        kind: 'assistant-text',
        text: 'I am building the draft.',
      }),
    ])
    expect(db.select().from(intentTurnEvents).all()).toHaveLength(1)
    expect(observed.at(-1)).toBe(1)
  })

  test('byte cap marks capture truncated without changing the owning turn kind', async () => {
    const db = seedAgentTurn('turn-cap')
    db.update(intentTurns)
      .set({ captureEventBytes: INTENT_TURN_EVENT_BYTE_LIMIT - 1 })
      .where(eq(intentTurns.id, 'turn-cap'))
      .run()
    const sink = new IntentTurnSessionEventSink(db, 'turn-cap')
    await sink.append({
      ts: 2,
      kind: 'text',
      payload: 'too large',
      sessionId: null,
      parentSessionId: null,
      source: 'stream',
    })

    const row = db
      .select({
        kind: intentTurns.kind,
        captureState: intentTurns.captureState,
        lastEventSeq: intentTurns.captureLastEventSeq,
      })
      .from(intentTurns)
      .where(eq(intentTurns.id, 'turn-cap'))
      .get()
    expect(row).toEqual({ kind: 'running', captureState: 'truncated', lastEventSeq: 0 })
    expect(db.select().from(intentTurnEvents).all()).toEqual([])
    const response = await getIntentTurnSession(db, 'session-1', 'turn-cap')
    expect(response.tree.captureComplete).toBe(false)

    // The sink remembers the cap locally: later observations do not even open
    // another transaction against the now-gone turn.
    db.delete(intentTurns).where(eq(intentTurns.id, 'turn-cap')).run()
    await sink.append({
      ts: 3,
      kind: 'text',
      payload: 'ignored after cap',
      sessionId: null,
      parentSessionId: null,
      source: 'stream',
    })
  })
})
