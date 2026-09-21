// RFC-367 T6 — runDistill's protocol follow-up loop.
//
// The behaviour under test is the whole point of the RFC: before it, a model
// that emitted an envelope without a `<port name="candidates">` wrapper got a
// `log.warn` and the job was marked done with zero candidates. Ten consecutive
// production runs did exactly that and nobody noticed for a month
// (proposal §1). Now the run re-asks IN THE SAME SESSION and, if that fails
// too, the job fails with a reason the admin can read.
//
// Everything here drives the real `runDistill` with a fake `runFn`, so the
// assertions cover the orchestration (rounds, resume identity, scratch
// lifetime, budget arithmetic, AC-14) without paying for a subprocess.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { memories, memoryDistillJobs } from '../src/db/schema'
import {
  runDistill,
  type RunDistillOptions,
} from '../src/modules/memory/application/distill/memoryDistiller'
import { rowToDistillJob } from '../src/modules/memory/application/distill/memoryDistiller'
import { DistillerProtocolError } from '../src/modules/memory/application/distill/distillerOutput'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'
import { DatabaseCommittedReviewArtifactReader } from '../src/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '../src/services/systemAgentRun'
import { appHome } from '../src/util/paths'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'

const NONCE = 'deadbeefcafe0001'

const candidate = (over: Record<string, unknown> = {}) => ({
  scopeType: 'global',
  scopeId: null,
  title: '[category:invariant] refunds close 14 days after shipment',
  bodyMd: 'The refund window is 14 days from shipment; later requests need manager approval.',
  knownTags: [],
  newTags: ['invariant'],
  action: 'new',
  referenceMemoryId: null,
  sourceRefs: [{ kind: 'feedback', id: 'src-1' }],
  ...over,
})

const envelopeWithPort = (payload: unknown) =>
  `<workflow-output nonce="${NONCE}"><port name="candidates">${JSON.stringify(payload)}</port></workflow-output>`

/** The exact production failure shape: envelope, no port wrapper. */
const envelopeWithoutPort = (payload: unknown) =>
  `<workflow-output nonce="${NONCE}">\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n</workflow-output>`

