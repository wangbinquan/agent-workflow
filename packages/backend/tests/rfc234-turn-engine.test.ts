// RFC-234 (T5) — turn engine behavior locks:
//  envelope port rules (summary + changeset XOR questions), immutable draft
//  minting + sha256 hash, budget accounting, in-flight single-flight 409,
//  cancel → aborted settle, context-epoch CAS (superseded result NEVER
//  installs a draft — design-gate P0-3), nonce persisted on the turn row
//  (P2-1), boot recovery and scratch GC.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentDrafts, intentSessions, intentTurns, users } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import type { ResolvedRuntime } from '../src/services/runtimeRegistry'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '../src/services/systemAgentRun'
import {
  abortIntentTurn,
  runIntentTurn,
  type IntentTurnConfig,
} from '../src/services/intent/turnEngine'
import { recoverIntentTurnsOnBoot, sweepIntentScratch } from '../src/services/intent/maintenance'
import { createIntentSession, insertUserTurn } from '../src/services/intent/session'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_intent_000000000'

let db: DbClient
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(),
}

const runtime = {
  name: 'opencode',
  protocol: 'opencode',
  binaryPath: null,
  model: 'anthropic/claude-sonnet-5',
} as unknown as ResolvedRuntime

const config = (over: Partial<IntentTurnConfig> = {}): IntentTurnConfig => ({
  runtime,
  lang: null,
  timeoutMs: 30_000,
  stdoutCapBytes: 8 * 1024 * 1024,
  maxGenerateRounds: 50,
  maxQuestionRounds: 5,
  extraInstructions: null,
  ...over,
})

function okResult(eventText: string): SystemAgentRunResult {
  return {
    status: 'ok',
    exitCode: 0,
    eventText,
    stderrTail: '',
    durationMs: 5,
    scratchDir: '/tmp/x',
    scratchRetained: false,
  }
}

function envelope(nonce: string, ports: Record<string, string>): string {
  const body = Object.entries(ports)
    .map(([name, content]) => `<port name="${name}">${content}</port>`)
    .join('')
  return `noise before\n<workflow-output nonce="${nonce}">${body}</workflow-output>`
}

const MINIMAL_CHANGESET = JSON.stringify({
  $schema_version: 1,
  ops: [
    {
      opId: 'op-1',
      action: 'create',
      resourceType: 'agent',
      tempRef: '$new:auditor',
      payload: {
        name: 'auditor',
        description: 'audits',
        outputs: ['findings'],
        bodyMd: 'You audit.',
      },
    },
  ],
})

