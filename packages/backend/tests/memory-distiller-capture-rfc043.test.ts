// RFC-043 T3 — locks the new capture-side behaviour added to runDistill:
//   1. attempts === 0 path writes user_prompt_md + dedup_snapshot_ids_json
//   2. attempts > 0 path does NOT overwrite user_prompt_md (audit trail)
//   3. exit_code + stderr_excerpt + opencode_session_id always land on
//      the job row after spawn, regardless of exitCode
//   4. captureDistillJobSession is invoked iff sessionId is recovered
//      from stdout (and is swallowed on failure)
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
  extractFirstSessionIdFromStdout,
  runDistill,
  type DistillerSpawnFn,
} from '../src/modules/memory/application/distill/memoryDistiller'
import { rowToDistillJob } from '../src/modules/memory/application/distill/memoryDistiller'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { DatabaseCommittedReviewArtifactReader } from '../src/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { createMemoryDistillSessionCapture } from '../src/modules/memory/infrastructure/memoryDistillSessionCapture'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'
import { appHome } from '../src/util/paths'
import { describeEachProvider } from './helpers/eachProvider'

function createMemoryDistillTestContext(db: ProviderNeutralDatabase) {
  return {
    store: new DrizzleMemoryDistillWorkStore(db, createMemoryDistillSessionCapture(db)),
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(db, appHome()),
  }
}

function emptyDistillerStdout(input: Parameters<DistillerSpawnFn>[0]): string {
  return `<workflow-output nonce="${input.envelopeNonce}"><port name="candidates">{"candidates":[]}</port></workflow-output>`
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
    const spawnFn: DistillerSpawnFn = async (input) => ({
      exitCode: 0,
      stdout: `{"sessionID":"sess-xyz","type":"step-start"}\n${emptyDistillerStdout(input)}`,
      stderr: 'some warning',
    })
    await runDistill({
      store: memory.store,
      reviewedArtifacts: memory.reviewedArtifacts,
      job,
      siblings: [job],
      spawnFn,
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
    const spawnFn: DistillerSpawnFn = async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
    await runDistill({
      store: memory.store,
      reviewedArtifacts: memory.reviewedArtifacts,
      job,
      siblings: [job],
      spawnFn,
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
    const spawnFn: DistillerSpawnFn = async () => ({
      exitCode: 1,
      stdout: '{"sessionID":"sess-fail"}\n',
      stderr: 'fatal: distiller crashed',
    })
    await expect(
      runDistill({
        store: memory.store,
        reviewedArtifacts: memory.reviewedArtifacts,
        job,
        siblings: [job],
        spawnFn,
      }),
    ).rejects.toThrow(/exited with code 1/)
    const refreshed = (
      await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, job.id)).limit(1)
    )[0]!
    expect(refreshed.exitCode).toBe(1)
    expect(refreshed.opencodeSessionId).toBe('sess-fail')
    expect(refreshed.stderrExcerpt).toContain('fatal:')
  })

  test('missing sessionId → opencode_session_id stays null and capture is skipped (no throw)', async () => {
    const row = await seedJobRow(db, 0)
    const job = rowToDistillJob(row)
    const spawnFn: DistillerSpawnFn = async () => ({
      exitCode: 0,
      stdout: 'not json at all',
      stderr: '',
    })
    await runDistill({
      store: memory.store,
      reviewedArtifacts: memory.reviewedArtifacts,
      job,
      siblings: [job],
      spawnFn,
    })
    const refreshed = (
      await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, job.id)).limit(1)
    )[0]!
    expect(refreshed.opencodeSessionId).toBeNull()
    expect(refreshed.exitCode).toBe(0)
  })
})

describe('runDistill RFC-043 capture extensions', () => {
  test('extractFirstSessionIdFromStdout & clipAndRedactStderr behave per contract', () => {
    expect(extractFirstSessionIdFromStdout('')).toBeNull()
    expect(extractFirstSessionIdFromStdout('not-json')).toBeNull()
    expect(extractFirstSessionIdFromStdout('{"sessionID":"first"}\n{"sessionID":"second"}\n')).toBe(
      'first',
    )
    expect(extractFirstSessionIdFromStdout('{"foo":1}\n{"sessionID":"x"}')).toBe('x')

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
