// RFC-234 (T5) — turn engine behavior locks:
//  envelope port rules (summary + changeset XOR questions), immutable draft
//  minting + sha256 hash, budget accounting, in-flight single-flight 409,
//  cancel → aborted settle, context-epoch CAS (superseded result NEVER
//  installs a draft — design-gate P0-3), nonce persisted on the turn row
//  (P2-1), boot recovery and scratch GC.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { canonicalBinaryPath } from './fixtures/platformPaths'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  INTENT_LIMITS,
  ROLE_PERMISSIONS,
  WORKFLOW_SCHEMA_VERSION,
  canonicalIntentJson,
  parseIntentChangeset,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentDrafts, intentSessions, intentTurns, users } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import type { ResolvedRuntime } from '../src/services/runtimeRegistry'
import {
  emptySystemAgentOutputEvidence,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '../src/services/systemAgentRun'
import {
  abortIntentTurn,
  cancelIntentTurn,
  classifyMissingEnvelope,
  runIntentTurn,
  settleReservedIntentTurnStartFailure,
  type IntentTurnConfig,
} from '../src/services/intent/turnEngine'
import { recoverIntentTurnsOnBoot, sweepIntentScratch } from '../src/services/intent/maintenance'
import { sha256Hex } from '../src/util/hash'
import { normalizeIntentWorkflowCreateLayouts } from '../src/modules/intent/domain/workflowCreateLayout'
import {
  createIntentSession,
  createIntentSessionAndReserveTurn,
  insertUserTurn,
} from '../src/services/intent/session'

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
  // RFC-237: the engine threads the resolved config-dir profile into the
  // system-agent run (P1-2), so the mock carries the real resolved shape.
  configDir: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
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
    outputEvidence: emptySystemAgentOutputEvidence(),
  }
}

function envelope(nonce: string, ports: Record<string, string>): string {
  const body = Object.entries(ports)
    .map(([name, content]) => `<port name="${name}">${content}</port>`)
    .join('')
  return `noise before\n<workflow-output nonce="${nonce}">${body}</workflow-output>`
}

