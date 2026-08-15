// RFC-304 T12b — a real `code-round` task running a real stage sequence,
// including an AI stage with both retry levels and daemon-restart recovery.
//
// This is the test PR-0 explicitly could NOT be: PR-0 answered "can a round be
// a task", with an empty-stage stub, and said so in its own comments. Here the
// round runs its capability's contract through the stage engine, an AI stage
// goes through the determinism guard, and every call lands in `code_ai_attempts`.
//
// What each part is guarding:
//   - the whole chain, so a break anywhere between `startCodeRoundTask` and a
//     stage row is caught by one test rather than by five green unit suites;
//   - "unregistered stage fails the round", because a stage that silently did
//     nothing is the exact failure this RFC exists to prevent — and it is the
//     current state of every capability until its own PR lands;
//   - recovery, because the interesting crash is between claiming an attempt
//     and writing its verdict, and that window only exists in the real path.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { tasks } from '../src/db/schema'
import { startCodeRoundTask } from '../src/services/codeRoundLaunch'
import { createCodeCapabilityRunner } from '../src/modules/code-capability/composition/codeCapabilityRunner'
import { readRoundStages } from '../src/modules/code-capability/application/stageEngine'
import {
  runGuardedAiStage,
  type AiCaller,
} from '../src/modules/code-capability/application/determinismGuard'
import {
  createSqliteAttemptRecorder,
  readRoundAttempts,
  settleDanglingAttempts,
} from '../src/modules/code-capability/infrastructure/sqliteAttemptRecorder'
import type { StageContract } from '../src/modules/code-capability/domain/stageContract'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NONCE = 'e2enonce'
const FindingsSchema = z.object({ findings: z.array(z.string()) })
const envelopeOf = (body: string): string =>
  `<workflow-output nonce="${NONCE}"><port name="findings">${body}</port></workflow-output>`

/** A contract with one program stage feeding one AI stage — the shape every capability has. */
const AI_CONTRACT: StageContract = {
  capability: 'mr-review',
  version: 1,
  stages: [
    { kind: 'program', name: 'fetch-diff', requires: [], produces: ['diff'] },
    {
      kind: 'ai',
      name: 'review',
      requires: ['diff'],
      produces: ['findings'],
      aiSchema: FindingsSchema,
      agentSlot: 'reviewer',
    },
    { kind: 'program', name: 'ledger', requires: ['findings'], produces: [] },
  ],
}

