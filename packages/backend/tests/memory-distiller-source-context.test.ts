// RFC-044 — distiller source-context loader + builder unit tests.
//
// What we lock here:
//   1. loadSourceEvents now pulls the source-agent transcript for clarify
//      rows (via clarify_sessions.source_agent_node_run_id → node_run_events
//      → parseSessionTree → markdown render → byte-clip) and the reviewed
//      document body for review rows (Bun.file(bodyPath).text() → byte-clip).
//   2. Missing source data degrades to a (null, reason) pair so the builder
//      can render a placeholder line — distill never fails on these.
//   3. buildDistillerUserPrompt emits two new blocks ("Source agent
//      transcript:" / "Reviewed document body:") when budget > 0 and skips
//      them when budget === 0 (RFC-041 parity).
//
// The two literal strings above are grep-locked by
// `memory-distiller.test.ts` so this file is free to focus on behaviour.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { insertClarifyRoundRaw } from './clarify-fixtures'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { docVersions, nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildDistillerUserPrompt,
  loadSourceEvents,
  rowToDistillJob,
} from '../src/services/memoryDistiller'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Seeded {
  taskId: string
  workflowId: string
}

function seedTask(db: DbClient): Seeded {
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
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { taskId, workflowId: wfId }
}

function seedSourceAgentNodeRun(
  db: DbClient,
  taskId: string,
  opts: { promptText?: string; opencodeSessionId?: string | null; startedAt?: number } = {},
): string {
  const id = ulid()
  db.insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_human',
      promptText: opts.promptText ?? 'Please make the change',
      startedAt: opts.startedAt ?? Date.now(),
      opencodeSessionId: opts.opencodeSessionId ?? 'sess-abc',
    })
    .run()
  return id
}

async function seedClarifySession(
  db: DbClient,
  taskId: string,
  sourceRunId: string,
): Promise<{ clarifyId: string; clarifyRunId: string }> {
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
  await insertClarifyRoundRaw(db, {
    kind: 'self' as const,
    id: clarifyId,
    taskId,
    askingNodeId: 'agent-1',
    askingNodeRunId: sourceRunId,
    askingShardKey: null,
    intermediaryNodeId: 'clarify-1',
    intermediaryNodeRunId: clarifyRunId,
    iteration: 0,
    questionsJson: JSON.stringify([{ id: 'q1', kind: 'open', text: 'which db?' }]),
    answersJson: JSON.stringify([{ questionId: 'q1', text: 'postgres' }]),
    status: 'answered',
  })
  return { clarifyId, clarifyRunId }
}

function insertTextEvent(
  db: DbClient,
  nodeRunId: string,
  ts: number,
  text: string,
  sessionId = 'sess-abc',
): void {
  db.insert(nodeRunEvents)
    .values({
      nodeRunId,
      ts,
      kind: 'text',
      payload: JSON.stringify({
        type: 'text',
        sessionID: sessionId,
        messageID: `msg-${ts}`,
        part: { type: 'text', text },
      }),
      sessionId,
      parentSessionId: null,
    })
    .run()
}

function mkClarifyJob(taskId: string, clarifyId: string) {
  return rowToDistillJob({
    id: ulid(),
    debounceKey: `${taskId}:clarify`,
    sourceKind: 'clarify',
    sourceEventId: clarifyId,
    taskId,
    scopeResolvedJson: JSON.stringify({
      agentIds: [],
      workflowId: null,
      repoId: null,
      includeGlobal: true,
    }),
    status: 'pending',
    attempts: 0,
    nextRunAt: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  })
}

function mkReviewJob(taskId: string, reviewId: string) {
  return rowToDistillJob({
    id: ulid(),
    debounceKey: `${taskId}:review`,
    sourceKind: 'review',
    sourceEventId: reviewId,
    taskId,
    scopeResolvedJson: JSON.stringify({
      agentIds: [],
      workflowId: null,
      repoId: null,
      includeGlobal: true,
    }),
    status: 'pending',
    attempts: 0,
    nextRunAt: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  })
}