describeEachProvider('RFC-367 runDistill follow-up loop', (harness) => {
  let db: ProviderNeutralDatabase
  let previousHome: string | undefined
  let temporaryHome: string

  beforeEach(() => {
    db = harness.db
    previousHome = process.env.AGENT_WORKFLOW_HOME
    temporaryHome = mkdtempSync(join(tmpdir(), 'aw-rfc367-'))
    process.env.AGENT_WORKFLOW_HOME = temporaryHome
    resetBroadcastersForTests()
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousHome
    rmSync(temporaryHome, { recursive: true, force: true })
  })

  async function seedJob(): Promise<ReturnType<typeof rowToDistillJob>> {
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
    const row = (
      await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id)).limit(1)
    )[0]!
    return rowToDistillJob(row)
  }

  interface FakeRun {
    calls: SystemAgentRunOptions[]
    runFn: RunDistillOptions['runFn']
  }

  /**
   * Each scripted round returns an eventText (or a non-ok status). The fake
   * creates the scratch dir the way `runSystemAgent` would, so scratch-release
   * assertions run against a real directory.
   */
  function fakeRuns(
    script: Array<Partial<SystemAgentRunResult> & { eventText?: string }>,
    // `null` = the runtime never announced a session id. (Passing `undefined`
    // explicitly would re-trigger the default — a trap worth not re-stepping on.)
    sessionId: string | null = 'ses_distill',
  ): FakeRun {
    const calls: SystemAgentRunOptions[] = []
    const runFn: RunDistillOptions['runFn'] = async (opts) => {
      calls.push(opts)
      const step = script[Math.min(calls.length - 1, script.length - 1)]!
      const scratchDir = join(opts.scratchParent, opts.scratchName ?? 'unnamed')
      mkdirSync(scratchDir, { recursive: true })
      return {
        status: 'ok',
        exitCode: 0,
        eventText: '',
        stderrTail: '',
        durationMs: 1,
        scratchDir,
        scratchRetained: true,
        outputEvidence: emptySystemAgentOutputEvidence(),
        ...(sessionId === null ? {} : { capturedSessionId: sessionId }),
        ...step,
      } as SystemAgentRunResult
    }
    return { calls, runFn }
  }

  const baseOptions = (
    job: ReturnType<typeof rowToDistillJob>,
    runFn: RunDistillOptions['runFn'],
  ): RunDistillOptions => ({
    store: new DrizzleMemoryDistillWorkStore(db, () => ({
      append: async () => {},
      setRootSessionId: async () => {},
      markTerminal: async () => {},
    })),
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(db, appHome()),
    job,
    siblings: [job],
    runFn,
    envelopeNonce: NONCE,
    timeoutMs: 60_000,
  })

  test('a missing port is re-asked in the SAME session and the retry lands the candidates', async () => {
    const job = await seedJob()
    const fake = fakeRuns([
      { eventText: envelopeWithoutPort({ candidates: [candidate()] }) },
      { eventText: envelopeWithPort({ candidates: [candidate()] }) },
    ])
    const result = await runDistill(baseOptions(job, fake.runFn))

    expect(result.candidatesCreated).toBe(1)
    expect(fake.calls).toHaveLength(2)
    // Round 1 resumes round 0's session — that identity is what makes the
    // correction cheap (the agent still holds the whole source batch).
    expect(fake.calls[0]!.resumeSessionId).toBeUndefined()
    expect(fake.calls[1]!.resumeSessionId).toBe('ses_distill')
    // …and it is told what actually broke, not "you emitted no envelope".
    expect(fake.calls[1]!.prompt).toContain('no `<port name="...">` element')
    expect(fake.calls[1]!.prompt).not.toContain('did not contain a `<workflow-output>` envelope')

    const rows = await db.select().from(memories).where(eq(memories.distillJobId, job.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('candidate')
  })

  test('every round shares one scratch dir (claude --resume is cwd-scoped)', async () => {
    const job = await seedJob()
    const fake = fakeRuns([
      { eventText: envelopeWithoutPort({ candidates: [candidate()] }) },
      { eventText: envelopeWithPort({ candidates: [] }) },
    ])
    await runDistill(baseOptions(job, fake.runFn))
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0]!.scratchName).toBe(fake.calls[1]!.scratchName)
    // Without this flag runSystemAgent would delete the dir after round 0 (it
    // exits `ok` — the protocol verdict is ours, not the process's).
    expect(fake.calls.every((c) => c.retainScratchOnSuccess === true)).toBe(true)
  })

  test('the timeout is a budget for the WHOLE distill, not per round', async () => {
    const job = await seedJob()
    const fake = fakeRuns([
      { eventText: envelopeWithoutPort({ candidates: [candidate()] }) },
      { eventText: envelopeWithPort({ candidates: [] }) },
    ])
    await runDistill({ ...baseOptions(job, fake.runFn), timeoutMs: 60_000 })
    const first = fake.calls[0]!.timeoutMs ?? 0
    const second = fake.calls[1]!.timeoutMs ?? 0
    expect(first).toBeLessThanOrEqual(60_000)
    expect(second).toBeLessThanOrEqual(first)
  })

  test('the budget is exhausted after DEFAULT_PROTOCOL_RETRY_BUDGET follow-ups', async () => {
    const job = await seedJob()
    const fake = fakeRuns([{ eventText: envelopeWithoutPort({ candidates: [candidate()] }) }])
    await expect(runDistill(baseOptions(job, fake.runFn))).rejects.toThrow(DistillerProtocolError)
    // 1 first round + 3 follow-ups.
    expect(fake.calls).toHaveLength(4)
  })

  test('the thrown error names the failure code and the rounds tried', async () => {
    const job = await seedJob()
    const fake = fakeRuns([{ eventText: 'I found nothing worth distilling.' }])
    const error = await runDistill(baseOptions(job, fake.runFn)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DistillerProtocolError)
    const typed = error as DistillerProtocolError
    expect(typed.code).toBe('envelope-missing')
    expect(typed.roundsTried).toBe(4)
    expect(typed.message).toContain('envelope-missing')
  })

  test('no session id → no follow-up, fail after one round (AC-9)', async () => {
    const job = await seedJob()
    const fake = fakeRuns([{ eventText: envelopeWithoutPort({ candidates: [candidate()] }) }], null)
    const error = await runDistill(baseOptions(job, fake.runFn)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DistillerProtocolError)
    expect((error as DistillerProtocolError).roundsTried).toBe(1)
    expect(fake.calls).toHaveLength(1)
  })

  // Distiller ↔ claude-code parity. Before RFC-367 this lived in
  // `memory-distiller.test.ts` as a parser case fed raw `stream-json` lines;
  // the parser is runtime-agnostic now (normalization has one owner, the
  // executor's pump — claude's `message.content[]` shape is locked in
  // `rfc234-system-agent-run.test.ts`). What still has to be proven here is the
  // orchestration half: a claude-routed distill reaches the same candidate
  // persistence. `EXECUTION_CAPABILITY_COVERAGE`'s memory-distill spine anchors
  // on this case — the distiller is not opencode-only.
  test('a claude-code run persists candidates the same way (runtime parity)', async () => {
    const job = await seedJob()
    const fake = fakeRuns([{ eventText: envelopeWithPort({ candidates: [candidate()] }) }])
    const result = await runDistill({
      ...baseOptions(job, fake.runFn),
      protocol: 'claude-code',
      runtimeBinary: '/opt/claude',
      model: 'claude-x',
      isSandbox: true,
    })
    expect(result.candidatesCreated).toBe(1)
    expect(fake.calls[0]!.protocol).toBe('claude-code')
    expect(fake.calls[0]!.isSandbox).toBe(true)
    const rows = await db.select().from(memories).where(eq(memories.distillJobId, job.id))
    expect(rows).toHaveLength(1)
  })

  test('an empty candidates array succeeds without a follow-up (AC-6)', async () => {
    const job = await seedJob()
    const fake = fakeRuns([{ eventText: envelopeWithPort({ candidates: [] }) }])
    const result = await runDistill(baseOptions(job, fake.runFn))
    expect(result).toEqual({ candidatesCreated: 0, createdMemoryIds: [] })
    expect(fake.calls).toHaveLength(1)
  })

  test('a process-level failure throws immediately and is never re-asked', async () => {
    const job = await seedJob()
    const fake = fakeRuns([{ status: 'exit-nonzero', exitCode: 3, stderrTail: 'boom' }])
    await expect(runDistill(baseOptions(job, fake.runFn))).rejects.toThrow(
      /exited with code 3: boom/,
    )
    expect(fake.calls).toHaveLength(1)
  })

  test('AC-14: candidates that all fail validation fail the job instead of going green', async () => {
    const job = await seedJob()
    // scopeType=global with a non-null scopeId violates MemorySchema.
    const fake = fakeRuns([
      { eventText: envelopeWithPort({ candidates: [candidate({ scopeId: 'not-null' })] }) },
    ])
    await expect(runDistill(baseOptions(job, fake.runFn))).rejects.toThrow(/none passed validation/)
    const rows = await db.select().from(memories).where(eq(memories.distillJobId, job.id))
    expect(rows).toHaveLength(0)
  })

  test('a partially-invalid batch still persists the good ones', async () => {
    const job = await seedJob()
    const fake = fakeRuns([
      {
        eventText: envelopeWithPort({
          candidates: [
            candidate({ scopeId: 'not-null' }),
            candidate({ title: '[category:process] ok one' }),
          ],
        }),
      },
    ])
    const result = await runDistill(baseOptions(job, fake.runFn))
    expect(result.candidatesCreated).toBe(1)
  })

  test('AC-12: the shared scratch is released once the chain ends ok', async () => {
    const job = await seedJob()
    const fake = fakeRuns([{ eventText: envelopeWithPort({ candidates: [] }) }])
    await runDistill(baseOptions(job, fake.runFn))
    const scratchDir = join(fake.calls[0]!.scratchParent, fake.calls[0]!.scratchName ?? 'unnamed')
    expect(existsSync(scratchDir)).toBe(false)
  })

  test('AC-12: an unreaped round keeps the scratch (a child may still own it)', async () => {
    const job = await seedJob()
    const fake = fakeRuns([{ status: 'unreaped' }])
    await expect(runDistill(baseOptions(job, fake.runFn))).rejects.toThrow(/could not be reaped/)
    const scratchDir = join(fake.calls[0]!.scratchParent, fake.calls[0]!.scratchName ?? 'unnamed')
    expect(existsSync(scratchDir)).toBe(true)
  })

  test('AC-12: a spawn failure keeps the scratch too (cleanup failure is indistinguishable)', async () => {
    const job = await seedJob()
    const fake = fakeRuns([{ status: 'spawn-failed', stderrTail: 'runtime cleanup failed' }])
    await expect(runDistill(baseOptions(job, fake.runFn))).rejects.toThrow(/cleanup failed/)
    const scratchDir = join(fake.calls[0]!.scratchParent, fake.calls[0]!.scratchName ?? 'unnamed')
    expect(existsSync(scratchDir)).toBe(true)
  })

  test('AC-13: a truncated reply is reported as such, not blamed on the model', async () => {
    const job = await seedJob()
    const fake = fakeRuns([
      {
        eventText: 'a very long reply that got cut before the envelope',
        outputEvidence: { ...emptySystemAgentOutputEvidence(), eventTextCapHit: true },
      },
    ])
    const error = await runDistill(baseOptions(job, fake.runFn)).catch((e: unknown) => e)
    expect((error as Error).message).toContain('retained-output cap')
  })
})
