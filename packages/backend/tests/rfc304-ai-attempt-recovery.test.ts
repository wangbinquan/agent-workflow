// RFC-304 T2b — AI attempt persistence and crash recovery.
//
// The interesting case is not the happy path, it is a daemon that dies between
// starting an AI call and writing its verdict. Design §3 spells out the fix and
// its ORDER, and both halves are real bugs on their own:
//
//   - settle dangling rows first, or the history keeps rows that look in-flight
//     forever and the recovery sweep cannot tell a crash from a live call;
//   - allocate the next attemptSeq above what already exists, or the first
//     retry after a restart collides with the unique key and the round dies of
//     a constraint error instead of the problem it was retrying.
//
// A test for each, plus the combined path a real restart takes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createSqliteAttemptRecorder,
  readRoundAttempts,
  settleDanglingAttempts,
} from '../src/modules/code-capability/infrastructure/sqliteAttemptRecorder'
import {
  runGuardedAiStage,
  type AiCaller,
} from '../src/modules/code-capability/application/determinismGuard'
import { z } from 'zod'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NONCE = 'attemptnonce'
const PORT = 'findings'
const Schema = z.object({ findings: z.array(z.string()) })
const VALID = `<workflow-output nonce="${NONCE}"><port name="${PORT}">{"findings":[]}</port></workflow-output>`

describe('RFC-304 T2b — attempt rows', () => {
  let db: DbClient
  let roundId: string
  let clock: number

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    roundId = ulid()
    clock = 1_000
  })
  afterEach(() => db.$client.close())

  const recorderFor = (stageName: string, shardKey = '') =>
    createSqliteAttemptRecorder(db, { roundId, stageName, shardKey }, () => ++clock)

  test('a guarded stage leaves one row per call, with its seq pair and verdict', async () => {
    let calls = 0
    const caller: AiCaller = async (input) => {
      calls++
      return { stdout: calls < 3 ? 'garbage' : VALID, sessionId: input.sessionId ?? `s${calls}` }
    }

    await runGuardedAiStage({
      caller,
      schema: Schema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 1, freshSession: 1 },
      recorder: recorderFor('review-shard'),
    })

    const rows = await readRoundAttempts(db, roundId)
    expect(rows.map((r) => [r.rerunSeq, r.attemptSeq, r.status])).toEqual([
      [0, 0, 'failed'],
      [0, 1, 'failed'],
      [1, 0, 'validated'],
    ])
    // The reason is stored, so "why did this stage take three calls" is
    // answerable from the table alone.
    expect(rows[0]?.validationOutcome).toBe('envelope-missing')
    expect(rows[2]?.validationOutcome).toBeNull()
    // And the session each attempt ran in, for cross-referencing a transcript.
    expect(rows[2]?.sessionRef).not.toBeNull()
  })

  test('shards of one stage are recorded independently', async () => {
    // Without shardKey in the key, four parallel calls of `review-shard` would
    // collide on (round, stage, rerun, attempt) and only one would survive.
    for (const shard of ['src/a', 'src/b']) {
      await runGuardedAiStage({
        caller: async (input) => ({ stdout: VALID, sessionId: input.sessionId ?? 's' }),
        schema: Schema,
        nonce: NONCE,
        portName: PORT,
        budget: { sameSession: 0, freshSession: 0 },
        recorder: recorderFor('review-shard', shard),
      })
    }
    const rows = await readRoundAttempts(db, roundId)
    expect(rows.map((r) => r.shardKey)).toEqual(['src/a', 'src/b'])
  })

  test('recovery settles dangling attempts to interrupted, with a stated cause', async () => {
    const recorder = recorderFor('review-shard')
    await recorder.claim({ rerunSeq: 0, attemptSeq: 0 })
    // …daemon dies here, before settle().

    const settled = await settleDanglingAttempts(db, roundId)
    expect(settled).toBe(1)

    const rows = await readRoundAttempts(db, roundId)
    expect(rows[0]?.status).toBe('interrupted')
    // A row that merely says `interrupted` leaves the reader guessing between
    // a crash and a cancel.
    expect(rows[0]?.validationOutcome).toBe('daemon-restart')
  })

  test('recovery does NOT touch attempts that already reached a verdict', async () => {
    const recorder = recorderFor('review-shard')
    const id = await recorder.claim({ rerunSeq: 0, attemptSeq: 0 })
    await recorder.settle({
      attemptId: id,
      status: 'validated',
      validationOutcome: null,
      sessionRef: 's1',
    })

    expect(await settleDanglingAttempts(db, roundId)).toBe(0)
    expect((await readRoundAttempts(db, roundId))[0]?.status).toBe('validated')
  })

  test('after recovery, the retry does not collide with the interrupted row', async () => {
    // The bug this prevents: the guard restarts its loop at (0,0), which is
    // exactly the pair the interrupted row holds. A verbatim insert would fail
    // the unique index, and the round would die of a constraint error rather
    // than of whatever it was retrying.
    const recorder = recorderFor('review-shard')
    await recorder.claim({ rerunSeq: 0, attemptSeq: 0 })
    await settleDanglingAttempts(db, roundId)

    const out = await runGuardedAiStage({
      caller: async (input) => ({ stdout: VALID, sessionId: input.sessionId ?? 's2' }),
      schema: Schema,
      nonce: NONCE,
      portName: PORT,
      budget: { sameSession: 1, freshSession: 0 },
      recorder: recorderFor('review-shard'),
    })

    expect(out.status).toBe('ok')
    const rows = await readRoundAttempts(db, roundId)
    expect(rows.map((r) => [r.attemptSeq, r.status])).toEqual([
      [0, 'interrupted'],
      [1, 'validated'],
    ])
  })

  test('several restarts in a row keep lifting the seq, never reusing one', async () => {
    // Each restart adds an interrupted row; the history has to stay
    // reconstructable across all of them.
    for (let i = 0; i < 3; i++) {
      const recorder = recorderFor('review-shard')
      await recorder.claim({ rerunSeq: 0, attemptSeq: 0 })
      await settleDanglingAttempts(db, roundId)
    }
    const rows = await readRoundAttempts(db, roundId)
    expect(rows.map((r) => r.attemptSeq)).toEqual([0, 1, 2])
    expect(rows.every((r) => r.status === 'interrupted')).toBe(true)
  })

  test('the seq lift is per (stage, shard, rerun), not global to the round', async () => {
    // A global counter would make one shard's crash inflate every other shard's
    // attempt numbers, and "this shard retried twice" would stop being true.
    const a = recorderFor('review-shard', 'src/a')
    await a.claim({ rerunSeq: 0, attemptSeq: 0 })
    await settleDanglingAttempts(db, roundId)

    const b = recorderFor('review-shard', 'src/b')
    await b.claim({ rerunSeq: 0, attemptSeq: 0 })

    const rows = await readRoundAttempts(db, roundId)
    expect(rows.map((r) => [r.shardKey, r.attemptSeq])).toEqual([
      ['src/a', 0],
      ['src/b', 0],
    ])
  })

  test('a fresh rerunSeq starts its own attempt numbering', async () => {
    const recorder = recorderFor('review-shard')
    await recorder.claim({ rerunSeq: 0, attemptSeq: 0 })
    await recorder.claim({ rerunSeq: 0, attemptSeq: 1 })
    await recorder.claim({ rerunSeq: 1, attemptSeq: 0 })

    const rows = await readRoundAttempts(db, roundId)
    expect(rows.map((r) => [r.rerunSeq, r.attemptSeq])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ])
  })
})
