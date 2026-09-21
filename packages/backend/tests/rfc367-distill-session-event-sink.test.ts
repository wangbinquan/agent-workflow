// RFC-367 T5 — the live distill event sink.
//
// It replaces the RFC-043 post-run opencode SQLite walk. The invariant it must
// hold is the one the old split violated twice (RFC-117, then again on
// 2026-09-21): what the session tab shows and what the candidate parser read
// come from ONE normalized event stream.
//
// The two tricky bits, both locked below:
//  1. `memory_distill_events.session_id` is NOT NULL, but the first events can
//     arrive before the runtime announces a session id — they are buffered and
//     flushed with the root id once it is known.
//  2. A run that never yields a session id must still leave a capture-failed
//     marker row, otherwise AC-9's failure has no trace on the detail page at
//     all (getJobSessionView derives the whole attempt from these rows).

import { beforeEach, expect, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { memoryDistillEvents, memoryDistillJobs } from '../src/db/schema'
import { createMemoryDistillSessionEventSink } from '../src/modules/memory/infrastructure/memoryDistillSessionEventSink'
import { DISTILL_CAPTURE_FAILED_KIND } from '../src/modules/runtime-management/public/types'
import { composeMemoryDistillQueries } from '../src/modules/memory/composition'
import { describeEachProvider } from './helpers/eachProvider'

async function seedJob(db: ProviderNeutralDatabase): Promise<string> {
  const id = ulid()
  await db.insert(memoryDistillJobs).values({
    id,
    debounceKey: 'task-x:feedback',
    sourceKind: 'feedback',
    sourceEventId: 'src-1',
    taskId: null,
    scopeResolvedJson: JSON.stringify({
      agentIds: [],
      workflowId: null,
      repoId: null,
      includeGlobal: true,
    }),
    status: 'running',
    attempts: 0,
    nextRunAt: Date.now(),
    createdAt: Date.now(),
  })
  return id
}

const textEvent = (ts: number, payload: string, sessionId: string | null = null) => ({
  ts,
  kind: 'text' as const,
  payload,
  sessionId,
  parentSessionId: null,
  source: 'stream' as const,
})

describeEachProvider('RFC-367 distill session event sink', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    db = harness.db
  })

  const rowsFor = async (jobId: string) =>
    await db
      .select()
      .from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, jobId))
      .orderBy(asc(memoryDistillEvents.id))

  test('events seen before the session id is known are buffered, then flushed with it', async () => {
    const jobId = await seedJob(db)
    const sink = createMemoryDistillSessionEventSink(db)({ distillJobId: jobId, attemptIndex: 0 })

    await sink.append(textEvent(1, 'before-id-a'))
    await sink.append(textEvent(2, 'before-id-b'))
    expect(await rowsFor(jobId)).toHaveLength(0)

    await sink.setRootSessionId('ses_root')
    await sink.append(textEvent(3, 'after-id'))
    await sink.markTerminal('complete')

    const rows = await rowsFor(jobId)
    expect(rows.map((r) => r.payload)).toEqual(['before-id-a', 'before-id-b', 'after-id'])
    expect(rows.every((r) => r.sessionId === 'ses_root')).toBe(true)
    expect(rows.every((r) => r.attemptIndex === 0)).toBe(true)
  })

  test('an event carrying its own session id keeps it', async () => {
    const jobId = await seedJob(db)
    const sink = createMemoryDistillSessionEventSink(db)({ distillJobId: jobId, attemptIndex: 2 })
    await sink.setRootSessionId('ses_root')
    await sink.append(textEvent(1, 'child', 'ses_child'))
    const rows = await rowsFor(jobId)
    expect(rows[0]!.sessionId).toBe('ses_child')
    expect(rows[0]!.attemptIndex).toBe(2)
  })

  test('a run that never yields a session id still leaves a capture-failed marker', async () => {
    const jobId = await seedJob(db)
    const sink = createMemoryDistillSessionEventSink(db)({ distillJobId: jobId, attemptIndex: 0 })
    await sink.append(textEvent(1, 'orphan-line'))
    await sink.markTerminal('incomplete', 'stream-persist-failed')

    const rows = await rowsFor(jobId)
    // The buffered line is not thrown away, and the marker exists — without it
    // getJobSessionView would render no attempt at all.
    expect(rows.map((r) => r.kind)).toEqual(['text', DISTILL_CAPTURE_FAILED_KIND])
    expect(rows.every((r) => r.sessionId === '(unknown)')).toBe(true)
    expect(JSON.parse(rows[1]!.payload)).toMatchObject({ reason: 'stream-persist-failed' })
  })

  test('a complete run writes no marker row', async () => {
    const jobId = await seedJob(db)
    const sink = createMemoryDistillSessionEventSink(db)({ distillJobId: jobId, attemptIndex: 0 })
    await sink.setRootSessionId('ses_root')
    await sink.append(textEvent(1, 'only'))
    await sink.markTerminal('complete')
    const rows = await rowsFor(jobId)
    expect(rows.map((r) => r.kind)).toEqual(['text'])
  })

  test('appends after the terminal marker are ignored', async () => {
    const jobId = await seedJob(db)
    const sink = createMemoryDistillSessionEventSink(db)({ distillJobId: jobId, attemptIndex: 0 })
    await sink.setRootSessionId('ses_root')
    await sink.markTerminal('complete')
    await sink.append(textEvent(9, 'late'))
    expect(await rowsFor(jobId)).toHaveLength(0)
  })

  test('concurrent appends land in call order (the session tree depends on it)', async () => {
    const jobId = await seedJob(db)
    const sink = createMemoryDistillSessionEventSink(db)({ distillJobId: jobId, attemptIndex: 0 })
    await sink.setRootSessionId('ses_root')
    await Promise.all([
      sink.append(textEvent(1, 'one')),
      sink.append(textEvent(2, 'two')),
      sink.append(textEvent(3, 'three')),
    ])
    const rows = await rowsFor(jobId)
    expect(rows.map((r) => r.payload)).toEqual(['one', 'two', 'three'])
  })

  test('a persistence failure never propagates to the caller', async () => {
    // Contract from services/sessionEventSink.ts: the auxiliary record must
    // never decide the agent's business result.
    const jobId = await seedJob(db)
    const brokenDb = {
      insert: () => ({
        values: () => Promise.reject(new Error('disk on fire')),
      }),
    } as unknown as ProviderNeutralDatabase
    const sink = createMemoryDistillSessionEventSink(brokenDb)({
      distillJobId: jobId,
      attemptIndex: 0,
    })
    await sink.setRootSessionId('ses_root')
    await sink.append(textEvent(1, 'doomed'))
    await sink.markTerminal('complete')
    expect(await rowsFor(jobId)).toHaveLength(0)
  })
})

