// RFC-053 PR-A T1g — full-field assertions for review decision paths.
//
// Each decision path (approve / iterate / reject) lays down a specific set
// of DB changes across multiple tables. Existing tests assert subsets;
// this file asserts the FULL delta for each path so a refactor can't
// silently drop a field.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  memoryDistillJobs,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  tasks,
  workflows,
} from '../src/db/schema'
import { addReviewComment, submitReviewDecision } from '../src/services/review'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  installCommittedEventDeliveryHarness,
  type CommittedEventDeliveryTestHarness,
} from './helpers/committedEventHarness'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  taskId: string
  reviewRunId: string
  dvId: string
  agentRunId: string
  definition: WorkflowDefinition
  committedEvents: CommittedEventDeliveryTestHarness
  cleanup: () => void
}

async function buildHarness(opts?: {
  sourceFilePath?: string
  withInlineComments?: boolean
}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1g-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])

  const db = createInMemoryDb(MIGRATIONS)
  const committedEvents = installCommittedEventDeliveryHarness(db)
  await db.insert(agentsTable).values({
    id: ulid(),
    name: 'doc',
    description: '',
    outputs: JSON.stringify(['docpath']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
      {
        id: 'rev_1',
        kind: 'review',
        inputSource: { nodeId: 'doc', portName: 'docpath' },
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: Date.now(),
  })

  // Upstream agent done.
  const agentRunId = ulid()
  await db.insert(nodeRuns).values({
    id: agentRunId,
    taskId,
    nodeId: 'doc',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 900,
  })
  await db.insert(nodeRunOutputs).values({
    nodeRunId: agentRunId,
    portName: 'docpath',
    content: opts?.sourceFilePath !== undefined ? opts.sourceFilePath : '# body inline',
  })

  // Review row awaiting decision.
  const reviewRunId = ulid()
  await db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: 'rev_1',
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: Date.now() - 50,
  })

  // Pending doc_version (inline content or file-backed).
  mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
  const bodyPath = 'doc_versions/v1.md'
  writeFileSync(join(appHome, bodyPath), '# body inline')
  const dvId = ulid()
  await db.insert(docVersions).values({
    id: dvId,
    taskId,
    reviewNodeId: 'rev_1',
    reviewNodeRunId: reviewRunId,
    sourceNodeId: 'doc',
    sourcePortName: 'docpath',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath,
    sourceFilePath: opts?.sourceFilePath ?? null,
    decision: 'pending',
  })

  if (opts?.withInlineComments === true) {
    await db.insert(reviewComments).values({
      id: ulid(),
      docVersionId: dvId,
      anchorSectionPath: 'Heading',
      anchorParagraphIdx: 0,
      anchorOffsetStart: 0,
      anchorOffsetEnd: 4,
      selectedText: 'body',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 1,
      commentText: 'change this',
      author: 'reviewer',
    })
  }

  return {
    db,
    appHome,
    repoPath,
    taskId,
    reviewRunId,
    dvId,
    agentRunId,
    definition,
    committedEvents,
    cleanup: () => {
      committedEvents.dispose()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

describe('RFC-053 PR-A T1g — review decision full-field assertions', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('A1 approve full delta — node_run / doc_version / outputs / distill enqueue', async () => {
    h = await buildHarness()
    const before = Date.now()
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      author: 'tester-123',
    })
    await h.committedEvents.drain()

    // node_run: status=done, finishedAt set ≥ before
    const nr = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]!
    expect(nr.status).toBe('done')
    expect(nr.finishedAt).not.toBeNull()
    expect(nr.finishedAt!).toBeGreaterThanOrEqual(before - 1)

    // doc_version: decision=approved, decidedAt ≥ before, decidedBy, decisionReason=null, commentsJson='[]'
    const dv = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(dv.decision).toBe('approved')
    expect(dv.decidedAt).not.toBeNull()
    expect(dv.decidedAt!).toBeGreaterThanOrEqual(before - 1)
    expect(dv.decidedBy).toBe('tester-123')
    expect(dv.decisionReason).toBeNull()
    expect(dv.commentsJson).toBe('[]')

    // nodeRunOutputs: approved_doc + approval_meta
    const outs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))
    const byPort = new Map(outs.map((o) => [o.portName, o.content]))
    expect(byPort.has('approved_doc')).toBe(true)
    expect(byPort.has('approval_meta')).toBe(true)
    // RFC-072: inline-markdown approval (no sourceFilePath) is not a file path,
    // so approved_doc carries no file kind → no Download button in the UI.
    expect(outs.find((o) => o.portName === 'approved_doc')?.kind ?? null).toBeNull()
    const meta = JSON.parse(byPort.get('approval_meta')!) as Record<string, unknown>
    expect(meta.decision).toBe('approved')
    expect(meta.versionIndex).toBe(1)
    expect(meta.reviewIteration).toBe(0)
    expect(meta.sourceNodeId).toBe('doc')
    expect(meta.sourcePortName).toBe('docpath')
    // RFC-099 prompt isolation — approval_meta is a downstream-consumable
    // port, so the decider's identity must NOT appear in it (the audit copy
    // lives on doc_versions.decided_by, asserted above).
    expect(meta.decidedBy).toBeUndefined()

    // Distill enqueue best-effort — should have inserted at least one row.
    const distillRows = await h.db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.taskId, h.taskId))
    expect(distillRows.length).toBeGreaterThanOrEqual(1)
    expect(distillRows[0]!.sourceKind).toBe('review')
  })

  test('A2 approve with markdown_file source: approved_doc passes path through, not body', async () => {
    h = await buildHarness({ sourceFilePath: 'docs/design.md' })
    // Pre-write the source file (resolver expects it to exist for read path).
    mkdirSync(join(h.repoPath, 'docs'), { recursive: true })
    writeFileSync(join(h.repoPath, 'docs/design.md'), '# design body')
    // Re-write the upstream port to be a path string (not inline body).
    await h.db
      .update(nodeRunOutputs)
      .set({ content: 'docs/design.md' })
      .where(
        and(eq(nodeRunOutputs.nodeRunId, h.agentRunId), eq(nodeRunOutputs.portName, 'docpath')),
      )

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      author: 'tester',
    })

    const outs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))
    const approved = outs.find((o) => o.portName === 'approved_doc')!
    // approved_doc must mirror the source's shape — a path, not inline body.
    expect(approved.content).toBe('docs/design.md')
    // RFC-072: file-path passthrough persists a markdownish file kind so the
    // task-detail Outputs tab renders a Download button. flag-audit §8：持久列
    // 统一 canonical 'path<md>'（不再倒灌 legacy 别名 'markdown_file'）。
    expect(approved.kind).toBe('path<md>')
  })

  test('A3 iterate full delta — node_run pending + reviewIteration bumped + comments archived + upstream re-mint', async () => {
    h = await buildHarness({ withInlineComments: true })
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
      author: 'tester',
    })

    const nr = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]!
    expect(nr.status).toBe('pending')
    expect(nr.reviewIteration).toBe(1)

    const dv = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(dv.decision).toBe('iterated')
    expect(dv.decidedAt).not.toBeNull()
    // decisionReason is the rendered prompt-friendly comment(s)
    expect(dv.decisionReason).toContain('change this')
    // commentsJson archived snapshot has at least the one comment we seeded.
    const archived = JSON.parse(dv.commentsJson) as Array<Record<string, unknown>>
    expect(archived.length).toBe(1)
    expect(archived[0]!.commentText).toBe('change this')

    // Row-side review_comments are removed (archived into doc_version snapshot).
    const remainingRowComments = await h.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.docVersionId, h.dvId))
    expect(remainingRowComments.length).toBe(0)

    // Upstream: original agent row canceled + retry=1 minted pending
    const agentRows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'doc')))
    expect(agentRows.length).toBe(2)
    const original = agentRows.find((r) => r.id === h.agentRunId)!
    expect(original.status).toBe('canceled')
    expect(original.errorMessage).toContain('superseded-by-review-iterated')
    const fresh = agentRows.find((r) => r.retryIndex === 1)!
    expect(fresh.status).toBe('pending')
  })

  test('A4 reject full delta — decisionReason=rejectReason verbatim + upstream re-mint', async () => {
    h = await buildHarness({ withInlineComments: true })
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewRunId,
      decision: 'rejected',
      expectedReviewIteration: 0,
      author: 'tester',
      rejectReason: 'this is not what I asked for',
    })

    const dv = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(dv.decision).toBe('rejected')
    expect(dv.decisionReason).toBe('this is not what I asked for')

    // comments archived into commentsJson but reject's decisionReason is the
    // raw user input — NOT the rendered comments (unlike iterate).
    const archived = JSON.parse(dv.commentsJson) as Array<Record<string, unknown>>
    expect(archived.length).toBe(1)

    // Upstream re-mint as in iterate.
    const agentRows = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'doc')))
    expect(agentRows.length).toBe(2)
    const original = agentRows.find((r) => r.id === h.agentRunId)!
    expect(original.errorMessage).toContain('superseded-by-review-rejected')
  })

  test('A5 iterate with no comments: decisionReason gracefully nonempty (or empty string)', async () => {
    h = await buildHarness({ withInlineComments: false })
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
      author: 'tester',
    })
    const dv = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(dv.decision).toBe('iterated')
    // decisionReason may be empty / whitespace-trimmed depending on
    // renderCommentsForPrompt; here we only assert it's a string (not null).
    expect(typeof dv.decisionReason).toBe('string')
  })

  test('A6 same approve retry replays its durable receipt + no-op on outputs', async () => {
    h = await buildHarness()
    const first = await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      author: 'tester',
    })
    const outsBefore = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))

    const replay = await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      author: 'tester',
    })
    await h.committedEvents.drain()
    expect(first.receipt.replayed).toBe(false)
    expect(replay.receipt).toMatchObject({
      operationId: first.receipt.operationId,
      replayed: true,
    })

    const outsAfter = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))
    expect(outsAfter.length).toBe(outsBefore.length)
    expect(await h.db.select().from(memoryDistillJobs)).toHaveLength(1)
  })

  test('A7 approve sets distill job sourceKind=review + status pending-ish', async () => {
    h = await buildHarness()
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      author: 'tester',
    })
    await h.committedEvents.drain()

    const jobs = await h.db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.taskId, h.taskId))
    expect(jobs.length).toBeGreaterThanOrEqual(1)
    const j = jobs[0]!
    expect(j.sourceKind).toBe('review')
    expect(j.sourceEventId).toBe(h.dvId)
    // status should be in some pending/runnable shape — exact value depends
    // on enqueueDistillJob; just assert it's not null.
    expect(j.status).toBeTruthy()
  })

  test('A8 iterate enqueues a distill job too (best-effort)', async () => {
    h = await buildHarness({ withInlineComments: true })
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
      author: 'tester',
    })
    await h.committedEvents.drain()
    const jobs = await h.db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.taskId, h.taskId))
    expect(jobs.length).toBeGreaterThanOrEqual(1)
  })
})