describe('loadSourceEvents — clarify transcript', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('renders source-agent transcript when events exist', async () => {
    const { taskId } = seedTask(db)
    const sourceRunId = seedSourceAgentNodeRun(db, taskId, {
      promptText: 'Add a hello endpoint',
    })
    const { clarifyId } = await seedClarifySession(db, taskId, sourceRunId)
    insertTextEvent(db, sourceRunId, 1, 'I will start by reading the routes.')
    insertTextEvent(db, sourceRunId, 2, 'Should the endpoint live in /api/hello?')

    const loaded = await loadSourceEvents(db, [mkClarifyJob(taskId, clarifyId)])
    expect(loaded.clarify.length).toBe(1)
    const c = loaded.clarify[0]!
    expect(c.sourceTranscriptMd).not.toBeNull()
    expect(c.sourceTranscriptReason).toBeNull()
    expect(c.sourceTranscriptMd).toContain('**Assistant**')
    expect(c.sourceTranscriptMd).toContain('reading the routes')
  })

  test('returns null + reason when source node_run does not exist', async () => {
    const { taskId } = seedTask(db)
    // Insert a clarify row that points to a node_run id we never seed.
    const orphanRunId = ulid()
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
    await insertClarifyRoundRaw(db, {
      kind: 'self' as const,
      id: clarifyId,
      taskId,
      askingNodeId: 'agent-x',
      askingNodeRunId: orphanRunId,
      askingShardKey: null,
      intermediaryNodeId: 'clarify-1',
      intermediaryNodeRunId: clarifyRunId,
      iteration: 0,
      questionsJson: '[]',
      answersJson: '[]',
      status: 'answered',
      createdAt: Date.now(),
    })
    // RFC-217 T8：clarify_rounds 对 asking_node_run_id 有 FK（遗留表没有），
    // 夹具会自动补 run 桩——要驱动「源 run 行缺失」的防御分支，插完 round 后
    // 关 FK 删掉桩，构造出 FK 之外才可能出现的孤儿 round。
    db.run(sql`PRAGMA foreign_keys = OFF`)
    db.delete(nodeRuns).where(eq(nodeRuns.id, orphanRunId)).run()
    db.run(sql`PRAGMA foreign_keys = ON`)
    const loaded = await loadSourceEvents(db, [mkClarifyJob(taskId, clarifyId)])
    const c = loaded.clarify[0]!
    expect(c.sourceTranscriptMd).toBeNull()
    expect(c.sourceTranscriptReason).toContain('not found')
  })

  test('returns null + reason when source node_run has no events', async () => {
    const { taskId } = seedTask(db)
    const sourceRunId = seedSourceAgentNodeRun(db, taskId)
    const { clarifyId } = await seedClarifySession(db, taskId, sourceRunId)
    // intentionally no events
    const loaded = await loadSourceEvents(db, [mkClarifyJob(taskId, clarifyId)])
    const c = loaded.clarify[0]!
    expect(c.sourceTranscriptMd).toBeNull()
    expect(c.sourceTranscriptReason).toContain('no events')
  })

  test('byte-clips transcript larger than budget with truncated marker', async () => {
    const { taskId } = seedTask(db)
    const sourceRunId = seedSourceAgentNodeRun(db, taskId)
    const { clarifyId } = await seedClarifySession(db, taskId, sourceRunId)
    const longChunk = 'x'.repeat(8000)
    insertTextEvent(db, sourceRunId, 1, longChunk)
    insertTextEvent(db, sourceRunId, 2, longChunk)
    insertTextEvent(db, sourceRunId, 3, longChunk)

    const loaded = await loadSourceEvents(db, [mkClarifyJob(taskId, clarifyId)], {
      clarifyTranscriptMaxBytes: 2048,
      reviewBodyMaxBytes: 16384,
    })
    const c = loaded.clarify[0]!
    expect(c.sourceTranscriptMd).not.toBeNull()
    expect(c.sourceTranscriptMd).toContain('[truncated ')
    const byteLen = Buffer.from(c.sourceTranscriptMd!, 'utf8').byteLength
    expect(byteLen).toBeLessThan(2200) // budget + small marker overhead
  })

  test('budget.clarifyTranscriptMaxBytes=0 disables clarify transcript', async () => {
    const { taskId } = seedTask(db)
    const sourceRunId = seedSourceAgentNodeRun(db, taskId)
    const { clarifyId } = await seedClarifySession(db, taskId, sourceRunId)
    insertTextEvent(db, sourceRunId, 1, 'something the model said')
    const loaded = await loadSourceEvents(db, [mkClarifyJob(taskId, clarifyId)], {
      clarifyTranscriptMaxBytes: 0,
      reviewBodyMaxBytes: 16384,
    })
    const c = loaded.clarify[0]!
    expect(c.sourceTranscriptMd).toBeNull()
    expect(c.sourceTranscriptReason).toBe('disabled by config')
  })
})

