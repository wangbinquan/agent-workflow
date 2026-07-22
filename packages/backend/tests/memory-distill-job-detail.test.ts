// RFC-043 T4 — getDistillJobDetail aggregator unit tests.

import { beforeEach, describe, expect, test } from 'bun:test'
import { insertClarifyRoundRaw } from './clarify-fixtures'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  docVersions,
  memories,
  memoryDistillJobs,
  nodeRuns,
  taskFeedback,
  tasks,
  workflows,
} from '../src/db/schema'
import {
  getDistillJobDetail,
  parseDedupSnapshot,
  summarizeClarifyQuestions,
} from '../src/services/memoryDistillJobDetail'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTaskWithReviewRun(db: DbClient): { taskId: string; nodeRunId: string } {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: '{}',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/r',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'b',
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  const nodeRunId = ulid()
  db.insert(nodeRuns)
    .values({
      id: nodeRunId,
      taskId,
      nodeId: 'r1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
    })
    .run()
  return { taskId, nodeRunId }
}

function seedJob(
  db: DbClient,
  overrides: Partial<typeof memoryDistillJobs.$inferInsert> = {},
): string {
  const id = ulid()
  db.insert(memoryDistillJobs)
    .values({
      id,
      debounceKey: 'k1',
      sourceKind: 'feedback',
      sourceEventId: 'tf-1',
      taskId: null,
      scopeResolvedJson: '{"agentIds":[],"workflowId":null,"repoId":null,"includeGlobal":true}',
      status: 'done',
      attempts: 0,
      nextRunAt: Date.now(),
      createdAt: Date.now(),
      ...overrides,
    })
    .run()
  return id
}