// RFC-367 T8 — the conversation tab keeps its opening user turn.
//
// The retired post-run SQLite walk captured the USER message parts too, so the
// session tree started with what the distiller was asked. The live stream only
// carries the child's stdout, so that turn has to be seeded from the stored
// prompt instead (capability-impact C2). Without this the detail page's
// conversation would open mid-answer with no visible question.
describeEachProvider(
  'RFC-367 session view seeds the user turn from the stored prompt',
  (harness) => {
    let db: ProviderNeutralDatabase
    beforeEach(() => {
      db = harness.db
    })

    test('getJobSessionView renders user_prompt_md as the first turn', async () => {
      const jobId = await seedJob(db)
      await db
        .update(memoryDistillJobs)
        .set({ userPromptMd: '# Source events to distill\nTask: t-1' })
        .where(eq(memoryDistillJobs.id, jobId))

      const sink = createMemoryDistillSessionEventSink(db)({ distillJobId: jobId, attemptIndex: 0 })
      await sink.setRootSessionId('ses_root')
      await sink.append({
        ts: 10,
        kind: 'text',
        payload: JSON.stringify({
          type: 'text',
          sessionID: 'ses_root',
          messageID: 'msg_1',
          part: { id: 'prt_1', type: 'text', text: 'here are the candidates' },
          timestamp: 10,
        }),
        sessionId: 'ses_root',
        parentSessionId: null,
        source: 'stream',
      })
      await sink.markTerminal('complete')

      const view = await composeMemoryDistillQueries(db).getJobSessionView(jobId)
      expect(view.attempts).toHaveLength(1)
      const tree = view.attempts[0]!.tree
      expect(tree).not.toBeNull()
      expect(JSON.stringify(tree)).toContain('# Source events to distill')
    })
  },
)