describe('RFC-273 missing-envelope evidence classification', () => {
  const evidence = (over: Partial<ReturnType<typeof emptySystemAgentOutputEvidence>> = {}) => ({
    ...emptySystemAgentOutputEvidence(),
    ...over,
  })

  test('classifies cap, no-text, terminal and stopped shapes in fixed priority order', () => {
    expect(
      classifyMissingEnvelope(
        evidence({
          assistantTextSeen: true,
          observedAssistantTextBytes: 10,
          retainedAssistantTextBytes: 5,
          terminalResult: 'success',
        }),
      ),
    ).toBe('output-cap-hit')
    expect(classifyMissingEnvelope(evidence({ terminalResult: 'success' }))).toBe(
      'no-assistant-text',
    )
    expect(
      classifyMissingEnvelope(
        evidence({
          assistantTextSeen: true,
          observedAssistantTextBytes: 5,
          retainedAssistantTextBytes: 5,
          terminalResult: 'success',
        }),
      ),
    ).toBe('terminal-without-envelope')
    expect(
      classifyMissingEnvelope(
        evidence({
          assistantTextSeen: true,
          observedAssistantTextBytes: 5,
          retainedAssistantTextBytes: 5,
        }),
      ),
    ).toBe('assistant-stopped-without-envelope')
    expect(classifyMissingEnvelope(undefined)).toBe('runtime-shape-unknown')
  })
})

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
  test('a runtime-config start failure settles the exact reserved row and clears in-flight', async () => {
    const { session, reservation } = await createIntentSessionAndReserveTurn(db, actor, {
      message: 'build with unavailable runtime',
    })
    expect(
      settleReservedIntentTurnStartFailure(db, {
        sessionId: session.id,
        actor,
        reservation,
        detail: 'runtime profile could not be resolved',
      }),
    ).toBe(true)

    const fresh = (
      await db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
    )[0]
    const turn = (
      await db.select().from(intentTurns).where(eq(intentTurns.id, reservation.turnId))
    )[0]
    expect(fresh?.inFlightTurnId).toBeNull()
    expect(turn?.kind).toBe('error')
    expect(turn?.captureState).toBe('complete')
    expect(JSON.parse(turn?.contentJson ?? '{}')).toEqual({
      code: 'intent-runtime-config-unavailable',
      detail: 'runtime profile could not be resolved',
    })
    expect(
      settleReservedIntentTurnStartFailure(db, {
        sessionId: session.id,
        actor,
        reservation,
        detail: 'late duplicate',
      }),
    ).toBe(false)
  })

  test('cancel settles a reserved row before the runtime controller exists', async () => {
    const { session, reservation } = await createIntentSessionAndReserveTurn(db, actor, {
      message: 'cancel before runtime resolution',
    })
    expect(cancelIntentTurn(db, actor, session.id)).toBe(true)

    const fresh = (
      await db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
    )[0]
    const turn = (
      await db.select().from(intentTurns).where(eq(intentTurns.id, reservation.turnId))
    )[0]
    expect(fresh?.inFlightTurnId).toBeNull()
    expect(turn?.kind).toBe('error')
    expect(turn?.captureState).toBe('complete')
    expect(JSON.parse(turn?.contentJson ?? '{}')).toEqual({ code: 'intent-run-aborted' })
    expect(cancelIntentTurn(db, actor, session.id)).toBe(false)
  })

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
              $schema_version: WORKFLOW_SCHEMA_VERSION,
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
    const persisted = JSON.parse(draft?.changesetJson ?? '{}') as {
      ops: Array<{ payload: { definition: { nodes: Array<Record<string, unknown>> } } }>
    }
    const persistedNodes = persisted.ops[0]!.payload.definition.nodes
    expect(persistedNodes.map((node) => node.id)).toEqual(['input', 'agent', 'output'])
    expect(persistedNodes.every((node) => node.position !== undefined)).toBe(true)
    const positions = persistedNodes.map((node) => node.position as { x: number; y: number })
    expect(Math.min(...positions.map((position) => position.x))).toBe(80)
    expect(Math.min(...positions.map((position) => position.y))).toBe(80)
    expect(persistedNodes[1]).toMatchObject({ agentRef: 'res#agent#1' })
    expect(persistedNodes[1]).not.toHaveProperty('agentId')
    expect(draft?.draftHash).toBe(`sha256:${sha256Hex(canonicalIntentJson(persisted))}`)
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

  test('RFC-302 malformed layout input mints a review-blocked draft instead of crashing', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'build malformed graph' })
    const definition = {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [
        { id: 'duplicate', kind: 'input' },
        { id: 'duplicate', kind: 'output' },
      ],
      edges: [],
    }
    const cs = JSON.stringify({
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:bad-flow',
          payload: { name: 'Bad flow', description: '', definition },
        },
      ],
    })
    const outcome = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((_opts, nonce) =>
          okResult(envelope(nonce, { summary: 'bad graph', changeset: cs })),
        ),
      },
      { sessionId: session.id, actor },
    )

    expect(outcome.kind).toBe('changeset')
    const draft = db.select().from(intentDrafts).where(eq(intentDrafts.sessionId, session.id)).get()
    const report = JSON.parse(draft?.validationJson ?? '{}') as { errors: string[] }
    expect(report.errors[0]).toBe(
      'op-1: workflow definition cannot be auto-laid out (duplicate node id duplicate) (intent-workflow-layout-input-invalid)',
    )
    const turn = db.select().from(intentTurns).where(eq(intentTurns.id, outcome.turnId)).get()
    expect(JSON.parse(turn?.contentJson ?? '{}').blockingErrors).toBeGreaterThan(0)
  })

  test('RFC-302 post-layout byte gate accepts exact limit, then retains evidence at limit + 1', async () => {
    const agentOps = Array.from({ length: 8 }, (_, index) => ({
      opId: `op-${index + 1}`,
      action: 'create',
      resourceType: 'agent',
      tempRef: `$new:padding-${index}`,
      payload: {
        name: `padding-${index}`,
        description: '',
        outputs: [],
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        bodyMd: index < 7 ? 'x'.repeat(262_000) : '',
      },
    }))
    const large = {
      $schema_version: 1,
      ops: [
        ...agentOps,
        {
          opId: 'op-9',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:large-flow',
          payload: {
            name: 'Large flow',
            description: '',
            definition: {
              $schema_version: WORKFLOW_SCHEMA_VERSION,
              inputs: [],
              nodes: Array.from({ length: 256 }, (_, index) => ({
                id: `node-${index}`,
                kind: 'input',
              })),
              edges: [],
            },
          },
        },
      ],
    }
    const base = parseIntentChangeset(JSON.stringify(large))
    if (!base.ok) throw new Error(base.errors.join('\n'))
    const targetBytes = INTENT_LIMITS.maxChangesetBytes - 16
    const paddingBytes = targetBytes - base.bytes
    expect(paddingBytes).toBeGreaterThan(0)
    expect(paddingBytes).toBeLessThanOrEqual(INTENT_LIMITS.maxBodyMdBytes)
    agentOps[7]!.payload.bodyMd = 'y'.repeat(paddingBytes)
    const nearLimit = parseIntentChangeset(JSON.stringify(large))
    if (!nearLimit.ok) throw new Error(nearLimit.errors.join('\n'))
    expect(nearLimit.bytes).toBe(targetBytes)
    const nearLimitNormalized = normalizeIntentWorkflowCreateLayouts(nearLimit.changeset)
    expect(nearLimitNormalized.errors).toEqual([])
    const nearLimitNormalizedBytes = Buffer.byteLength(
      canonicalIntentJson(nearLimitNormalized.changeset),
      'utf8',
    )
    const overflowBytes = nearLimitNormalizedBytes - INTENT_LIMITS.maxChangesetBytes
    expect(overflowBytes).toBeGreaterThan(0)
    expect(overflowBytes).toBeLessThan(paddingBytes)

    const exactPaddingBytes = paddingBytes - overflowBytes
    agentOps[7]!.payload.bodyMd = 'y'.repeat(exactPaddingBytes)
    const exactLimit = parseIntentChangeset(JSON.stringify(large))
    if (!exactLimit.ok) throw new Error(exactLimit.errors.join('\n'))
    const exactNormalized = normalizeIntentWorkflowCreateLayouts(exactLimit.changeset)
    expect(exactNormalized.errors).toEqual([])
    expect(Buffer.byteLength(canonicalIntentJson(exactNormalized.changeset), 'utf8')).toBe(
      INTENT_LIMITS.maxChangesetBytes,
    )

    const { session: exactSession } = await createIntentSession(db, actor, {
      message: 'build a graph at the exact canonical limit',
    })
    const exactOutcome = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((_opts, nonce) =>
          okResult(
            envelope(nonce, {
              summary: 'exact-limit graph',
              changeset: exactLimit.canonicalJson,
            }),
          ),
        ),
      },
      { sessionId: exactSession.id, actor },
    )
    expect(exactOutcome.kind).toBe('changeset')
    const exactDraft = db
      .select()
      .from(intentDrafts)
      .where(eq(intentDrafts.sessionId, exactSession.id))
      .get()
    expect(Buffer.byteLength(exactDraft?.changesetJson ?? '', 'utf8')).toBe(
      INTENT_LIMITS.maxChangesetBytes,
    )

    agentOps[7]!.payload.bodyMd = 'y'.repeat(exactPaddingBytes + 1)
    const overflow = parseIntentChangeset(JSON.stringify(large))
    if (!overflow.ok) throw new Error(overflow.errors.join('\n'))
    expect(overflow.bytes).toBeLessThan(INTENT_LIMITS.maxChangesetBytes)
    const overflowNormalized = normalizeIntentWorkflowCreateLayouts(overflow.changeset)
    expect(Buffer.byteLength(canonicalIntentJson(overflowNormalized.changeset), 'utf8')).toBe(
      INTENT_LIMITS.maxChangesetBytes + 1,
    )

    const { session: overflowSession } = await createIntentSession(db, actor, {
      message: 'build a graph one byte over the canonical limit',
    })

    let scratchDir = ''
    const outcome = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((opts, nonce) => {
          scratchDir = join(opts.scratchParent!, opts.scratchName!)
          mkdirSync(scratchDir, { recursive: true })
          return {
            ...okResult(
              envelope(nonce, {
                summary: 'large graph',
                changeset: overflow.canonicalJson,
              }),
            ),
            scratchDir,
            scratchRetained: true,
          }
        }),
      },
      { sessionId: overflowSession.id, actor },
    )

    expect(outcome.kind).toBe('error')
    expect(
      (await db.select().from(intentDrafts).where(eq(intentDrafts.sessionId, overflowSession.id)))
        .length,
    ).toBe(0)
    const turn = db.select().from(intentTurns).where(eq(intentTurns.id, outcome.turnId)).get()
    expect(turn?.scratchRetained).toBe(true)
    expect(existsSync(scratchDir)).toBe(true)
    const content = JSON.parse(turn?.contentJson ?? '{}') as { code: string; errors: string[] }
    expect(content.code).toBe('intent-changeset-invalid')
    expect(content.errors[0]).toContain('changeset-too-large:')
    expect(content.errors[0]).toContain('after workflow auto-layout')
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

  test('protocol failure retains scratch and evidence; a valid changeset releases the same owned shape', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    let failedScratch = ''
    const failed = await runIntentTurn(
      {
        db,
        appHome,
        config: config({ scratchRetentionHours: 12 }),
        runFn: scriptedRun((opts) => {
          expect(opts.retainScratchOnSuccess).toBe(true)
          failedScratch = join(opts.scratchParent, opts.scratchName ?? 'missing')
          mkdirSync(failedScratch, { recursive: true })
          return {
            ...okResult('read inventory, then stopped'),
            scratchDir: failedScratch,
            scratchRetained: true,
            outputEvidence: {
              ...emptySystemAgentOutputEvidence(),
              assistantTextSeen: true,
              observedAssistantTextBytes: 28,
              retainedAssistantTextBytes: 28,
              lastNormalizedEventKind: 'text',
              lastRuntimeEventType: 'assistant',
            },
          }
        }),
      },
      { sessionId: session.id, actor },
    )
    const failedTurn = (
      await db.select().from(intentTurns).where(eq(intentTurns.id, failed.turnId))
    )[0]
    expect(JSON.parse(failedTurn?.contentJson ?? '{}')).toEqual({
      code: 'intent-envelope-missing',
      reason: 'assistant-stopped-without-envelope',
    })
    expect(JSON.parse(failedTurn?.runMetaJson ?? '{}')).toMatchObject({
      scratchRetentionHours: 12,
      outputEvidence: {
        assistantTextSeen: true,
        lastRuntimeEventType: 'assistant',
      },
    })
    expect(failedTurn?.scratchRetained).toBe(true)
    expect(existsSync(failedScratch)).toBe(true)

    const second = await createIntentSession(db, actor, { message: 'valid' })
    let validScratch = ''
    const valid = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((opts, nonce) => {
          validScratch = join(opts.scratchParent, opts.scratchName ?? 'missing')
          mkdirSync(validScratch, { recursive: true })
          return {
            ...okResult(envelope(nonce, { summary: 'ok', changeset: MINIMAL_CHANGESET })),
            scratchDir: validScratch,
            scratchRetained: true,
          }
        }),
      },
      { sessionId: second.session.id, actor },
    )
    const validTurn = (
      await db.select().from(intentTurns).where(eq(intentTurns.id, valid.turnId))
    )[0]
    expect(valid.kind).toBe('changeset')
    expect(validTurn?.scratchRetained).toBe(false)
    expect(existsSync(validScratch)).toBe(false)
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
            definition: {
              $schema_version: WORKFLOW_SCHEMA_VERSION,
              inputs: [],
              nodes: [],
              edges: [],
            },
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

