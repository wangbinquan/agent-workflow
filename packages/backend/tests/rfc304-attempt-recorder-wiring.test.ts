// RFC-304 — the AI attempt ledger, actually connected.
//
// `sqliteAttemptRecorder` and its tests shipped with PR-1b; nothing in `src`
// called it, so every retry and every fresh-session re-run left no trace. That
// is the failure mode this RFC keeps producing: both halves correct, no join,
// and no test anywhere goes red because an absent mechanism never errors.
//
// What the rows are FOR: a round that was retried three times and one that
// succeeded first try look identical without them — same outcome, same
// comments, four model calls versus one. The attempt rows are the only place
// that difference is recorded, so "why did this MR cost four calls" is
// answerable at all.
//
// The recovery ordering is the other half. Attempts left `claimed` by a daemon
// that died mid-call must be settled BEFORE the round runs again; doing it
// afterwards would settle the attempts the new run just made, and a restart
// would read as a round that never called a model.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createSqliteAttemptRecorder,
  readRoundAttempts,
  settleDanglingAttempts,
} from '../src/modules/code-capability/infrastructure/sqliteAttemptRecorder'
import { runGuardedAiStage } from '../src/modules/code-capability/application/determinismGuard'
import { ReviewEnvelopeSchema } from '../src/modules/code-capability/domain/reviewEnvelope'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NONCE = 'attemptnonce'

const envelope = (body: string) =>
  `<workflow-output nonce="${NONCE}"><port name="findings">${body}</port></workflow-output>`

const GOOD = envelope(
  JSON.stringify({
    findings: [
      {
        file: 'src/a.ts',
        line: 11,
        severity: 'major',
        title: 'unchecked index',
        body: 'This can be undefined.',
      },
    ],
  }),
)

describe('RFC-304 — every AI call lands a row', () => {
  let db: DbClient
  let roundId: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    roundId = ulid()
  })
  afterEach(() => db.$client.close())

  const recorder = () =>
    createSqliteAttemptRecorder(db, { roundId, stageName: 'review', shardKey: '' })

  test('a first-try success records ONE validated attempt', async () => {
    const outcome = await runGuardedAiStage({
      caller: async () => ({ stdout: GOOD, sessionId: 's1' }),
      schema: ReviewEnvelopeSchema,
      nonce: NONCE,
      portName: 'findings',
      budget: { sameSession: 2, freshSession: 1 },
      recorder: recorder(),
    })
    expect(outcome.status).toBe('ok')

    const rows = await readRoundAttempts(db, roundId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('validated')
  })

  test('a retried round records EVERY call, not just the one that worked', async () => {
    // The whole point. Without these rows a three-call round is
    // indistinguishable from a one-call round: same comments, same outcome,
    // three times the spend.
    let call = 0
    const outcome = await runGuardedAiStage({
      caller: async () => {
        call += 1
        return { stdout: call < 3 ? envelope('not json') : GOOD, sessionId: `s${call}` }
      },
      schema: ReviewEnvelopeSchema,
      nonce: NONCE,
      portName: 'findings',
      budget: { sameSession: 3, freshSession: 0 },
      recorder: recorder(),
    })
    expect(outcome.status).toBe('ok')

    const rows = await readRoundAttempts(db, roundId)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'validated'])
  })

  test('a failed attempt records WHY it was rejected', async () => {
    // "It was retried" is not actionable; "the model kept returning
    // unparsable JSON" is. The rejection code is what makes a pattern visible
    // across rounds.
    await runGuardedAiStage({
      caller: async () => ({ stdout: envelope('not json'), sessionId: 's1' }),
      schema: ReviewEnvelopeSchema,
      nonce: NONCE,
      portName: 'findings',
      budget: { sameSession: 0, freshSession: 0 },
      recorder: recorder(),
    })
    const rows = await readRoundAttempts(db, roundId)
    expect(rows[0]?.status).toBe('failed')
    expect(String(rows[0]?.validationOutcome ?? '')).toContain('json-unparsable')
  })

  test('an exhausted stage still leaves the full record behind', async () => {
    // The round produced nothing publishable (constitution R5) — but what it
    // spent, and what the model kept doing wrong, has to survive.
    const outcome = await runGuardedAiStage({
      caller: async () => ({ stdout: 'no envelope at all', sessionId: 's1' }),
      schema: ReviewEnvelopeSchema,
      nonce: NONCE,
      portName: 'findings',
      budget: { sameSession: 1, freshSession: 1 },
      recorder: recorder(),
    })
    expect(outcome.status).toBe('exhausted')
    const rows = await readRoundAttempts(db, roundId)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.every((r) => r.status === 'failed')).toBe(true)
  })

  test('the session id is recorded, so a same-session retry is traceable', async () => {
    await runGuardedAiStage({
      caller: async (input) => ({
        stdout: GOOD,
        sessionId: input.sessionId ?? 'fresh-session',
      }),
      schema: ReviewEnvelopeSchema,
      nonce: NONCE,
      portName: 'findings',
      budget: { sameSession: 1, freshSession: 0 },
      recorder: recorder(),
    })
    const rows = await readRoundAttempts(db, roundId)
    expect(rows[0]?.sessionRef).toBe('fresh-session')
  })
})