describe('loadSourceEvents — review body', () => {
  let db: DbClient
  let prevHome: string | undefined
  let tmpHome: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
    tmpHome = mkdtempSync(join(tmpdir(), 'rfc044-'))
    prevHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = tmpHome
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = prevHome
  })

  function seedReview(taskId: string, body: string | null, relPath = 'docs/v1.md'): string {
    const reviewRunId = ulid()
    db.insert(nodeRuns)
      .values({
        id: reviewRunId,
        taskId,
        nodeId: 'review-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        status: 'done',
      })
      .run()
    const dvId = ulid()
    db.insert(docVersions)
      .values({
        id: dvId,
        taskId,
        reviewNodeId: 'review-1',
        reviewNodeRunId: reviewRunId,
        sourceNodeId: 'agent-1',
        sourcePortName: 'design',
        versionIndex: 1,
        reviewIteration: 0,
        bodyPath: relPath,
        commentsJson: '[]',
        decision: 'approved',
        createdAt: Date.now(),
        decidedAt: Date.now(),
      })
      .run()
    if (body !== null) {
      const absPath = join(tmpHome, relPath)
      mkdirSync(join(tmpHome, 'docs'), { recursive: true })
      writeFileSync(absPath, body)
    }
    return dvId
  }

  test('reads body file when present', async () => {
    const { taskId } = seedTask(db)
    const dvId = seedReview(taskId, '# Hello\n\nworld')
    const loaded = await loadSourceEvents(db, [mkReviewJob(taskId, dvId)])
    const r = loaded.review[0]!
    expect(r.reviewedBodyMd).toBe('# Hello\n\nworld')
    expect(r.reviewedBodyReason).toBeNull()
  })

  test('falls back to null + reason when body file is missing', async () => {
    const { taskId } = seedTask(db)
    const dvId = seedReview(taskId, null, 'docs/missing.md')
    const loaded = await loadSourceEvents(db, [mkReviewJob(taskId, dvId)])
    const r = loaded.review[0]!
    expect(r.reviewedBodyMd).toBeNull()
    expect(r.reviewedBodyReason).toContain('unreadable')
  })

  test('byte-clips oversize body with truncated marker', async () => {
    const { taskId } = seedTask(db)
    const big = 'a'.repeat(32 * 1024)
    const dvId = seedReview(taskId, big)
    const loaded = await loadSourceEvents(db, [mkReviewJob(taskId, dvId)], {
      clarifyTranscriptMaxBytes: 16384,
      reviewBodyMaxBytes: 4096,
    })
    const r = loaded.review[0]!
    expect(r.reviewedBodyMd).not.toBeNull()
    expect(r.reviewedBodyMd).toContain('[truncated ')
    expect(Buffer.from(r.reviewedBodyMd!, 'utf8').byteLength).toBeLessThan(4200)
  })

  test('budget.reviewBodyMaxBytes=0 disables review body', async () => {
    const { taskId } = seedTask(db)
    const dvId = seedReview(taskId, 'doc body present')
    const loaded = await loadSourceEvents(db, [mkReviewJob(taskId, dvId)], {
      clarifyTranscriptMaxBytes: 16384,
      reviewBodyMaxBytes: 0,
    })
    const r = loaded.review[0]!
    expect(r.reviewedBodyMd).toBeNull()
    expect(r.reviewedBodyReason).toBe('disabled by config')
  })
})

