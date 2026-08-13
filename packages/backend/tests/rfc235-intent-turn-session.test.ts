import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import { intentSessions, intentTurnEvents, intentTurns } from '../src/db/schema'
import {
  INTENT_TURN_EVENT_BYTE_LIMIT,
  IntentTurnSessionEventSink,
  getIntentTurnSession,
  projectIntentTurnExecution,
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

  test('conversation reset replaces the captured root without marking evidence incomplete', async () => {
    const db = seedAgentTurn('turn-reset')
    const sink = new IntentTurnSessionEventSink(db, 'turn-reset')

    await sink.setRootSessionId('runtime-before-reset')
    await sink.append({
      ts: 1,
      kind: 'text',
      payload: JSON.stringify({
        type: 'assistant',
        session_id: 'runtime-before-reset',
        message: { content: [{ type: 'text', text: 'before reset' }] },
      }),
      sessionId: 'runtime-before-reset',
      parentSessionId: null,
      source: 'stream',
    })
    await sink.append({
      ts: 1,
      kind: 'text',
      payload: JSON.stringify({ type: 'assistant', message: { content: [] } }),
      sessionId: 'runtime-child-before-reset',
      parentSessionId: 'runtime-before-reset',
      source: 'post-run-child',
    })
    await sink.markRootSessionResetPending('runtime-before-reset')
    await sink.setRootSessionId('runtime-after-reset', 'runtime-before-reset')
    await sink.append({
      ts: 2,
      kind: 'text',
      payload: JSON.stringify({
        type: 'assistant',
        session_id: 'runtime-after-reset',
        message: { content: [{ type: 'text', text: 'after reset' }] },
      }),
      sessionId: 'runtime-after-reset',
      parentSessionId: null,
      source: 'stream',
    })
    await sink.markTerminal('complete')

    const row = db
      .select({
        root: intentTurns.captureRootSessionId,
        state: intentTurns.captureState,
      })
      .from(intentTurns)
      .where(eq(intentTurns.id, 'turn-reset'))
      .get()
    expect(row).toEqual({ root: 'runtime-after-reset', state: 'complete' })
    const response = await getIntentTurnSession(db, 'session-1', 'turn-reset')
    expect(response.tree.sessionId).toBe('runtime-after-reset')
    expect(response.tree.captureComplete).toBe(true)
    expect(JSON.stringify(response.tree)).toContain('before reset')
    expect(db.select({ id: intentTurnEvents.sessionId }).from(intentTurnEvents).all()).toEqual([
      { id: 'runtime-after-reset' },
      { id: 'runtime-child-before-reset' },
      { id: 'runtime-after-reset' },
    ])
    expect(
      db
        .select({ parent: intentTurnEvents.parentSessionId })
        .from(intentTurnEvents)
        .where(eq(intentTurnEvents.sessionId, 'runtime-child-before-reset'))
        .get(),
    ).toEqual({ parent: 'runtime-after-reset' })
  })

  test('a reset cannot repaint a capture that was already truncated', async () => {
    const db = seedAgentTurn('turn-reset-after-cap')
    const sink = new IntentTurnSessionEventSink(db, 'turn-reset-after-cap')
    await sink.setRootSessionId('runtime-cap-old')
    db.update(intentTurns)
      .set({ captureState: 'truncated' })
      .where(eq(intentTurns.id, 'turn-reset-after-cap'))
      .run()

    await sink.markRootSessionResetPending('runtime-cap-old')
    await sink.setRootSessionId('runtime-cap-new', 'runtime-cap-old')
    await sink.markTerminal('complete')

    expect(
      db
        .select({ root: intentTurns.captureRootSessionId, state: intentTurns.captureState })
        .from(intentTurns)
        .where(eq(intentTurns.id, 'turn-reset-after-cap'))
        .get(),
    ).toEqual({ root: 'runtime-cap-new', state: 'truncated' })
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

    // A generic successful terminal call cannot repaint the cap, but a later
    // observed lifecycle/persistence failure is stronger and keeps its reason.
    await sink.markTerminal('complete')
    expect(
      db
        .select({ captureState: intentTurns.captureState })
        .from(intentTurns)
        .where(eq(intentTurns.id, 'turn-cap'))
        .get(),
    ).toEqual({ captureState: 'truncated' })
    await sink.markTerminal('incomplete', 'post-exit-flush-timeout')
    expect(
      db
        .select({
          captureState: intentTurns.captureState,
          reason: intentTurns.captureIncompleteReason,
        })
        .from(intentTurns)
        .where(eq(intentTurns.id, 'turn-cap'))
        .get(),
    ).toEqual({
      captureState: 'incomplete',
      reason: 'post-exit-flush-timeout',
    })

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

  test('terminal business turn derives an unresolved live capture as incomplete', async () => {
    const db = seedAgentTurn('turn-terminal-live')
    db.update(intentTurns)
      .set({
        kind: 'changeset',
        contentJson: JSON.stringify({ summary: 'done', opCount: 1 }),
      })
      .where(eq(intentTurns.id, 'turn-terminal-live'))
      .run()

    const turn = db.select().from(intentTurns).where(eq(intentTurns.id, 'turn-terminal-live')).get()
    expect(turn).toBeDefined()
    expect(projectIntentTurnExecution(turn!)).toEqual({
      captureState: 'incomplete',
      lastEventSeq: 0,
      eventBytes: 0,
      rootSessionId: null,
      incompleteReason: 'stream-persist-failed',
    })
    const response = await getIntentTurnSession(db, 'session-1', 'turn-terminal-live')
    expect(response.tree.captureComplete).toBe(false)
  })
})