// RFC-276 — the engine admits a claude-code runtime naturally and threads only
// protocol/runtime/configDir into the system-agent run. No platform permission
// profile is manufactured; the changeset settle path stays protocol-blind.
describe('RFC-237 claude-code intent turn', () => {
  test('claude runtime: turn settles a changeset; run opts carry configDir and IS_SANDBOX toggle without a permission profile', async () => {
    const claudeRuntime = {
      name: 'claude-code',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('claude'),
      model: 'anthropic/claude-sonnet-5',
      variant: null,
      temperature: null,
      steps: null,
      maxSteps: null,
      isSandbox: true,
      configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
    } satisfies ResolvedRuntime
    const { session } = await createIntentSession(db, actor, { message: '构建一个审计 agent' })
    let seen: SystemAgentRunOptions | undefined
    const outcome = await runIntentTurn(
      {
        db,
        appHome,
        config: config({ runtime: claudeRuntime }),
        runFn: scriptedRun((opts, nonce) => {
          seen = opts
          return okResult(
            envelope(nonce, { summary: 'built one agent', changeset: MINIMAL_CHANGESET }),
          )
        }),
      },
      { sessionId: session.id, actor },
    )
    expect(outcome.kind).toBe('changeset')
    expect(seen?.protocol).toBe('claude-code')
    expect(seen?.runtimeBinary).toBe(canonicalBinaryPath('claude'))
    expect(seen).not.toHaveProperty('systemPermissionProfile')
    expect(seen?.configDirEnv).toBe('CLAUDE_CONFIG_DIR')
    expect(seen?.configDirName).toBe('.claude')
    expect(seen?.isSandbox).toBe(true)
    const drafts = await db.select().from(intentDrafts)
    expect(drafts.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The privileged-node forms in INTENT.md must follow the REQUESTING ACTOR.
//
// intentDoc.test.ts proves the doc renders both ways; this proves the engine
// actually asks. A hardcoded `privileges: {all true}` here would keep every
// doc-level test green while teaching a plain `role:'user'` session to emit
// script / code-host-call nodes that apply then refuses as a whole — the exact
// wasted-turn this split exists to prevent.
// ---------------------------------------------------------------------------
describe('INTENT.md privileged node forms track the actor’s permissions', () => {
  async function docFor(seedActor: Actor): Promise<string> {
    const { session } = await createIntentSession(db, seedActor, { message: 'build something' })
    let seenDoc = ''
    const outcome = await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((opts, nonce) => {
          seenDoc = opts.seedFiles?.find((f) => f.path === 'INTENT.md')?.content ?? ''
          return okResult(envelope(nonce, { summary: 'ok', changeset: MINIMAL_CHANGESET }))
        }),
      },
      { sessionId: session.id, actor: seedActor },
    )
    expect(outcome.kind).toBe('changeset')
    return seenDoc
  }

  test('a plain user is taught neither form and told which permission is missing', async () => {
    const doc = await docFor(actor)
    expect(doc).not.toContain("{id,kind:'script'")
    expect(doc).not.toContain("{id,kind:'code-host-call'")
    expect(doc).toContain('Capability limits (hard)')
    expect(doc).toContain('scripts:author')
    expect(doc).toContain('code-host-calls:author')
  })

  test('an author-permitted actor is taught both, with no capability-limits section', async () => {
    const doc = await docFor({
      ...actor,
      permissions: new Set(['scripts:author', 'code-host-calls:author'] as const),
    })
    expect(doc).toContain("{id,kind:'script'")
    expect(doc).toContain("{id,kind:'code-host-call'")
    expect(doc).toContain('`comment.reply-thread`') // the derived action catalog rides along
    expect(doc).not.toContain('Capability limits (hard)')
  })

  test('the two permissions are independent end-to-end', async () => {
    const doc = await docFor({
      ...actor,
      permissions: new Set(['scripts:author'] as const),
    })
    expect(doc).toContain("{id,kind:'script'")
    expect(doc).not.toContain("{id,kind:'code-host-call'")
    expect(doc).toContain('code-host-calls:author')
  })
})

// The same wire-through, but driven by REAL role permission sets rather than
// hand-written ones. This is the test that actually answers "can an ordinary
// user get these node forms": if ROLE_PERMISSIONS.user ever gained
// scripts:author, the hand-written variants above would keep passing while the
// product silently changed.
describe('privileged node forms follow real ROLE_PERMISSIONS', () => {
  async function docForRole(role: 'user' | 'manager' | 'admin'): Promise<string> {
    const roleActor: Actor = {
      user: { id: OWNER, username: 'owner', displayName: 'Owner', role, status: 'active' },
      source: 'session',
      permissions: new Set(ROLE_PERMISSIONS[role]),
    }
    const { session } = await createIntentSession(db, roleActor, { message: 'build' })
    let seenDoc = ''
    await runIntentTurn(
      {
        db,
        appHome,
        config: config(),
        runFn: scriptedRun((opts, nonce) => {
          seenDoc = opts.seedFiles?.find((f) => f.path === 'INTENT.md')?.content ?? ''
          return okResult(envelope(nonce, { summary: 'ok', changeset: MINIMAL_CHANGESET }))
        }),
      },
      { sessionId: session.id, actor: roleActor },
    )
    return seenDoc
  }

  test("role 'user' is taught neither privileged form", async () => {
    const doc = await docForRole('user')
    expect(doc).not.toContain("{id,kind:'script'")
    expect(doc).not.toContain("{id,kind:'code-host-call'")
    expect(doc).toContain('Capability limits (hard)')
  })

  for (const role of ['manager', 'admin'] as const) {
    test(`role '${role}' is taught both`, async () => {
      const doc = await docForRole(role)
      expect(doc).toContain("{id,kind:'script'")
      expect(doc).toContain("{id,kind:'code-host-call'")
      expect(doc).not.toContain('Capability limits (hard)')
    })
  }
})