describe('buildDistillerUserPrompt — context blocks', () => {
  test('emits Source agent transcript: when budget > 0 and md present', () => {
    const prompt = buildDistillerUserPrompt({
      events: {
        clarify: [
          {
            id: 'c1',
            taskId: 't',
            nodeId: 'n',
            questions: '[]',
            answers: '[]',
            sourceTranscriptMd: '**Assistant**:\nI will help',
            sourceTranscriptReason: null,
          },
        ],
        review: [],
        feedback: [],
      },
      scopeContexts: [{ scopeType: 'global', scopeId: null, approved: [], tagPool: [] }],
      taskId: null,
    })
    expect(prompt).toContain('Source agent transcript:')
    expect(prompt).toContain('I will help')
  })

  test('emits Reviewed document body: when budget > 0 and md present', () => {
    const prompt = buildDistillerUserPrompt({
      events: {
        clarify: [],
        review: [
          {
            id: 'r1',
            taskId: 't',
            nodeId: 'rn',
            decision: 'approved',
            bodyPath: 'docs/v1.md',
            comments: [],
            reviewedBodyMd: '# RFC\n\nbody',
            reviewedBodyReason: null,
          },
        ],
        feedback: [],
      },
      scopeContexts: [{ scopeType: 'global', scopeId: null, approved: [], tagPool: [] }],
      taskId: null,
    })
    expect(prompt).toContain('Reviewed document body:')
    expect(prompt).toContain('# RFC')
  })

  test('renders unavailable placeholder when md is null', () => {
    const prompt = buildDistillerUserPrompt({
      events: {
        clarify: [
          {
            id: 'c1',
            taskId: 't',
            nodeId: 'n',
            questions: '[]',
            answers: '[]',
            sourceTranscriptMd: null,
            sourceTranscriptReason: 'source node_run not found',
          },
        ],
        review: [
          {
            id: 'r1',
            taskId: 't',
            nodeId: 'rn',
            decision: 'approved',
            bodyPath: 'docs/v1.md',
            comments: [],
            reviewedBodyMd: null,
            reviewedBodyReason: 'reviewed body unreadable: file missing',
          },
        ],
        feedback: [],
      },
      scopeContexts: [{ scopeType: 'global', scopeId: null, approved: [], tagPool: [] }],
      taskId: null,
    })
    expect(prompt).toContain('(source-agent transcript unavailable: source node_run not found)')
    expect(prompt).toContain('(reviewed body unavailable: reviewed body unreadable: file missing)')
  })

  test('budget=0 skips block entirely (RFC-041 parity)', () => {
    const prompt = buildDistillerUserPrompt({
      events: {
        clarify: [
          {
            id: 'c1',
            taskId: 't',
            nodeId: 'n',
            questions: '[]',
            answers: '[]',
            sourceTranscriptMd: 'should-not-appear',
            sourceTranscriptReason: null,
          },
        ],
        review: [
          {
            id: 'r1',
            taskId: 't',
            nodeId: 'rn',
            decision: 'approved',
            bodyPath: 'docs/v1.md',
            comments: [],
            reviewedBodyMd: 'should-also-not-appear',
            reviewedBodyReason: null,
          },
        ],
        feedback: [],
      },
      scopeContexts: [{ scopeType: 'global', scopeId: null, approved: [], tagPool: [] }],
      taskId: null,
      sourceContextBudget: { clarifyTranscriptMaxBytes: 0, reviewBodyMaxBytes: 0 },
    })
    expect(prompt).not.toContain('Source agent transcript:')
    expect(prompt).not.toContain('Reviewed document body:')
    expect(prompt).not.toContain('should-not-appear')
    expect(prompt).not.toContain('should-also-not-appear')
  })
})
