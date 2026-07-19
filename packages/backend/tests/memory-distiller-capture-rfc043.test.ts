// RFC-043 T3 — locks the new capture-side behaviour added to runDistill:
//   1. attempts === 0 path writes user_prompt_md + dedup_snapshot_ids_json
//   2. attempts > 0 path does NOT overwrite user_prompt_md (audit trail)
//   3. exit_code + stderr_excerpt + opencode_session_id always land on
//      the job row after spawn, regardless of exitCode
//   4. captureDistillJobSession is invoked iff sessionId is recovered
//      from stdout (and is swallowed on failure)
//   5. exit-code throw still propagates so the scheduler can record
//      last_error + back off

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memories, memoryDistillJobs } from '../src/db/schema'
import {
  clipAndRedactStderr,
  extractFirstSessionIdFromStdout,
  runDistill,
  type DistillerSpawnFn,
} from '../src/services/memoryDistiller'
import { rowToDistillJob } from '../src/services/memoryDistiller'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function emptyDistillerStdout(input: Parameters<DistillerSpawnFn>[0]): string {
  return `<workflow-output nonce="${input.envelopeNonce}"><port name="candidates">{"candidates":[]}</port></workflow-output>`
}

function seedJobRow(db: DbClient, attempts = 0) {
  const id = ulid()
  db.insert(memoryDistillJobs)
    .values({
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
    .run()
  return db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id)).get()!
}

function seedGlobalApproved(db: DbClient, title: string) {
  const id = ulid()
  db.insert(memories)
    .values({
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
    .run()
  return id
}

describe('runDistill RFC-043 capture extensions', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('attempts=0 persists user_prompt_md + dedup_snapshot_ids_json + post-spawn fields', async () => {
    const memId = seedGlobalApproved(db, 'always run typecheck before push')
    const row = seedJobRow(db, 0)
    const job = rowToDistillJob(row)
    const spawnFn: DistillerSpawnFn = async (input) => ({
      exitCode: 0,
      stdout: `{"sessionID":"sess-xyz","type":"step-start"}\n${emptyDistillerStdout(input)}`,
      stderr: 'some warning',
    })
    await runDistill({ db, job, siblings: [job], spawnFn })
    const refreshed = db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, job.id))
      .get()!
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
    const row = seedJobRow(db, 1)
    // Pretend attempt-0 already wrote the prompt
    db.update(memoryDistillJobs)
      .set({ userPromptMd: 'ORIGINAL PROMPT', dedupSnapshotIdsJson: '{"snapshot":[]}' })
      .where(eq(memoryDistillJobs.id, row.id))
      .run()
    const job = rowToDistillJob({ ...row, attempts: 1 })
    const spawnFn: DistillerSpawnFn = async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
    await runDistill({ db, job, siblings: [job], spawnFn })
    const refreshed = db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, job.id))
      .get()!
    expect(refreshed.userPromptMd).toBe('ORIGINAL PROMPT')
    expect(refreshed.exitCode).toBe(0)
    // stderrExcerpt: empty string → null
    expect(refreshed.stderrExcerpt).toBeNull()
  })

  test('non-zero exitCode still throws but post-spawn columns + capture-attempt landed first', async () => {
    const row = seedJobRow(db, 0)
    const job = rowToDistillJob(row)
    const spawnFn: DistillerSpawnFn = async () => ({
      exitCode: 1,
      stdout: '{"sessionID":"sess-fail"}\n',
      stderr: 'fatal: distiller crashed',
    })
    await expect(runDistill({ db, job, siblings: [job], spawnFn })).rejects.toThrow(
      /exited with code 1/,
    )
    const refreshed = db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, job.id))
      .get()!
    expect(refreshed.exitCode).toBe(1)
    expect(refreshed.opencodeSessionId).toBe('sess-fail')
    expect(refreshed.stderrExcerpt).toContain('fatal:')
  })

  test('missing sessionId → opencode_session_id stays null and capture is skipped (no throw)', async () => {
    const row = seedJobRow(db, 0)
    const job = rowToDistillJob(row)
    const spawnFn: DistillerSpawnFn = async () => ({
      exitCode: 0,
      stdout: 'not json at all',
      stderr: '',
    })
    await runDistill({ db, job, siblings: [job], spawnFn })
    const refreshed = db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.id, job.id))
      .get()!
    expect(refreshed.opencodeSessionId).toBeNull()
    expect(refreshed.exitCode).toBe(0)
  })

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
