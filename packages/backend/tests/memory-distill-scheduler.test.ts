// RFC-041 — distill scheduler tests (PR2 scope).
//
// Drives `distillTick` synchronously (no setInterval) with a deterministic
// `now` and a fake `spawnFn`. Locks: debounce_key construction, sibling
// merge, exp-backoff retry math, max-attempts flip to `failed`, recovery
// of leftover `running` rows.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  cachedRepos,
  clarifySessions,
  memoryDistillJobs,
  nodeRunEvents,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import {
  buildDebounceKey,
  cancelPendingJob,
  computeEligibleScopes,
  DISTILL_BACKOFF_BASE_MS,
  DISTILL_MAX_ATTEMPTS,
  distillTick,
  enqueueDistillJob,
  extractAgentNamesFromSnapshot,
  listDistillJobs,
  recoverRunning,
  retryFailedJob,
} from '../src/services/memoryDistillScheduler'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { DistillerSpawnFn } from '../src/services/memoryDistiller'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function emptyDistillerStdout(input: Parameters<DistillerSpawnFn>[0]): string {
  return `<workflow-output nonce="${input.envelopeNonce}"><port name="candidates">{"candidates":[]}</port></workflow-output>`
}

const EMPTY_ENVELOPE_SPAWN: DistillerSpawnFn = async (input) => ({
  exitCode: 0,
  stderr: '',
  stdout: emptyDistillerStdout(input),
})

function seedTask(
  db: DbClient,
  opts: { repoUrl?: string | null; cachedRepoId?: string | null; snapshotAgents?: string[] } = {},
): { taskId: string; workflowId: string } {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const snapshot = {
    nodes: (opts.snapshotAgents ?? []).map((name) => ({
      id: `n-${name}`,
      kind: 'agent-single',
      agentName: name,
    })),
  }
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 'fixture-task',
      workflowId: wfId,
      workflowSnapshot: JSON.stringify(snapshot),
      repoPath: '/tmp/wt',
      repoUrl: opts.repoUrl ?? null,
      cachedRepoId: opts.cachedRepoId ?? null,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { taskId, workflowId: wfId }
}

describe('buildDebounceKey', () => {
  test('task-scoped events collapse by (task, kind)', () => {
    expect(buildDebounceKey({ sourceKind: 'clarify', sourceEventId: 'e1', taskId: 't1' })).toBe(
      't1:clarify',
    )
    expect(buildDebounceKey({ sourceKind: 'review', sourceEventId: 'e2', taskId: 't1' })).toBe(
      't1:review',
    )
  })
  test('task-less events become unique per source event', () => {
    expect(buildDebounceKey({ sourceKind: 'feedback', sourceEventId: 'e1', taskId: null })).toBe(
      'noTask:feedback:e1',
    )
  })
})

describe('extractAgentNamesFromSnapshot', () => {
  test('returns unique agent names from agent-single nodes (RFC-060 PR-E removed agent-multi)', () => {
    const snap = JSON.stringify({
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'codegen' },
        { id: 'b', kind: 'agent-single', agentName: 'auditor' },
        { id: 'c', kind: 'wrapper-git' },
        { id: 'd', kind: 'agent-single', agentName: 'codegen' }, // dup → squashed
      ],
    })
    expect(extractAgentNamesFromSnapshot(snap).sort()).toEqual(['auditor', 'codegen'])
  })
  test('malformed JSON → []', () => {
    expect(extractAgentNamesFromSnapshot('{not-json')).toEqual([])
  })
  test('empty nodes → []', () => {
    expect(extractAgentNamesFromSnapshot(JSON.stringify({ nodes: [] }))).toEqual([])
  })
})