describe('RFC-304 — a daemon that died mid-call', () => {
  let db: DbClient
  let roundId: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    roundId = ulid()
  })
  afterEach(() => db.$client.close())

  test('a claimed-but-unsettled attempt is recovered, and counted', async () => {
    // The interesting crash is between claiming an attempt and writing its
    // verdict. "recovered 0" and "recovered 1" are very different mornings.
    const rec = createSqliteAttemptRecorder(db, { roundId, stageName: 'review', shardKey: '' })
    await rec.claim({ rerunSeq: 0, attemptSeq: 0 })

    expect(await settleDanglingAttempts(db, roundId)).toBe(1)
    const rows = await readRoundAttempts(db, roundId)
    expect(rows[0]?.status).not.toBe('claimed')
  })

  test('recovery is idempotent — a second restart settles nothing', async () => {
    const rec = createSqliteAttemptRecorder(db, { roundId, stageName: 'review', shardKey: '' })
    await rec.claim({ rerunSeq: 0, attemptSeq: 0 })
    await settleDanglingAttempts(db, roundId)
    expect(await settleDanglingAttempts(db, roundId)).toBe(0)
  })

  test('recovery leaves another round’s in-flight attempt alone', async () => {
    // Rounds run concurrently. Settling by round id rather than globally is
    // what keeps one round's restart from marking a live call as interrupted.
    const other = ulid()
    await createSqliteAttemptRecorder(db, {
      roundId: other,
      stageName: 'review',
      shardKey: '',
    }).claim({ rerunSeq: 0, attemptSeq: 0 })

    expect(await settleDanglingAttempts(db, roundId)).toBe(0)
    const rows = await readRoundAttempts(db, other)
    // Still in flight — `claim` opens a row as 'running', and recovery marks
    // an abandoned one 'interrupted'. Asserting the exact word matters here:
    // "not interrupted" would also pass if the row had been settled 'failed'.
    expect(rows[0]?.status).toBe('running')
  })

  test('attempts after a restart do not collide with the interrupted ones', async () => {
    // The guard restarts its own numbering at 0 each session; the stored seq is
    // lifted above the existing max instead. Two rows sharing a seq would make
    // the record ambiguous exactly where it is being relied on.
    const rec = createSqliteAttemptRecorder(db, { roundId, stageName: 'review', shardKey: '' })
    await rec.claim({ rerunSeq: 0, attemptSeq: 0 })
    await settleDanglingAttempts(db, roundId)

    await runGuardedAiStage({
      caller: async () => ({ stdout: GOOD, sessionId: 's2' }),
      schema: ReviewEnvelopeSchema,
      nonce: NONCE,
      portName: 'findings',
      budget: { sameSession: 0, freshSession: 0 },
      recorder: createSqliteAttemptRecorder(db, {
        roundId,
        stageName: 'review',
        shardKey: '',
      }),
    })

    const rows = await readRoundAttempts(db, roundId)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.attemptSeq)).size).toBe(2)
  })
})
