// RFC-043 T3 — locks the new capture-side behaviour added to runDistill:
//   1. attempts === 0 path writes user_prompt_md + dedup_snapshot_ids_json
//   2. attempts > 0 path does NOT overwrite user_prompt_md (audit trail)
//   3. exit_code + stderr_excerpt + opencode_session_id always land on
//      the job row after spawn, regardless of exitCode
//   4. captureDistillJobSession is invoked iff a session id was recovered
//      (and is swallowed on failure)
//
// RFC-367 migrated the seam from `spawnFn` (raw stdout) to `runFn`
// (`runSystemAgent`'s normalized result) and made an unparseable reply a real
// failure instead of a silent empty result — case 4 below changed meaning with
// it and is re-stated rather than renamed.
//   5. exit-code throw still propagates so the scheduler can record
//      last_error + back off

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { memories, memoryDistillJobs } from '../src/db/schema'
import {
  clipAndRedactStderr,
  runDistill,
  type RunDistillOptions,
} from '../src/modules/memory/application/distill/memoryDistiller'
import { DistillerProtocolError } from '../src/modules/memory/application/distill/distillerOutput'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '../src/services/systemAgentRun'
import { rowToDistillJob } from '../src/modules/memory/application/distill/memoryDistiller'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { DatabaseCommittedReviewArtifactReader } from '../src/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'
import { appHome } from '../src/util/paths'
import { describeEachProvider } from './helpers/eachProvider'

function createMemoryDistillTestContext(db: ProviderNeutralDatabase) {
  return {
    store: new DrizzleMemoryDistillWorkStore(db),
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(db, appHome()),
  }
}

function emptyDistillerEnvelope(opts: SystemAgentRunOptions): string {
  const nonce = /nonce="([^"]+)"/.exec(opts.prompt)?.[1] ?? ''
  return `<workflow-output nonce="${nonce}"><port name="candidates">{"candidates":[]}</port></workflow-output>`
}

/** A run that behaves like a healthy distiller unless `over` says otherwise. */
function fakeRun(over: Partial<SystemAgentRunResult> = {}): RunDistillOptions['runFn'] {
  return async (opts) =>
    ({
      status: 'ok',
      exitCode: 0,
      eventText: emptyDistillerEnvelope(opts),
      stderrTail: '',
      durationMs: 1,
      scratchDir: join(opts.scratchParent, opts.scratchName ?? 'unnamed'),
      scratchRetained: true,
      outputEvidence: emptySystemAgentOutputEvidence(),
      capturedSessionId: 'sess-xyz',
      ...over,
    }) as SystemAgentRunResult
}

async function seedJobRow(db: ProviderNeutralDatabase, attempts = 0) {
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
    attempts,
    nextRunAt: Date.now(),
    createdAt: Date.now(),
  })

  return (
    await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id)).limit(1)
  )[0]!
}

async function seedGlobalApproved(db: ProviderNeutralDatabase, title: string) {
  const id = ulid()
  await db.insert(memories).values({
    id,
    scopeType: 'global',
    scopeId: null,
    title,
    bodyMd: 'body',
    tags: '[]',
    status: 'approved',
    sourceKind: 'manual',
    sourceEventId: null,
    distillJobId: null,
    distillAction: null,
    createdAt: Date.now(),
    version: 1,
  })

  return id
}