describe('computeEligibleScopes', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })
  test('null taskId → empty agentIds + workflowId=null + includeGlobal=true', async () => {
    const r = await computeEligibleScopes(db, null)
    expect(r).toEqual({ agentIds: [], workflowId: null, repoId: null, includeGlobal: true })
  })
  test('resolves workflowId + agentIds by name lookup', async () => {
    db.insert(agents)
      .values({
        id: 'agent-codegen',
        name: 'codegen',
        description: '',
        outputs: '[]',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatterExtra: '{}',
      })
      .run()
    const { taskId, workflowId } = seedTask(db, { snapshotAgents: ['codegen', 'no-such-agent'] })
    const r = await computeEligibleScopes(db, taskId)
    expect(r.workflowId).toBe(workflowId)
    expect(r.agentIds).toEqual(['agent-codegen']) // unknown agent silently dropped
    expect(r.includeGlobal).toBe(true)
  })
  // RFC-204: resolves through tasks.cached_repo_id. The previous URL join
  // compared a redacted tasks.repo_url against the plaintext cached_repos.url,
  // so private repos never matched (and once the credential column is blanked it
  // would have matched arbitrary rows on '').
  test('resolves repoId via tasks.cached_repo_id', async () => {
    db.insert(cachedRepos)
      .values({
        id: 'cr-1',
        urlHash: 'aabbccdd',
        url: 'https://github.com/acme/web.git',
        localPath: '/tmp/r',
        lastFetchedAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    const { taskId } = seedTask(db, {
      repoUrl: 'https://github.com/acme/web.git',
      cachedRepoId: 'cr-1',
    })
    const r = await computeEligibleScopes(db, taskId)
    expect(r.repoId).toBe('cr-1')
  })

  test('a task with no cached mirror resolves to no repo scope', async () => {
    const { taskId } = seedTask(db, { repoUrl: 'https://github.com/acme/web.git' })
    const r = await computeEligibleScopes(db, taskId)
    expect(r.repoId).toBeNull()
  })
})

describe('enqueueDistillJob', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })
  test('writes a pending row with next_run_at = now + 5s + correct debounce key', async () => {
    const { taskId } = seedTask(db)
    const before = Date.now()
    const r = await enqueueDistillJob(db, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
    })
    expect(r.debounceKey).toBe(`${taskId}:clarify`)
    expect(r.nextRunAt).toBeGreaterThanOrEqual(before + 5_000 - 50)
    const rows = db.select().from(memoryDistillJobs).all()
    expect(rows.length).toBe(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.attempts).toBe(0)
  })
  test('respects debounceMs override (used by tests + manual control)', async () => {
    const before = Date.now()
    const r = await enqueueDistillJob(db, {
      sourceKind: 'feedback',
      sourceEventId: 'f1',
      taskId: null,
      debounceMs: 0,
    })
    expect(r.nextRunAt).toBeLessThanOrEqual(before + 50)
  })
})

