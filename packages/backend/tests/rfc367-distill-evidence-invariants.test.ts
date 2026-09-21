// RFC-367 closeout — the three acceptance items that had no named lock yet.
//
// AC-7 / AC-8 / AC-10 were implemented in the RFC batch (4e956ba87) but shipped
// without a test naming them. The pump half of the same-source invariant — one
// normalized stream feeding BOTH the parser's `eventText` and the sink — is
// locked in rfc234-system-agent-run.test.ts; this file locks the orchestration
// half on top of the REAL store sink (no fake sinkFactory):
//
//  - AC-7: after a successful distill, the session tab renders the EXACT
//    envelope text the candidate parser consumed. Both read the same
//    `memory_distill_events` rows, so "the page shows an envelope but
//    candidates are 0 with no explanation" — the bug that silently ate a
//    month of production output (proposal §1) — cannot come back without
//    this test going red.
//  - AC-8: a claude-code-routed distill leaves event rows and a renderable
//    session. Before RFC-367 claude-code had no distill capture at all.
//  - AC-10: a full attempt (success AND protocol failure) never rewrites a
//    historical task / task_feedback / pre-existing memory row — the distill
//    path only ever ADDS rows to the memory tables.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import {
  memories,
  memoryDistillEvents,
  memoryDistillJobs,
  taskFeedback,
  tasks,
} from '../src/db/schema'
import {
  runDistill,
  rowToDistillJob,
  type RunDistillOptions,
} from '../src/modules/memory/application/distill/memoryDistiller'
import { DistillerProtocolError } from '../src/modules/memory/application/distill/distillerOutput'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'
import { composeMemoryDistillQueries } from '../src/modules/memory/composition'
import { DatabaseCommittedReviewArtifactReader } from '../src/modules/collaboration/infrastructure/committedReviewArtifactReader'
import {
  emptySystemAgentOutputEvidence,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '../src/services/systemAgentRun'
import { appHome } from '../src/util/paths'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'

const NONCE = 'deadbeefcafe0002'
const SESSION_ID = 'ses_distill'

const candidate = (over: Record<string, unknown> = {}) => ({
  scopeType: 'global',
  scopeId: null,
  title: '[category:invariant] refunds close 14 days after shipment',
  bodyMd: 'The refund window is 14 days from shipment; later requests need manager approval.',
  knownTags: [],
  newTags: ['invariant'],
  action: 'new',
  referenceMemoryId: null,
  sourceRefs: [{ kind: 'feedback', id: 'fb-hist' }],
  ...over,
})

const envelopeWithPort = (payload: unknown) =>
  `<workflow-output nonce="${NONCE}"><port name="candidates">${JSON.stringify(payload)}</port></workflow-output>`

/** The exact production failure shape: envelope, no port wrapper. */
const envelopeWithoutPort = (payload: unknown) =>
  `<workflow-output nonce="${NONCE}">\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n</workflow-output>`

function providerTaskLineage(id: string) {
  return {
    executionLineageId: id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
    ]),
  }
}