describeEachProvider('runDistill RFC-043 capture extensions', (harness) => {
  let db: ProviderNeutralDatabase
  let memory: ReturnType<typeof createMemoryDistillTestContext>
  let previousHome: string | undefined
  let temporaryHome: string
  beforeEach(() => {
    db = harness.db
    previousHome = process.env.AGENT_WORKFLOW_HOME
    temporaryHome = mkdtempSync(join(tmpdir(), 'aw-memory-capture-'))
    process.env.AGENT_WORKFLOW_HOME = temporaryHome
    memory = createMemoryDistillTestContext(db)
    resetBroadcastersForTests()
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousHome
    rmSync(temporaryHome, { recursive: true, force: true })
  })

  test('attempts=0 persists user_prompt_md + dedup_snapshot_ids_json + post-spawn fields', async () => {
    const memId = await seedGlobalApproved(db, 'always run typecheck before push')
    const row = await seedJobRow(db, 0)
    const job = rowToDistillJob(row)
    const runFn = fakeRun({ stderrTail: 'some warning' })
    await runDistill({
      store: memory.store,
      reviewedArtifacts: memory.reviewedArtifacts,
      job,
      siblings: [job],
      runFn,
    })
    const refreshed = (
      await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, job.id)).limit(1)
    )[0]!
    expect(refreshed.userPromptMd).not.toBeNull()
    expect(refreshed.userPromptMd!.length).toBeGreaterThan(0)
    expect(refreshed.dedupSnapshotIdsJson).not.toBeNull()
    const parsed = JSON.parse(refreshed.dedupSnapshotIdsJson!) as {
      snapshot: Array<{ memoryId: string }>
    }
    expect(parsed.snapshot.some((s) => s.memoryId === memId)).toBe(true)
    expect(refreshed.opencodeSessionId).toBe('sess-xyz')
    expect(refreshed.exitCode).toBe(0)
    expect(refreshed.stderrExcerpt).toBe('some warning')
  })

  test('attempts>0 leaves user_prompt_md untouched but still refreshes post-spawn columns', async () => {
    const row = await seedJobRow(db, 1)
    // Pretend attempt-0 already wrote the prompt
    await db
      .update(memoryDistillJobs)
      .set({ userPromptMd: 'ORIGINAL PROMPT', dedupSnapshotIdsJson: '{"snapshot":[]}' })
      .where(eq(memoryDistillJobs.id, row.id))

    const job = rowToDistillJob({ ...row, attempts: 1 })
    const runFn = fakeRun()
    await runDistill({
      store: memory.store,
      reviewedArtifacts: memory.reviewedArtifacts,
      job,
      siblings: [job],
      runFn,
    })
    const refreshed = (
      await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, job.id)).limit(1)
    )[0]!
    expect(refreshed.userPromptMd).toBe('ORIGINAL PROMPT')
    expect(refreshed.exitCode).toBe(0)
    // stderrExcerpt: empty string → null
    expect(refreshed.stderrExcerpt).toBeNull()
  })

  test('non-zero exitCode still throws but post-spawn columns + capture-attempt landed first', async () => {
    const row = await seedJobRow(db, 0)
    const job = rowToDistillJob(row)
    const runFn = fakeRun({
      status: 'exit-nonzero',
      exitCode: 1,
      stderrTail: 'fatal: distiller crashed',
      capturedSessionId: 'sess-fail',
    })
    await expect(
      runDistill({
        store: memory.store,
        reviewedArtifacts: memory.reviewedArtifacts,
        job,
        siblings: [job],
        runFn,
      }),
    ).rejects.toThrow(/exited with code 1/)
    const refreshed = (
      await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, job.id)).limit(1)
    )[0]!
    expect(refreshed.exitCode).toBe(1)
    expect(refreshed.opencodeSessionId).toBe('sess-fail')
    expect(refreshed.stderrExcerpt).toContain('fatal:')
  })

  // RFC-367 restated: this used to assert "no envelope + no session id → no
  // throw". That silence is exactly the defect the RFC removes (a job went
  // `done` with zero candidates and an empty last_error). With no session there
  // is nothing to re-ask either, so the run must fail after ONE round — while
  // still leaving the post-spawn columns behind for the detail page.
  test('missing sessionId → capture skipped, columns landed, and the run fails fast', async () => {
    const row = await seedJobRow(db, 0)
    const job = rowToDistillJob(row)
    const calls: SystemAgentRunOptions[] = []
    const base = fakeRun({ eventText: 'not an envelope at all' })
    const runFn: RunDistillOptions['runFn'] = async (opts) => {
      calls.push(opts)
      const result = await base!(opts)
      const { capturedSessionId: _dropped, ...withoutSession } = result
      return withoutSession as SystemAgentRunResult
    }
    await expect(
      runDistill({
        store: memory.store,
        reviewedArtifacts: memory.reviewedArtifacts,
        job,
        siblings: [job],
        runFn,
      }),
    ).rejects.toThrow(DistillerProtocolError)
    expect(calls).toHaveLength(1)
    const refreshed = (
      await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, job.id)).limit(1)
    )[0]!
    expect(refreshed.opencodeSessionId).toBeNull()
    expect(refreshed.exitCode).toBe(0)
  })
})

describe('runDistill RFC-043 capture extensions', () => {
  // RFC-367 retired `extractFirstSessionIdFromStdout`: the session id now comes
  // from `runSystemAgent`'s `capturedSessionId` (one owner for stdout parsing,
  // the executor's pump), so there is no hand-rolled scanner left to lock.
  test('clipAndRedactStderr behaves per contract', () => {
    expect(clipAndRedactStderr('', 100)).toBeNull()
    const safe = clipAndRedactStderr('plain text', 100)
    expect(safe).toBe('plain text')
    const long = clipAndRedactStderr('x'.repeat(5000), 1024)
    expect(long).toContain('truncated; original')
    expect(long!.length).toBeLessThan(5000)
    // Secrets in URLs get redacted.
    const redacted = clipAndRedactStderr(
      'clone https://user:secret@example.com/repo.git failed',
      1024,
    )
    expect(redacted).not.toContain('secret')
  })
})