/** runFn that reads the persisted nonce off its prompt's protocol block. */
function scriptedRun(
  script: (
    opts: SystemAgentRunOptions,
    nonce: string,
  ) => SystemAgentRunResult | Promise<SystemAgentRunResult>,
): (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult> {
  return async (opts) => {
    const nonce = /nonce="([^"]+)"/.exec(opts.prompt)?.[1] ?? ''
    return script(opts, nonce)
  }
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  appHome = mkdtempSync(join(tmpdir(), 'aw-intent-engine-'))
  await db.insert(users).values({
    id: OWNER,
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

describe('runIntentTurn', () => {
  test('happy changeset: immutable draft + hash + budget + nonce persisted', async () => {
    const { session } = await createIntentSession(db, actor, { message: '给我一个审计流水线' })
    const outcome = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((_o, nonce) =>
          okResult(envelope(nonce, { summary: 'built one agent', changeset: MINIMAL_CHANGESET })),
        ),
      },
      { sessionId: session.id, actor },
    )
    expect(outcome.kind).toBe('changeset')
    expect(outcome.draftRevision).toBe(1)

    const fresh = (
      await db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
    )[0]
    expect(fresh?.inFlightTurnId).toBeNull()
    expect(fresh?.currentDraftId).not.toBeNull()
    expect(JSON.parse(fresh?.budgetJson ?? '{}')).toEqual({ generateRounds: 1, questionRounds: 0 })

    const draft = (
      await db.select().from(intentDrafts).where(eq(intentDrafts.sessionId, session.id))
    )[0]
    expect(draft?.revision).toBe(1)
    expect(draft?.draftHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.parse(draft?.validationJson ?? '{}').errors).toEqual([])

    const agentTurn = (
      await db.select().from(intentTurns).where(eq(intentTurns.id, outcome.turnId))
    )[0]
    expect(agentTurn?.kind).toBe('changeset')
    expect(agentTurn?.envelopeNonce).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.parse(agentTurn?.contentJson ?? '{}').summary).toBe('built one agent')
  })

  test('live GLM missing final-op brace is recovered into a schema-valid draft', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'build a workflow' })
    const workflow = JSON.stringify({
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:flow',
          payload: {
            name: 'flow',
            description: '',
            definition: {
              $schema_version: 4,
              inputs: [{ kind: 'text', key: 'goal', label: 'Goal', required: true }],
              nodes: [
                { id: 'input', kind: 'input', inputKey: 'goal' },
                { id: 'agent', kind: 'agent-single', agentRef: 'res#agent#1' },
                { id: 'output', kind: 'output' },
              ],
              edges: [],
            },
          },
        },
      ],
    })
    const malformed = workflow.replace(/}}}]}$/, '}}]}')
    expect(malformed).not.toBe(workflow)

    const outcome = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((_o, nonce) =>
          okResult(envelope(nonce, { summary: 'workflow', changeset: malformed })),
        ),
      },
      { sessionId: session.id, actor },
    )

    expect(outcome.kind).toBe('changeset')
    const draft = (
      await db.select().from(intentDrafts).where(eq(intentDrafts.sessionId, session.id))
    )[0]
    expect(JSON.parse(draft?.changesetJson ?? '{}')).toEqual(JSON.parse(workflow))
    const validationErrors = JSON.parse(draft?.validationJson ?? '{}').errors as string[]
    expect(validationErrors).toEqual([
      'op-1: definition.agentRef[0] references unknown handle res#agent#1 (intent-ref-unknown)',
    ])
    expect(validationErrors.some((error) => error.includes('intent-secret-value-forbidden'))).toBe(
      false,
    )
    const agentTurn = (
      await db.select().from(intentTurns).where(eq(intentTurns.id, outcome.turnId))
    )[0]
    expect(JSON.parse(agentTurn?.contentJson ?? '{}').jsonRepair).toEqual({
      kind: 'missing-final-op-object-close',
      offset: malformed.length - 2,
    })
  })

  test('questions turn + answers reach the next INTENT.md', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'build something' })
    const questions = JSON.stringify([
      {
        id: 'q1',
        question: 'which sharding?',
        options: ['per-file', 'per-dir'],
        multiSelect: false,
      },
    ])
    const first = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((_o, nonce) =>
          okResult(envelope(nonce, { summary: 'need info', questions })),
        ),
      },
      { sessionId: session.id, actor },
    )
    expect(first.kind).toBe('questions')
    expect(
      JSON.parse(
        (await db.select().from(intentSessions).where(eq(intentSessions.id, session.id)))[0]
          ?.budgetJson ?? '{}',
      ).questionRounds,
    ).toBe(1)

    await insertUserTurn(db, actor, session.id, 'answers', {
      answers: [{ id: 'q1', picked: ['per-file'] }],
    })

    let seenDoc = ''
    const second = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((opts, nonce) => {
          seenDoc = opts.seedFiles?.find((f) => f.path === 'INTENT.md')?.content ?? ''
          return okResult(envelope(nonce, { summary: 'ok', changeset: MINIMAL_CHANGESET }))
        }),
      },
      { sessionId: session.id, actor },
    )
    expect(second.kind).toBe('changeset')
    expect(seenDoc).toContain('per-file')
    expect(seenDoc).toContain('Pending questions you asked')
    expect(seenDoc).toContain('which sharding?')
  })

  test('missing envelope / both ports / invalid changeset settle as retryable errors', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const cases: Array<[string, (nonce: string) => string]> = [
      ['intent-envelope-missing', () => 'no envelope here'],
      ['intent-ports-exclusive', (n) => envelope(n, { summary: 's' })],
      [
        'intent-ports-exclusive',
        (n) => envelope(n, { summary: 's', changeset: MINIMAL_CHANGESET, questions: '[]' }),
      ],
      ['intent-changeset-invalid', (n) => envelope(n, { summary: 's', changeset: '{not json' })],
    ]
    for (const [code, make] of cases) {
      const outcome = await runIntentTurn(
        { db, appHome, config: config(), runFn: scriptedRun((_o, nonce) => okResult(make(nonce))) },
        { sessionId: session.id, actor },
      )
      expect(outcome.kind).toBe('error')
      expect(outcome.errorCode).toBe(code)
      const fresh = (
        await db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
      )[0]
      expect(fresh?.inFlightTurnId).toBeNull()
      expect(fresh?.currentDraftId).toBeNull()
    }
    const turns = await db
      .select()
      .from(intentTurns)
      .where(eq(intentTurns.sessionId, session.id))
      .orderBy(intentTurns.seq)
    const malformedJsonContent = JSON.parse(turns.at(-1)?.contentJson ?? '{}') as {
      errors?: string[]
    }
    expect(malformedJsonContent.errors).toContain(
      'hint: verify every JSON object/array delimiter; if the response was truncated, emit fewer or smaller ops this turn',
    )
    expect(malformedJsonContent.errors?.join('\n')).not.toContain('usually means')
  })

  test('unknown handle mints the draft WITH blocking errors (agent-fixable loop)', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const cs = JSON.stringify({
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'update',
          resourceType: 'workflow',
          target: 'res#workflow#9',
          payload: {
            name: 'f',
            description: '',
            definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
          },
        },
      ],
    })
    const outcome = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((_o, nonce) =>
          okResult(envelope(nonce, { summary: 's', changeset: cs })),
        ),
      },
      { sessionId: session.id, actor },
    )
    expect(outcome.kind).toBe('changeset')
    const draft = (
      await db.select().from(intentDrafts).where(eq(intentDrafts.sessionId, session.id))
    )[0]
    const report = JSON.parse(draft?.validationJson ?? '{}') as { errors: string[] }
    expect(report.errors.length).toBeGreaterThan(0)
    expect(report.errors[0]).toContain('unknown target handle')
  })

  test('single-flight: user turns 409 while a generation runs; cancel settles aborted', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    let releaseRun: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releaseRun = r
    })
    const running = runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: async (opts) => {
          await gate
          if (opts.abortSignal?.aborted) {
            return { ...okResult(''), status: 'aborted' }
          }
          return okResult('')
        },
      },
      { sessionId: session.id, actor },
    )
    // Wait until the in-flight slot is visibly taken.
    for (let i = 0; i < 100; i++) {
      const row = (
        await db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
      )[0]
      if (row?.inFlightTurnId !== null) break
      await new Promise((r) => setTimeout(r, 10))
    }
    await expect(
      insertUserTurn(db, actor, session.id, 'message', { message: 'more' }),
    ).rejects.toThrow(/intent-turn-in-flight|generation turn is already running/)
    expect(abortIntentTurn(session.id)).toBe(true)
    releaseRun()
    const outcome = await running
    expect(outcome.kind).toBe('error')
    expect(outcome.errorCode).toBe('intent-run-aborted')
    const fresh = (
      await db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
    )[0]
    expect(fresh?.inFlightTurnId).toBeNull()
  })

  test('context-epoch CAS: a mid-run epoch bump archives the result, no draft installs', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    let releaseRun: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releaseRun = r
    })
    const running = runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun(async (_o, nonce) => {
          await gate
          return okResult(envelope(nonce, { summary: 's', changeset: MINIMAL_CHANGESET }))
        }),
      },
      { sessionId: session.id, actor },
    )
    for (let i = 0; i < 100; i++) {
      const row = (
        await db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
      )[0]
      if (row?.inFlightTurnId !== null) break
      await new Promise((r) => setTimeout(r, 10))
    }
    // Simulate a future epoch mover racing the run.
    await db
      .update(intentSessions)
      .set({ contextRevision: 99 })
      .where(eq(intentSessions.id, session.id))
    releaseRun()
    const outcome = await running
    expect(outcome.kind).toBe('error')
    expect(outcome.errorCode).toBe('intent-context-superseded')
    const drafts = await db
      .select()
      .from(intentDrafts)
      .where(eq(intentDrafts.sessionId, session.id))
    expect(drafts.length).toBe(0)
  })

  test('budget exhaustion is a 409 before any spawn', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const deps = {
      db,
      appHome,
      config: config({ maxGenerateRounds: 1 }),
      runFn: scriptedRun((_o, nonce) =>
        okResult(envelope(nonce, { summary: 's', changeset: MINIMAL_CHANGESET })),
      ),
    }
    await runIntentTurn(deps, { sessionId: session.id, actor })
    await expect(runIntentTurn(deps, { sessionId: session.id, actor })).rejects.toThrow(
      /intent-budget-exhausted|generation budget/,
    )
  })

  test('a failed incomplete write cannot be repainted complete by the outer retry', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const originalTransaction = db.transaction.bind(db)
    const outcome = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun(async (opts, nonce) => {
          let failOnce = true
          db.transaction = ((...args: Parameters<DbClient['transaction']>) => {
            if (failOnce) {
              failOnce = false
              throw new Error('transient sqlite failure')
            }
            return originalTransaction(...args)
          }) as DbClient['transaction']
          try {
            await expect(
              opts.eventSink?.markTerminal('incomplete', 'stream-persist-failed'),
            ).rejects.toThrow('transient sqlite failure')
          } finally {
            db.transaction = originalTransaction
          }
          return okResult(envelope(nonce, { summary: 's', changeset: MINIMAL_CHANGESET }))
        }),
      },
      { sessionId: session.id, actor },
    )

    const turn = (await db.select().from(intentTurns).where(eq(intentTurns.id, outcome.turnId)))[0]
    expect(outcome.kind).toBe('changeset')
    expect(turn?.captureState).toBe('incomplete')
    expect(turn?.captureIncompleteReason).toBe('stream-persist-failed')
  })

  // Live-run regression (deepseek, 2026-07-28): the shared protocol block fed
  // with all four ports rendered a combined example → models emitted changeset
  // AND questions together → every turn errored intent-ports-exclusive. Lock
  // the prompt tail: mainline example lists summary+changeset ONLY, and the
  // exclusivity rule + alternative forms are stated explicitly.
  test('prompt tail: mainline example is summary+changeset with explicit exclusivity', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    let seenPrompt = ''
    await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((opts, nonce) => {
          seenPrompt = opts.prompt
          return okResult(envelope(nonce, { summary: 's', changeset: MINIMAL_CHANGESET }))
        }),
      },
      { sessionId: session.id, actor },
    )
    expect(seenPrompt).toContain('EXCLUSIVITY RULE')
    expect(seenPrompt).toContain('EXACTLY ONE of `changeset` or `questions`')
    // The block's own example must NOT pre-render a questions/requests port —
    // they appear only inside the alternative-form instructions.
    const exampleEnd = seenPrompt.indexOf('EXCLUSIVITY RULE')
    const mainBlock = seenPrompt.slice(0, exampleEnd)
    expect(mainBlock).toContain('<port name="summary">')
    expect(mainBlock).toContain('<port name="changeset">')
    expect(mainBlock).not.toContain('<port name="questions">')
    expect(mainBlock).not.toContain('<port name="requests">')
  })

  // Design-gate P2-2 injection drill: an envelope `requests` port (e.g. the
  // dump content coaxed the model into "please mount X") must land as
  // SUGGESTIONS on the turn row only — the session manifest gains NOTHING
  // until the user explicitly approves (D19: nothing auto-mounts).
  test('requests port records suggestions without touching the manifest', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const requests = JSON.stringify([
      { resourceType: 'agent', name: 'someone-elses-agent', reason: 'need it' },
    ])
    const turn = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((_o, nonce) =>
          okResult(envelope(nonce, { summary: 's', changeset: MINIMAL_CHANGESET, requests })),
        ),
      },
      { sessionId: session.id, actor },
    )
    expect(turn.kind).toBe('changeset')
    const turnRow = (
      await db.select().from(intentTurns).where(eq(intentTurns.sessionId, session.id))
    ).find((t) => t.kind === 'changeset')
    expect(JSON.parse(turnRow?.contentJson ?? '{}').mountRequests).toEqual([
      { resourceType: 'agent', name: 'someone-elses-agent', reason: 'need it' },
    ])
    const manifest = JSON.parse(
      (await db.select().from(intentSessions).where(eq(intentSessions.id, session.id)))[0]
        ?.contextManifestJson ?? '[]',
    ) as unknown[]
    expect(manifest).toEqual([])
  })
})

