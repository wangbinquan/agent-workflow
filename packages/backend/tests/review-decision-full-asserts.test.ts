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
import { submitReviewDecision } from '../src/services/review'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

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
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
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

  test('A6 second approve on already-done review: 409 + no-op on outputs', async () => {
    h = await buildHarness()
    await submitReviewDecision({
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

    let code: string | undefined
    try {
      await submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
        author: 'tester',
      })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('review-not-awaiting')

    const outsAfter = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))
    expect(outsAfter.length).toBe(outsBefore.length)
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
    const jobs = await h.db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.taskId, h.taskId))
    expect(jobs.length).toBeGreaterThanOrEqual(1)
  })
})