describeEachProvider('RFC-367 distill evidence invariants (AC-7/AC-8/AC-10)', (harness) => {
  let db: ProviderNeutralDatabase
  let previousHome: string | undefined
  let temporaryHome: string

  beforeEach(() => {
    db = harness.db
    previousHome = process.env.AGENT_WORKFLOW_HOME
    temporaryHome = mkdtempSync(join(tmpdir(), 'aw-rfc367-ev-'))
    process.env.AGENT_WORKFLOW_HOME = temporaryHome
    resetBroadcastersForTests()
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousHome
    rmSync(temporaryHome, { recursive: true, force: true })
  })

  async function seedJob(over: { taskId?: string | null; sourceEventId?: string } = {}) {
    const id = ulid()
    await db.insert(memoryDistillJobs).values({
      id,
      debounceKey: `${over.taskId ?? 'task-x'}:feedback`,
      sourceKind: 'feedback',
      sourceEventId: over.sourceEventId ?? 'fb-hist',
      taskId: over.taskId ?? null,
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

  /**
   * Mirrors the pump contract (`systemAgentRun.ts`): the same normalized text
   * goes to BOTH the sink (what the session tab reads) and `eventText` (what
   * the candidate parser reads). `sessionless` reproduces the AC-9 shape where
   * the runtime never announced a session id.
   */
  function streamingFake(
    script: Array<Partial<SystemAgentRunResult> & { eventText?: string }>,
    opts: { sessionless?: boolean } = {},
  ): { calls: SystemAgentRunOptions[]; runFn: RunDistillOptions['runFn'] } {
    const calls: SystemAgentRunOptions[] = []
    const runFn: RunDistillOptions['runFn'] = async (o) => {
      calls.push(o)
      const step = script[Math.min(calls.length - 1, script.length - 1)]!
      const scratchDir = join(o.scratchParent, o.scratchName ?? 'unnamed')
      mkdirSync(scratchDir, { recursive: true })
      if (o.eventSink !== undefined && step.eventText !== undefined) {
        if (!opts.sessionless) await o.eventSink.setRootSessionId(SESSION_ID)
        await o.eventSink.append({
          ts: Date.now(),
          kind: 'text',
          payload: step.eventText,
          sessionId: opts.sessionless ? null : SESSION_ID,
          parentSessionId: null,
          source: 'stream' as const,
        })
        await o.eventSink.markTerminal('complete')
      }
      return {
        status: 'ok',
        exitCode: 0,
        eventText: '',
        stderrTail: '',
        durationMs: 1,
        scratchDir,
        scratchRetained: true,
        outputEvidence: emptySystemAgentOutputEvidence(),
        ...(opts.sessionless ? {} : { capturedSessionId: SESSION_ID }),
        ...step,
      } as SystemAgentRunResult
    }
    return { calls, runFn }
  }

  const baseOptions = (
    job: ReturnType<typeof rowToDistillJob>,
    runFn: RunDistillOptions['runFn'],
  ): RunDistillOptions => ({
    // No sinkFactory => the REAL memory_distill_events writer.
    store: new DrizzleMemoryDistillWorkStore(db),
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(db, appHome()),
    job,
    siblings: [job],
    runFn,
    envelopeNonce: NONCE,
    timeoutMs: 60_000,
  })

  const assistantTexts = (
    tree: NonNullable<
      Awaited<
        ReturnType<ReturnType<typeof composeMemoryDistillQueries>['getJobSessionView']>
      >['attempts'][number]['tree']
    >,
  ): string[] => tree.messages.flatMap((m) => (m.kind === 'assistant-text' ? [m.text] : []))

  test('AC-7: the session tab renders the exact envelope the parser consumed', async () => {
    const job = await seedJob()
    const envelope = envelopeWithPort({ candidates: [candidate()] })
    const fake = streamingFake([{ eventText: envelope }])
    const result = await runDistill(baseOptions(job, fake.runFn))

    // The parser demonstrably consumed exactly this envelope (nonce + payload).
    expect(result.candidatesCreated).toBe(1)
    const persisted = await db.select().from(memories).where(eq(memories.distillJobId, job.id))
    expect(persisted).toHaveLength(1)

    const view = await composeMemoryDistillQueries(db).getJobSessionView(job.id)
    expect(view.attempts).toHaveLength(1)
    expect(view.attempts[0]!.captureFailed).toBe(false)
    const tree = view.attempts[0]!.tree
    expect(tree).not.toBeNull()
    // Same source, both directions: the page shows what was parsed —
    // byte-for-byte, not "contains something similar".
    expect(assistantTexts(tree!)).toEqual([envelope])
  })

  test('AC-8: a claude-code distill leaves event rows and a renderable session', async () => {
    const job = await seedJob()
    const envelope = envelopeWithPort({ candidates: [candidate()] })
    const fake = streamingFake([{ eventText: envelope }])
    const result = await runDistill({
      ...baseOptions(job, fake.runFn),
      protocol: 'claude-code',
      runtimeBinary: '/opt/claude',
      model: 'claude-x',
    })
    expect(result.candidatesCreated).toBe(1)
    expect(fake.calls[0]!.protocol).toBe('claude-code')

    const rows = await db
      .select()
      .from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, job.id))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.payload === envelope && r.kind === 'text')).toBe(true)

    const view = await composeMemoryDistillQueries(db).getJobSessionView(job.id)
    const tree = view.attempts[0]!.tree
    expect(tree).not.toBeNull()
    expect(assistantTexts(tree!)).toEqual([envelope])
  })

  test('AC-10: full attempts (ok and protocol failure) rewrite no historical row', async () => {
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'history-task',
      workflowId: 'wf-history',
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      baseCommit: 'deadbeef',
      status: 'done',
      inputs: '{}',
      startedAt: 1,
      finishedAt: 2,
      ...providerTaskLineage(taskId),
    })
    await db.insert(taskFeedback).values({
      id: 'fb-hist',
      taskId,
      authorUserId: null,
      bodyMd: 'the refund window is wrong — it is 14 days, not 7',
      createdAt: 42,
      distilled: 0,
    })
    await db.insert(memories).values([
      {
        id: 'mem-hist-approved',
        scopeType: 'global',
        scopeId: null,
        title: '[category:process] releases cut on fridays',
        bodyMd: 'Releases only cut on fridays.',
        tags: '[]',
        status: 'approved',
        sourceKind: 'manual',
        sourceEventId: null,
        sourceTaskId: null,
        distillJobId: null,
        distillAction: null,
        approvedByUserId: 'user-1',
        approvedAt: 50,
        createdAt: 50,
      },
      {
        id: 'mem-hist-candidate',
        scopeType: 'global',
        scopeId: null,
        title: '[category:invariant] legacy row awaiting review',
        bodyMd: 'A pre-existing candidate row.',
        tags: '[]',
        status: 'candidate',
        sourceKind: 'clarify',
        sourceEventId: 'cl-1',
        sourceTaskId: null,
        distillJobId: 'other-job',
        distillAction: 'new',
        approvedByUserId: null,
        approvedAt: null,
        createdAt: 51,
      },
    ])

    const snapshot = async () => {
      const byId = <T extends { id: string }>(rows: T[]) =>
        [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))
      return {
        tasks: byId(await db.select().from(tasks)),
        feedback: byId(await db.select().from(taskFeedback)),
        memories: byId(await db.select().from(memories)),
      }
    }
    const before = await snapshot()

    // Success leg: the run READS the task/feedback/global-memory context and
    // must leave every historical row byte-identical.
    const job = await seedJob({ taskId, sourceEventId: 'fb-hist' })
    const ok = await runDistill(
      baseOptions(
        job,
        streamingFake([{ eventText: envelopeWithPort({ candidates: [candidate()] }) }]).runFn,
      ),
    )
    expect(ok.candidatesCreated).toBe(1)

    // Failure leg (no session id → single round, AC-9 shape): the protocol
    // failure path is equally barred from touching history.
    const failJob = await seedJob({ taskId, sourceEventId: 'fb-hist' })
    await expect(
      runDistill(
        baseOptions(
          failJob,
          streamingFake([{ eventText: envelopeWithoutPort({ candidates: [candidate()] }) }], {
            sessionless: true,
          }).runFn,
        ),
      ),
    ).rejects.toThrow(DistillerProtocolError)

    const after = await snapshot()
    expect(after.tasks).toEqual(before.tasks)
    expect(after.feedback).toEqual(before.feedback)
    // Pre-existing memory rows survive untouched; the only additions belong
    // to this job (the distill path is additive on the memory tables only).
    const beforeIds = new Set(before.memories.map((m) => m.id))
    const added = after.memories.filter((m) => !beforeIds.has(m.id))
    expect(added).toHaveLength(1)
    expect(added[0]!.distillJobId).toBe(job.id)
    expect(after.memories.filter((m) => beforeIds.has(m.id))).toEqual(before.memories)
  })
})