describe('RFC-304 T12b — code-round runs a real stage sequence', () => {
  let db: DbClient
  let appHome: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc304-e2e-'))
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const launch = async () =>
    await startCodeRoundTask(
      {
        roundId: ulid(),
        capability: 'mr-review',
        roundSeq: 1,
        name: 'MR review round 1',
        scratch: true,
      },
      {
        db,
        appHome,
        launchProvenance: { kind: 'direct-json', initiator: 'api' },
      } as never,
    )

  test('a launched round reaches a terminal status through the real path', async () => {
    // The default runner has no registered program stages yet (each capability
    // registers its own in its PR), so this round FAILS — and that is the
    // point: an unimplemented stage must fail loudly, not settle `done` having
    // done nothing.
    const task = await launch()
    const settled = await waitForTerminal(db, task.id)
    expect(['failed', 'done']).toContain(settled)
    expect(settled).toBe('failed')

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id))
    // Repo convention: errorSummary is the human line, errorMessage carries the
    // machine code. Both matter here — the code lets an operator group these,
    // the summary names the stage so "why did my round fail" is answerable
    // without reading the scheduler.
    expect(row?.errorMessage).toBe('code-round-stage-failed')
    // The built-in minimal contract's first stage. The message says both WHICH
    // stage and WHY — "no registered implementation" is a different problem
    // from "the stage ran and threw", and they need different fixes.
    expect(row?.errorSummary ?? '').toContain('prepare-worktree')
    expect(row?.errorSummary ?? '').toContain('no registered implementation')
  })

  test('with stages registered, the whole sequence runs and every stage lands a row', async () => {
    const roundId = ulid()
    const log: string[] = []
    const runner = createCodeCapabilityRunner({
      db,
      lookupContract: () => AI_CONTRACT,
      programStages: {
        'fetch-diff': async () => {
          log.push('fetch-diff')
          return { status: 'done', produced: { diff: 'diff --git a/x b/x' } }
        },
        ledger: async (ctx) => {
          log.push('ledger')
          // Proves the AI stage's validated output actually threads forward.
          expect(ctx.artifacts.findings).toEqual(['unchecked error'])
          return { status: 'done' }
        },
      },
      aiStages: {
        review: async (ctx) => {
          log.push('review')
          const out = await runGuardedAiStage({
            caller: async (input) => ({
              stdout: envelopeOf('{"findings":["unchecked error"]}'),
              sessionId: input.sessionId ?? 's1',
            }),
            schema: FindingsSchema,
            nonce: NONCE,
            portName: 'findings',
            budget: { sameSession: 2, freshSession: 1 },
            recorder: createSqliteAttemptRecorder(db, {
              roundId: ctx.roundId,
              stageName: ctx.stage.name,
              shardKey: '',
            }),
          })
          if (out.status !== 'ok') return { status: 'failed', error: out.status }
          return { status: 'done', produced: { findings: out.value.findings } }
        },
      },
    })

    const result = await runner.runRound({
      roundId,
      capability: 'mr-review',
      roundSeq: 1,
      worktreePath: appHome,
      repos: [{ name: 'main', path: appHome }],
      envelopeNonce: NONCE,
      resumeFromStage: null,
    })

    expect(result.outcome).toBe('done')
    expect(log).toEqual(['fetch-diff', 'review', 'ledger'])

    const stages = await readRoundStages(db, roundId)
    expect(stages.map((s) => [s.stageName, s.stageKind, s.status])).toEqual([
      ['fetch-diff', 'program', 'done'],
      ['review', 'ai', 'done'],
      ['ledger', 'program', 'done'],
    ])

    // One row per AI call — the third level of the state view.
    const attempts = await readRoundAttempts(db, roundId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('validated')
  })

  test('an AI stage that needs both retry levels still produces a determinised value', async () => {
    const roundId = ulid()
    let calls = 0
    const caller: AiCaller = async (input) => {
      calls++
      // Malformed twice in the first session, then correct in the second.
      return {
        stdout: calls <= 2 ? 'here are the problems I found' : envelopeOf('{"findings":[]}'),
        sessionId: input.sessionId ?? `s${calls}`,
      }
    }

    const runner = createCodeCapabilityRunner({
      db,
      lookupContract: () => AI_CONTRACT,
      programStages: {
        'fetch-diff': async () => ({ status: 'done', produced: { diff: 'd' } }),
        ledger: async () => ({ status: 'done' }),
      },
      aiStages: {
        review: async (ctx) => {
          const out = await runGuardedAiStage({
            caller,
            schema: FindingsSchema,
            nonce: NONCE,
            portName: 'findings',
            budget: { sameSession: 1, freshSession: 1 },
            recorder: createSqliteAttemptRecorder(db, {
              roundId: ctx.roundId,
              stageName: ctx.stage.name,
              shardKey: '',
            }),
          })
          return out.status === 'ok'
            ? { status: 'done', produced: { findings: out.value.findings } }
            : { status: 'failed', error: out.status }
        },
      },
    })

    const result = await runner.runRound({
      roundId,
      capability: 'mr-review',
      roundSeq: 1,
      worktreePath: appHome,
      repos: [],
      envelopeNonce: NONCE,
      resumeFromStage: null,
    })

    expect(result.outcome).toBe('done')
    // The full trail: two failures in session 1, success in session 2.
    const attempts = await readRoundAttempts(db, roundId)
    expect(attempts.map((a) => [a.rerunSeq, a.attemptSeq, a.status])).toEqual([
      [0, 0, 'failed'],
      [0, 1, 'failed'],
      [1, 0, 'validated'],
    ])
  })

  test('an AI stage whose retries are exhausted fails the ROUND, not just the call', async () => {
    // R5 at the sequence level: an unvalidated value must never reach `ledger`.
    const roundId = ulid()
    let ledgerRan = false
    const runner = createCodeCapabilityRunner({
      db,
      lookupContract: () => AI_CONTRACT,
      programStages: {
        'fetch-diff': async () => ({ status: 'done', produced: { diff: 'd' } }),
        ledger: async () => {
          ledgerRan = true
          return { status: 'done' }
        },
      },
      aiStages: {
        review: async (ctx) => {
          const out = await runGuardedAiStage({
            caller: async (input) => ({ stdout: 'never valid', sessionId: input.sessionId ?? 's' }),
            schema: FindingsSchema,
            nonce: NONCE,
            portName: 'findings',
            budget: { sameSession: 1, freshSession: 0 },
            recorder: createSqliteAttemptRecorder(db, {
              roundId: ctx.roundId,
              stageName: ctx.stage.name,
              shardKey: '',
            }),
          })
          return out.status === 'ok'
            ? { status: 'done', produced: { findings: out.value.findings } }
            : {
                status: 'failed',
                error: `determinism guard exhausted after ${out.totalCalls} calls`,
              }
        },
      },
    })

    const result = await runner.runRound({
      roundId,
      capability: 'mr-review',
      roundSeq: 1,
      worktreePath: appHome,
      repos: [],
      envelopeNonce: NONCE,
      resumeFromStage: null,
    })

    expect(result.outcome).toBe('failed')
    expect(result.outcome === 'failed' && result.failedStage).toBe('review')
    expect(ledgerRan).toBe(false)
    const stages = await readRoundStages(db, roundId)
    expect(stages.find((s) => s.stageName === 'ledger')).toBeUndefined()
  })

  test('after a daemon restart, the round resumes without colliding on attempt seq', async () => {
    // The real recovery path: a crash between claim and settle, then the sweep,
    // then a retry that must not hit the unique index.
    const roundId = ulid()
    const recorder = createSqliteAttemptRecorder(db, {
      roundId,
      stageName: 'review',
      shardKey: '',
    })
    await recorder.claim({ rerunSeq: 0, attemptSeq: 0 })
    // …daemon dies.

    expect(await settleDanglingAttempts(db, roundId)).toBe(1)

    const runner = createCodeCapabilityRunner({
      db,
      lookupContract: () => AI_CONTRACT,
      programStages: {
        'fetch-diff': async () => ({ status: 'done', produced: { diff: 'd' } }),
        ledger: async () => ({ status: 'done' }),
      },
      aiStages: {
        review: async (ctx) => {
          const out = await runGuardedAiStage({
            caller: async (input) => ({
              stdout: envelopeOf('{"findings":[]}'),
              sessionId: input.sessionId ?? 's2',
            }),
            schema: FindingsSchema,
            nonce: NONCE,
            portName: 'findings',
            budget: { sameSession: 1, freshSession: 0 },
            recorder: createSqliteAttemptRecorder(db, {
              roundId: ctx.roundId,
              stageName: ctx.stage.name,
              shardKey: '',
            }),
          })
          return out.status === 'ok'
            ? { status: 'done', produced: { findings: out.value.findings } }
            : { status: 'failed', error: out.status }
        },
      },
    })

    const result = await runner.runRound({
      roundId,
      capability: 'mr-review',
      roundSeq: 1,
      worktreePath: appHome,
      repos: [],
      envelopeNonce: NONCE,
      resumeFromStage: null,
    })

    expect(result.outcome).toBe('done')
    const attempts = await readRoundAttempts(db, roundId)
    // The interrupted row is preserved and the retry sits above it — the
    // history of the crash survives instead of being overwritten.
    expect(attempts.map((a) => [a.attemptSeq, a.status])).toEqual([
      [0, 'interrupted'],
      [1, 'validated'],
    ])
  })

  test('a capability with no registered contract is reported as a configuration fault', async () => {
    const runner = createCodeCapabilityRunner({ db, lookupContract: () => undefined })
    const result = await runner.runRound({
      roundId: ulid(),
      capability: 'ci-fix',
      roundSeq: 1,
      worktreePath: appHome,
      repos: [],
      envelopeNonce: NONCE,
      resumeFromStage: null,
    })
    // Distinct from a stage failure: the binding is wrong, and saying so beats
    // failing at whatever stage happens to be first.
    expect(result.outcome).toBe('unknown-capability')
  })
})

/** Poll the task row until it settles. The scheduler drives it fire-and-forget. */
async function waitForTerminal(db: DbClient, taskId: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const terminal = new Set(['done', 'failed', 'canceled', 'interrupted'])
  for (;;) {
    const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))
    const status = row?.status ?? 'missing'
    if (terminal.has(status)) return status
    if (Date.now() > deadline) return `timeout:${status}`
    await new Promise((r) => setTimeout(r, 25))
  }
}