describe('maintenance', () => {
  test('boot recovery settles orphaned in-flight turns', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const turnId = ulid()
    await db.insert(intentTurns).values({
      id: turnId,
      sessionId: session.id,
      seq: 2,
      role: 'agent',
      kind: 'running',
      contentJson: '{}',
      contextRevision: 0,
      captureState: 'live',
      createdAt: Date.now(),
    } as typeof intentTurns.$inferInsert)
    await db
      .update(intentSessions)
      .set({ inFlightTurnId: turnId, turnSeq: 2 })
      .where(eq(intentSessions.id, session.id))

    expect(recoverIntentTurnsOnBoot(db)).toBe(1)
    const turn = (await db.select().from(intentTurns).where(eq(intentTurns.id, turnId)))[0]
    expect(turn?.kind).toBe('error')
    expect(JSON.parse(turn?.contentJson ?? '{}').code).toBe('intent-run-daemon-restart')
    expect(turn?.captureState).toBe('incomplete')
    expect(turn?.captureIncompleteReason).toBe('post-exit-flush-timeout')
    expect(
      (await db.select().from(intentSessions).where(eq(intentSessions.id, session.id)))[0]
        ?.inFlightTurnId,
    ).toBeNull()
  })

  test('boot recovery preserves an already-settled capture state', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const turnId = ulid()
    await db.insert(intentTurns).values({
      id: turnId,
      sessionId: session.id,
      seq: 2,
      role: 'agent',
      kind: 'running',
      contentJson: '{}',
      contextRevision: 0,
      captureState: 'truncated',
      createdAt: Date.now(),
    })
    await db
      .update(intentSessions)
      .set({ inFlightTurnId: turnId, turnSeq: 2 })
      .where(eq(intentSessions.id, session.id))

    expect(recoverIntentTurnsOnBoot(db)).toBe(1)
    const turn = (await db.select().from(intentTurns).where(eq(intentTurns.id, turnId)))[0]
    expect(turn?.kind).toBe('error')
    expect(turn?.captureState).toBe('truncated')
    expect(turn?.captureIncompleteReason).toBeNull()
  })

  test('scratch GC: terminal+old removed, running kept, fresh kept', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const scratchRoot = join(appHome, 'intent-scratch')
    const mk = (name: string, old: boolean): string => {
      const dir = join(scratchRoot, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'marker'), 'x')
      if (old) {
        const past = (Date.now() - 48 * 3600_000) / 1000
        utimesSync(dir, past, past)
      }
      return dir
    }
    const terminalTurn = ulid()
    const runningTurn = ulid()
    await db.insert(intentTurns).values([
      {
        id: terminalTurn,
        sessionId: session.id,
        seq: 2,
        role: 'agent',
        kind: 'error',
        contentJson: '{}',
        contextRevision: 0,
        createdAt: Date.now(),
      },
      {
        id: runningTurn,
        sessionId: session.id,
        seq: 3,
        role: 'agent',
        kind: 'running',
        contentJson: '{}',
        contextRevision: 0,
        createdAt: Date.now(),
      },
    ] as Array<typeof intentTurns.$inferInsert>)
    mk(terminalTurn, true)
    mk(runningTurn, true)
    mk('orphan-unknown', true)
    mk('fresh-terminal', false)

    const removed = sweepIntentScratch(db, appHome, 24)
    expect(removed).toBe(2) // terminal-old + unknown-old
    const left = new Set((await import('node:fs')).readdirSync(scratchRoot))
    expect(left.has(runningTurn)).toBe(true)
    expect(left.has('fresh-terminal')).toBe(true)
    expect(left.has(terminalTurn)).toBe(false)
    expect(left.has('orphan-unknown')).toBe(false)
  })
})