describe('review decision concurrency — one complete winner, zero loser side effects', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  function expectRejectedWithCode(result: PromiseSettledResult<unknown>, code: string): void {
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect((result.reason as { code?: string }).code).toBe(code)
    }
  }

  async function taskDistillJobs(): Promise<Array<typeof memoryDistillJobs.$inferSelect>> {
    await h.committedEvents.drain()
    return h.db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.taskId, h.taskId))
  }

  test('concurrent approve then reject commits only the approval fact set', async () => {
    h = await buildHarness({ withInlineComments: true })

    const results = await Promise.allSettled([
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        author: 'approver',
      }),
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'rejected',
        rejectReason: 'reject must lose',
        expectedReviewIteration: 0,
        author: 'rejecter',
      }),
    ])

    expect(results[0]!.status).toBe('fulfilled')
    expectRejectedWithCode(results[1]!, 'review-not-awaiting')

    const reviewRun = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]!
    expect(reviewRun.status).toBe('done')
    expect(reviewRun.reviewIteration).toBe(0)
    const doc = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(doc.decision).toBe('approved')
    expect(doc.decidedBy).toBe('approver')
    expect(doc.decisionReason).toBeNull()
    expect(doc.commentsJson).toContain('change this')
    expect(await h.db.select().from(reviewComments)).toHaveLength(0)

    const upstream = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'doc')))
    expect(upstream).toHaveLength(1)
    expect(upstream[0]!.status).toBe('done')
    const outputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))
    expect(outputs.map((row) => row.portName).sort()).toEqual(['approval_meta', 'approved_doc'])
    expect(await taskDistillJobs()).toHaveLength(1)
  })

  test('concurrent reject then approve commits only the rejection fact set', async () => {
    h = await buildHarness({ withInlineComments: true })

    const results = await Promise.allSettled([
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'rejected',
        rejectReason: 'redo the document',
        expectedReviewIteration: 0,
        author: 'rejecter',
      }),
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        author: 'approver',
      }),
    ])

    expect(results[0]!.status).toBe('fulfilled')
    expectRejectedWithCode(results[1]!, 'review-not-awaiting')

    const reviewRun = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]!
    expect(reviewRun.status).toBe('pending')
    expect(reviewRun.reviewIteration).toBe(1)
    const doc = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(doc.decision).toBe('rejected')
    expect(doc.decidedBy).toBe('rejecter')
    expect(doc.decisionReason).toBe('redo the document')

    const upstream = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'doc')))
    expect(upstream).toHaveLength(2)
    expect(upstream.filter((row) => row.status === 'canceled')).toHaveLength(1)
    expect(upstream.filter((row) => row.status === 'pending')).toHaveLength(1)
    const outputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))
    expect(outputs).toHaveLength(0)
    expect(await taskDistillJobs()).toHaveLength(1)
  })

  test('concurrent iterate then reject cannot mix two rerun reasons', async () => {
    h = await buildHarness({ withInlineComments: true })

    const results = await Promise.allSettled([
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'iterated',
        expectedReviewIteration: 0,
        author: 'iterator',
      }),
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'rejected',
        rejectReason: 'reject must lose',
        expectedReviewIteration: 0,
        author: 'rejecter',
      }),
    ])

    expect(results[0]!.status).toBe('fulfilled')
    expectRejectedWithCode(results[1]!, 'review-not-awaiting')
    const doc = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(doc.decision).toBe('iterated')
    expect(doc.decidedBy).toBe('iterator')
    expect(doc.decisionReason).toContain('change this')
    expect(doc.decisionReason).not.toContain('reject must lose')

    const upstream = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'doc')))
    expect(upstream).toHaveLength(2)
    expect(upstream.filter((row) => row.status === 'canceled')).toHaveLength(1)
    expect(upstream.filter((row) => row.status === 'pending')).toHaveLength(1)
    expect(await taskDistillJobs()).toHaveLength(1)
  })

  test('concurrent double approve writes one output pair and one distill job', async () => {
    h = await buildHarness()

    const results = await Promise.allSettled([
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        author: 'first',
      }),
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        author: 'second',
      }),
    ])

    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]!.status).toBe('fulfilled')
    if (results[0]!.status === 'fulfilled' && results[1]!.status === 'fulfilled') {
      expect(results[0]!.value.receipt.replayed).toBe(false)
      expect(results[1]!.value.receipt).toMatchObject({
        operationId: results[0]!.value.receipt.operationId,
        replayed: true,
      })
    }
    const doc = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(doc.decision).toBe('approved')
    expect(doc.decidedBy).toBe('first')
    const outputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))
    expect(outputs).toHaveLength(2)
    expect(await taskDistillJobs()).toHaveLength(1)
  })

  test('a failing lock holder releases the queue so the next valid decision completes', async () => {
    h = await buildHarness()

    const results = await Promise.allSettled([
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 99,
        author: 'stale-client',
      }),
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        author: 'valid-client',
      }),
    ])

    expectRejectedWithCode(results[0]!, 'review-iteration-mismatch')
    expect(results[1]!.status).toBe('fulfilled')
    const doc = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(doc.decision).toBe('approved')
    expect(doc.decidedBy).toBe('valid-client')
  })

  test('decision winning against a concurrent comment leaves no live comment on a decided doc', async () => {
    h = await buildHarness()
    const results = await Promise.allSettled([
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        author: 'approver',
      }),
      addReviewComment({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        anchor: {
          sectionPath: 'body',
          paragraphIdx: 0,
          offsetStart: 2,
          offsetEnd: 6,
          selectedText: 'body',
          contextBefore: '# ',
          contextAfter: ' inline',
          occurrenceIndex: 1,
        },
        commentText: 'too late',
        author: 'commenter',
      }),
    ])

    expect(results[0]!.status).toBe('fulfilled')
    expectRejectedWithCode(results[1]!, 'review-not-awaiting')
    expect(await h.db.select().from(reviewComments)).toHaveLength(0)
    const doc = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    expect(doc.decision).toBe('approved')
    expect(doc.commentsJson).toBe('[]')
  })

  test('comment winning against a concurrent decision is archived exactly once', async () => {
    h = await buildHarness()
    const results = await Promise.allSettled([
      addReviewComment({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        anchor: {
          sectionPath: 'body',
          paragraphIdx: 0,
          offsetStart: 2,
          offsetEnd: 6,
          selectedText: 'body',
          contextBefore: '# ',
          contextAfter: ' inline',
          occurrenceIndex: 1,
        },
        commentText: 'archive me',
        author: 'commenter',
      }),
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        author: 'approver',
      }),
    ])

    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]!.status).toBe('fulfilled')
    expect(await h.db.select().from(reviewComments)).toHaveLength(0)
    const doc = (await h.db.select().from(docVersions).where(eq(docVersions.id, h.dvId)))[0]!
    const archived = JSON.parse(doc.commentsJson ?? '[]') as Array<{ commentText?: string }>
    expect(archived).toHaveLength(1)
    expect(archived[0]?.commentText).toBe('archive me')
  })

  test('reject cascade and sibling approve serialize at task scope', async () => {
    h = await buildHarness()
    const siblingNode = {
      id: 'rev_2',
      kind: 'review',
      inputSource: { nodeId: 'doc', portName: 'docpath' },
    } as unknown as WorkflowNode
    const definition: WorkflowDefinition = {
      ...h.definition,
      nodes: [...h.definition.nodes, siblingNode],
    }
    await h.db
      .update(tasks)
      .set({ workflowSnapshot: JSON.stringify(definition) })
      .where(eq(tasks.id, h.taskId))

    const siblingRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: siblingRunId,
      taskId: h.taskId,
      nodeId: 'rev_2',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now() - 40,
    })
    const siblingBodyPath = 'doc_versions/sibling.md'
    writeFileSync(join(h.appHome, siblingBodyPath), '# sibling body')
    const siblingDocId = ulid()
    await h.db.insert(docVersions).values({
      id: siblingDocId,
      taskId: h.taskId,
      reviewNodeId: 'rev_2',
      reviewNodeRunId: siblingRunId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: siblingBodyPath,
      decision: 'pending',
    })

    const results = await Promise.allSettled([
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'rejected',
        rejectReason: 'invalidate every sibling',
        expectedReviewIteration: 0,
        author: 'rejecter',
      }),
      submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: siblingRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        author: 'sibling-approver',
      }),
    ])

    expect(results[0]!.status).toBe('fulfilled')
    expectRejectedWithCode(results[1]!, 'review-not-awaiting')
    const siblingRun = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, siblingRunId)))[0]!
    expect(siblingRun.status).toBe('pending')
    expect(siblingRun.reviewIteration).toBe(1)
    const siblingDoc = (
      await h.db.select().from(docVersions).where(eq(docVersions.id, siblingDocId))
    )[0]!
    expect(siblingDoc.decision).toBe('rejected')
    expect(siblingDoc.decisionReason).toContain('invalidated by sibling reject')
    const siblingOutputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, siblingRunId))
    expect(siblingOutputs).toHaveLength(0)
  })
})