describe('distillTick', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('idle: no pending due rows → no-op', async () => {
    const r = await distillTick({ db, spawnFn: EMPTY_ENVELOPE_SPAWN })
    expect(r).toEqual({ picked: 0, succeeded: 0, failed: 0, candidatesCreated: 0 })
  })

  test('happy path: one row due → status flips to done', async () => {
    const { taskId } = seedTask(db)
    await enqueueDistillJob(db, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 0,
    })
    const r = await distillTick({ db, spawnFn: EMPTY_ENVELOPE_SPAWN })
    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(0)
    expect(r.candidatesCreated).toBe(0)
    const row = db.select().from(memoryDistillJobs).all()[0]!
    expect(row.status).toBe('done')
    expect(row.finishedAt).not.toBeNull()
  })

  test('debounce: 3 pending rows on same key → one merged distill run', async () => {
    const { taskId } = seedTask(db)
    for (const e of ['c1', 'c2', 'c3']) {
      await enqueueDistillJob(db, {
        sourceKind: 'clarify',
        sourceEventId: e,
        taskId,
        debounceMs: 0,
      })
    }
    let spawnCalls = 0
    const spawnFn: DistillerSpawnFn = async (input) => {
      spawnCalls += 1
      return {
        exitCode: 0,
        stderr: '',
        stdout: emptyDistillerStdout(input),
      }
    }
    const r = await distillTick({ db, spawnFn })
    expect(spawnCalls).toBe(1)
    expect(r.succeeded).toBe(1)
    const rows = db.select().from(memoryDistillJobs).all()
    for (const row of rows) expect(row.status).toBe('done')
  })

  test('failure: attempt 1 / 2 → pending with exp backoff, attempt 3 → failed', async () => {
    const { taskId } = seedTask(db)
    await enqueueDistillJob(db, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 0,
    })
    const explodeSpawn: DistillerSpawnFn = async () => {
      throw new Error('boom')
    }

    // Tick clock starts just after enqueue's stored next_run_at so the row
    // is immediately due. Each subsequent attempt jumps to the new
    // backoff-shifted next_run_at.
    let now = Date.now() + 1
    await distillTick({ db, spawnFn: explodeSpawn, now: () => now })
    let row = db.select().from(memoryDistillJobs).all()[0]!
    expect(row.attempts).toBe(1)
    expect(row.status).toBe('pending')
    expect(row.nextRunAt).toBeGreaterThanOrEqual(now + DISTILL_BACKOFF_BASE_MS - 50)

    // Attempt 2 — pump time past backoff.
    now = row.nextRunAt + 1
    await distillTick({ db, spawnFn: explodeSpawn, now: () => now })
    row = db.select().from(memoryDistillJobs).all()[0]!
    expect(row.attempts).toBe(2)
    expect(row.status).toBe('pending')

    // Attempt 3 = max — flip to failed.
    now = row.nextRunAt + 1
    await distillTick({ db, spawnFn: explodeSpawn, now: () => now })
    row = db.select().from(memoryDistillJobs).all()[0]!
    expect(row.attempts).toBe(DISTILL_MAX_ATTEMPTS)
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain('boom')
  })

  test('honors DISTILL_BATCH_LIMIT (≤ 5 distinct debounce keys per tick)', async () => {
    // 6 distinct tasks → 6 distinct keys; only 5 should execute.
    for (let i = 0; i < 6; i++) {
      const { taskId } = seedTask(db)
      await enqueueDistillJob(db, {
        sourceKind: 'clarify',
        sourceEventId: 'c' + i,
        taskId,
        debounceMs: 0,
      })
    }
    let calls = 0
    const r = await distillTick({
      db,
      spawnFn: async (input) => {
        calls += 1
        return {
          exitCode: 0,
          stderr: '',
          stdout: emptyDistillerStdout(input),
        }
      },
    })
    expect(calls).toBe(5)
    expect(r.picked).toBeLessThanOrEqual(5)
  })

  test('not yet due: tick at t < next_run_at → no pick', async () => {
    const { taskId } = seedTask(db)
    await enqueueDistillJob(db, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 60_000, // due 1 min in the future
    })
    const r = await distillTick({ db, spawnFn: EMPTY_ENVELOPE_SPAWN, now: () => Date.now() })
    expect(r.picked).toBe(0)
  })

  test('RFC-044: sourceContextBudget = {0,0} is plumbed through to user prompt', async () => {
    // End-to-end check: scheduler → runDistill → buildDistillerUserPrompt.
    // When the scheduler hands sourceContextBudget = {0, 0} down the stack,
    // the resulting user prompt must NOT contain the new block headers.
    // This locks the wiring so a missed argument silently disabling the
    // feature does not slip past tests.
    const { taskId } = seedTask(db)
    // Seed an actual clarify_session with a source-agent node_run + events so
    // the loader path runs end-to-end (rather than the empty-clarify branch).
    const sourceRunId = ulid()
    db.insert(nodeRuns)
      .values({
        id: sourceRunId,
        taskId,
        nodeId: 'agent-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        status: 'awaiting_human',
        promptText: 'hi',
        startedAt: Date.now(),
        opencodeSessionId: 'sess-1',
      })
      .run()
    const clarifyRunId = ulid()
    db.insert(nodeRuns)
      .values({
        id: clarifyRunId,
        taskId,
        nodeId: 'clarify-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        status: 'awaiting_human',
      })
      .run()
    const clarifyId = ulid()
    db.insert(clarifySessions)
      .values({
        id: clarifyId,
        taskId,
        sourceAgentNodeId: 'agent-1',
        sourceAgentNodeRunId: sourceRunId,
        sourceShardKey: null,
        clarifyNodeId: 'clarify-1',
        clarifyNodeRunId: clarifyRunId,
        iterationIndex: 0,
        questionsJson: '[]',
        answersJson: '[]',
        status: 'answered',
      })
      .run()
    db.insert(nodeRunEvents)
      .values({
        nodeRunId: sourceRunId,
        ts: 1,
        kind: 'text',
        payload: JSON.stringify({
          type: 'text',
          sessionID: 'sess-1',
          messageID: 'm1',
          part: { type: 'text', text: 'PLUMBING-MARKER' },
        }),
        sessionId: 'sess-1',
        parentSessionId: null,
      })
      .run()

    await enqueueDistillJob(db, {
      sourceKind: 'clarify',
      sourceEventId: clarifyId,
      taskId,
      debounceMs: 0,
    })

    let capturedPrompt: string | null = null
    const captureSpawn: DistillerSpawnFn = async (input) => {
      capturedPrompt = input.userPrompt
      return {
        exitCode: 0,
        stderr: '',
        stdout: emptyDistillerStdout(input),
      }
    }
    await distillTick({
      db,
      spawnFn: captureSpawn,
      sourceContextBudget: { clarifyTranscriptMaxBytes: 0, reviewBodyMaxBytes: 0 },
    })
    expect(capturedPrompt).not.toBeNull()
    expect(capturedPrompt!).not.toContain('Source agent transcript:')
    expect(capturedPrompt!).not.toContain('PLUMBING-MARKER')

    // Counter-check: with default budget the marker IS visible. Resetting
    // the job state to pending re-runs the same source event.
    await db
      .update(memoryDistillJobs)
      .set({ status: 'pending', attempts: 0, nextRunAt: Date.now() - 1 })
      .run()
    capturedPrompt = null
    await distillTick({ db, spawnFn: captureSpawn })
    expect(capturedPrompt!).toContain('Source agent transcript:')
    expect(capturedPrompt!).toContain('PLUMBING-MARKER')
  })
})