describe('getDistillJobDetail', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('404 when jobId does not exist', async () => {
    await expect(getDistillJobDetail(db, 'nope')).rejects.toThrow(/not found/)
  })

  test('happy path: returns job + siblings + sourceEvents + candidates + dedupSnapshot', async () => {
    const taskId = ulid()
    db.insert(workflows)
      .values({
        id: ulid(),
        name: 'w',
        definition: '{}',
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    db.insert(tasks)
      .values({
        id: taskId,
        name: 't',
        workflowId: db.select().from(workflows).all()[0]!.id,
        workflowSnapshot: '{}',
        repoPath: '/tmp/r',
        worktreePath: '/tmp/wt',
        baseBranch: 'main',
        branch: 'b',
        baseCommit: null,
        status: 'pending',
        inputs: '{}',
        startedAt: Date.now(),
      })
      .run()
    const feedbackId = ulid()
    db.insert(taskFeedback)
      .values({
        id: feedbackId,
        taskId,
        authorUserId: null,
        bodyMd: 'always typecheck before push',
        createdAt: Date.now(),
        distilled: 1,
        distillJobId: null,
      })
      .run()
    const jobId = seedJob(db, {
      sourceEventId: feedbackId,
      taskId,
      userPromptMd: 'prompt',
      dedupSnapshotIdsJson: JSON.stringify({
        snapshot: [{ memoryId: 'm-old', scopeType: 'global', scopeId: null, title: 'old memory' }],
      }),
      opencodeSessionId: 'sess-1',
      exitCode: 0,
      stderrExcerpt: 'note',
    })
    // Candidate memory produced by this job
    db.insert(memories)
      .values({
        id: ulid(),
        scopeType: 'global',
        scopeId: null,
        title: 'new rule',
        bodyMd: 'always run typecheck',
        tags: '[]',
        status: 'candidate',
        sourceKind: 'feedback',
        sourceEventId: feedbackId,
        sourceTaskId: taskId,
        distillJobId: jobId,
        distillAction: 'new',
        createdAt: Date.now(),
        version: 1,
      })
      .run()

    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.job.id).toBe(jobId)
    expect(detail.job.opencodeSessionId).toBe('sess-1')
    expect(detail.job.userPromptMd).toBe('prompt')
    expect(detail.job.stderrExcerpt).toBe('note')
    expect(detail.siblings).toHaveLength(1)
    expect(detail.sourceEvents).toHaveLength(1)
    expect(detail.sourceEvents[0]?.kind).toBe('feedback')
    expect(detail.sourceEvents[0]?.deletedOrMissing).toBe(false)
    expect(detail.sourceEvents[0]?.summary).toContain('typecheck')
    expect(detail.dedupSnapshot).toHaveLength(1)
    expect(detail.dedupSnapshot[0]?.memoryId).toBe('m-old')
    expect(detail.candidates).toHaveLength(1)
    expect(detail.candidates[0]?.title).toBe('new rule')
    expect(detail.candidates[0]?.distillAction).toBe('new')
  })

  test('sourceEvent row deleted between distill and detail load → deletedOrMissing=true', async () => {
    const jobId = seedJob(db, { sourceEventId: 'never-existed', taskId: null })
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.sourceEvents).toHaveLength(1)
    expect(detail.sourceEvents[0]?.deletedOrMissing).toBe(true)
    expect(detail.sourceEvents[0]?.summary).toBe('')
  })

  test('legacy job (NULL dedup_snapshot_ids_json) yields empty snapshot, no throw', async () => {
    const jobId = seedJob(db, { dedupSnapshotIdsJson: null })
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.dedupSnapshot).toHaveLength(0)
  })

  test('multiple siblings sharing a debounce_key are all listed', async () => {
    const a = seedJob(db, { debounceKey: 'shared', sourceEventId: 'a' })
    seedJob(db, { debounceKey: 'shared', sourceEventId: 'b' })
    seedJob(db, { debounceKey: 'shared', sourceEventId: 'c' })
    const detail = await getDistillJobDetail(db, a)
    expect(detail.siblings).toHaveLength(3)
    expect(detail.sourceEvents).toHaveLength(3)
  })

  test('clarify source event resolves to its first question title', async () => {
    const { taskId, nodeRunId } = seedTaskWithReviewRun(db)
    const sessId = ulid()
    await insertClarifyRoundRaw(db, {
      kind: 'self' as const,
      id: sessId,
      taskId,
      askingNodeId: 'src',
      askingNodeRunId: nodeRunId,
      askingShardKey: null,
      intermediaryNodeId: 'c1',
      intermediaryNodeRunId: nodeRunId,
      iteration: 0,
      questionsJson: JSON.stringify([
        { id: 'q1', title: 'Which framework should we use?', kind: 'single', options: [] },
      ]),
      answersJson: null,
      status: 'awaiting_human',
    })
    const jobId = seedJob(db, {
      sourceKind: 'clarify',
      sourceEventId: sessId,
      taskId,
    })
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.sourceEvents[0]?.kind).toBe('clarify')
    expect(detail.sourceEvents[0]?.summary).toBe('Which framework should we use?')
    expect(detail.sourceEvents[0]?.deepLink).toBe(`/clarify/${sessId}`)
  })

  test('review source event resolves to decision + version label', async () => {
    const { taskId, nodeRunId } = seedTaskWithReviewRun(db)
    const dvId = ulid()
    db.insert(docVersions)
      .values({
        id: dvId,
        taskId,
        reviewNodeId: 'r1',
        reviewNodeRunId: nodeRunId,
        sourceNodeId: 'a1',
        sourcePortName: 'output',
        versionIndex: 2,
        reviewIteration: 0,
        bodyPath: 'doc.md',
        commentsJson: '[]',
        decision: 'approved',
        decisionReason: null,
        createdAt: Date.now(),
      })
      .run()
    const jobId = seedJob(db, {
      sourceKind: 'review',
      sourceEventId: dvId,
      taskId,
    })
    const detail = await getDistillJobDetail(db, jobId)
    expect(detail.sourceEvents[0]?.summary).toBe('approved · v2')
    expect(detail.sourceEvents[0]?.deepLink).toBe(`/reviews/${dvId}`)
  })

  test('parseDedupSnapshot is defensive against malformed JSON / wrong shape', () => {
    expect(parseDedupSnapshot(null)).toEqual([])
    expect(parseDedupSnapshot('')).toEqual([])
    expect(parseDedupSnapshot('not-json')).toEqual([])
    expect(parseDedupSnapshot('{"snapshot":"not-an-array"}')).toEqual([])
    expect(
      parseDedupSnapshot(JSON.stringify({ snapshot: [{ memoryId: 'a' /* missing fields */ }] })),
    ).toEqual([])
    const ok = parseDedupSnapshot(
      JSON.stringify({
        snapshot: [
          { memoryId: 'm1', scopeType: 'global', scopeId: null, title: 'ok' },
          { memoryId: 'm2', scopeType: 'agent', scopeId: 'a1', title: 'ok2' },
        ],
      }),
    )
    expect(ok).toHaveLength(2)
    expect(ok[1]?.scopeType).toBe('agent')
  })

  test('summarizeClarifyQuestions clips to 200 chars and handles bad input', () => {
    const long = 'x'.repeat(400)
    const out = summarizeClarifyQuestions(JSON.stringify([{ title: long }]))
    expect(out.length).toBe(200)
    expect(summarizeClarifyQuestions('not-json')).toBe('')
    expect(summarizeClarifyQuestions('[]')).toBe('')
  })
})