describe('recoverRunning + manual control', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('recoverRunning flips leftover running rows back to pending', async () => {
    const { taskId } = seedTask(db)
    await enqueueDistillJob(db, {
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId,
      debounceMs: 0,
    })
    await db.update(memoryDistillJobs).set({ status: 'running' })
    const r = await recoverRunning(db)
    expect(r.recovered).toBe(1)
    const row = db.select().from(memoryDistillJobs).all()[0]!
    expect(row.status).toBe('pending')
  })

  test('retryFailedJob: failed → pending with attempts reset to 0', async () => {
    const id = ulid()
    db.insert(memoryDistillJobs)
      .values({
        id,
        debounceKey: 'k',
        sourceKind: 'clarify',
        sourceEventId: 'c1',
        taskId: null,
        scopeResolvedJson: '{}',
        status: 'failed',
        attempts: 3,
        nextRunAt: Date.now(),
        lastError: 'old',
        createdAt: Date.now(),
      })
      .run()
    expect(await retryFailedJob(db, id)).toBe(true)
    const row = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id)).all()[0]!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    expect(row.lastError).toBeNull()
  })

  test('retryFailedJob rejects non-failed rows', async () => {
    const id = ulid()
    db.insert(memoryDistillJobs)
      .values({
        id,
        debounceKey: 'k',
        sourceKind: 'clarify',
        sourceEventId: 'c1',
        taskId: null,
        scopeResolvedJson: '{}',
        status: 'pending',
        attempts: 0,
        nextRunAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    expect(await retryFailedJob(db, id)).toBe(false)
  })

  test('cancelPendingJob: pending → canceled', async () => {
    const id = ulid()
    db.insert(memoryDistillJobs)
      .values({
        id,
        debounceKey: 'k',
        sourceKind: 'clarify',
        sourceEventId: 'c1',
        taskId: null,
        scopeResolvedJson: '{}',
        status: 'pending',
        attempts: 0,
        nextRunAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    expect(await cancelPendingJob(db, id)).toBe(true)
    const row = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, id)).all()[0]!
    expect(row.status).toBe('canceled')
  })

  test('listDistillJobs filters by status', async () => {
    db.insert(memoryDistillJobs)
      .values({
        id: 'a',
        debounceKey: 'k',
        sourceKind: 'clarify',
        sourceEventId: 'c1',
        taskId: null,
        scopeResolvedJson: '{}',
        status: 'pending',
        attempts: 0,
        nextRunAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    db.insert(memoryDistillJobs)
      .values({
        id: 'b',
        debounceKey: 'k',
        sourceKind: 'review',
        sourceEventId: 'r1',
        taskId: null,
        scopeResolvedJson: '{}',
        status: 'failed',
        attempts: 3,
        nextRunAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    expect((await listDistillJobs(db, { status: 'failed' })).length).toBe(1)
    expect((await listDistillJobs(db, {})).length).toBe(2)
  })
})
