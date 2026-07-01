// RFC-079 PR-A — review multi-document mode (dispatch + selection + the three
// decisions) integration locks.
//
// WHY THIS FILE EXISTS (regression intent):
//   - C2: approve emits the accepted subset, order-preserving + accepted-only.
//   - C3: iterate aggregates EVERY item's comments (each File-headed) into the
//     upstream re-run prompt, no cross-item bleed; iterate does NOT roll back.
//   - C4: reject still drives the upstream-rerun path (cancel + mint fresh
//     pending) — multi-doc must not bypass it.
//   - A5: approve with any undecided document → 409 review-selection-incomplete.
//   - dispatch: a list<path<md>> upstream archives one doc_version per item with
//     item_index / item_path / selection='unselected'.
// Single-document review is locked separately by the full RFC-005 suite; here
// every doc_version carries item_index, so a leak into the single-doc path
// would change those (still-green) tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  tasks,
  workflows,
} from '../src/db/schema'
import {
  buildReviewPromptContext,
  dispatchReviewNode,
  getReviewDetail,
  listReviewSummaries,
  setDocumentSelection,
  submitReviewDecision,
} from '../src/services/review'
import { ConflictError } from '../src/util/errors'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-079 — review multi-document mode', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-multidoc-'))
    appHome = join(tmp, 'appHome')
    worktree = join(tmp, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  const PATHS = ['cases/a.md', 'cases/b.md', 'cases/c.md']

  async function seed(): Promise<{
    taskId: string
    task: typeof tasks.$inferSelect
    definition: WorkflowDefinition
    reviewNode: WorkflowNode
  }> {
    await db.insert(agentsTable).values({
      id: ulid(),
      name: 'caseGen',
      description: '',
      outputs: JSON.stringify(['cases']),
      permission: '{}',
      skills: '[]',
      // RFC-079: list<path<md>> upstream port → multi-document review.
      frontmatterExtra: JSON.stringify({ outputKinds: { cases: 'list<path<md>>' } }),
      bodyMd: '',
    })
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'src',
          kind: 'agent-single',
          agentName: 'caseGen',
          promptTemplate: '',
        } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'src', portName: 'cases' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'w',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'multidoc',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: worktree,
      worktreePath: worktree,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    return { taskId, task, definition, reviewNode }
  }

  /** Seed the upstream done run + its `cases` list output, write the case files. */
  async function seedSrc(taskId: string, srcId: string, paths: string[]): Promise<void> {
    await db.insert(nodeRuns).values({
      id: srcId,
      taskId,
      nodeId: 'src',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      preSnapshot: null,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: srcId, portName: 'cases', content: paths.join('\n') })
    for (const p of paths) {
      const abs = join(worktree, p)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, `# Case ${p}\n\nsteps for ${p}\n`, 'utf8')
    }
  }

  /** Dispatch the review and return its node_run id + ordered doc_versions. */
  async function dispatchRound(): Promise<{
    taskId: string
    task: typeof tasks.$inferSelect
    definition: WorkflowDefinition
    reviewNode: WorkflowNode
    reviewNodeRunId: string
    docs: (typeof docVersions.$inferSelect)[]
  }> {
    const { taskId, task, definition, reviewNode } = await seed()
    await seedSrc(taskId, '01SRC', PATHS)
    const result = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('awaiting_review')
    const docs = await db
      .select()
      .from(docVersions)
      .where(eq(docVersions.taskId, taskId))
      .orderBy(docVersions.itemIndex)
    const reviewNodeRunId = docs[0]!.reviewNodeRunId
    return { taskId, task, definition, reviewNode, reviewNodeRunId, docs }
  }

  test('dispatch archives one doc_version per list item', async () => {
    const { docs } = await dispatchRound()
    expect(docs.length).toBe(3)
    docs.forEach((d, i) => {
      expect(d.itemIndex).toBe(i)
      expect(d.itemPath).toBe(PATHS[i]!)
      expect(d.selection).toBe('unselected')
      expect(d.decision).toBe('pending')
      expect(d.versionIndex).toBe(1) // each item has its own v1 sequence
      expect(d.sourcePortName).toBe('cases')
    })
    // all share one review node_run
    expect(new Set(docs.map((d) => d.reviewNodeRunId)).size).toBe(1)
  })

  test('setDocumentSelection updates a pending item; rejects unknown/decided', async () => {
    const { reviewNodeRunId, docs } = await dispatchRound()
    const res = await setDocumentSelection({
      db,
      nodeRunId: reviewNodeRunId,
      docVersionId: docs[0]!.id,
      selection: 'accepted',
    })
    expect(res.selection).toBe('accepted')
    const after = (await db.select().from(docVersions).where(eq(docVersions.id, docs[0]!.id)))[0]!
    expect(after.selection).toBe('accepted')

    await expect(
      setDocumentSelection({
        db,
        nodeRunId: reviewNodeRunId,
        docVersionId: 'does-not-exist',
        selection: 'accepted',
      }),
    ).rejects.toThrow()
  })

  test('approve emits the accepted subset (order-preserving, accepted-only) — C2', async () => {
    const { taskId, reviewNodeRunId, docs } = await dispatchRound()
    // accept a (0) + c (2), reject b (1)
    await setDocumentSelection({
      db,
      nodeRunId: reviewNodeRunId,
      docVersionId: docs[0]!.id,
      selection: 'accepted',
    })
    await setDocumentSelection({
      db,
      nodeRunId: reviewNodeRunId,
      docVersionId: docs[1]!.id,
      selection: 'not_accepted',
    })
    await setDocumentSelection({
      db,
      nodeRunId: reviewNodeRunId,
      docVersionId: docs[2]!.id,
      selection: 'accepted',
    })

    const result = await submitReviewDecision({
      db,
      appHome,
      nodeRunId: reviewNodeRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    expect(result.taskId).toBe(taskId)
    expect(result.resumeRequired).toBe(true)

    const accepted = (
      await db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(
            eq(nodeRunOutputs.nodeRunId, reviewNodeRunId),
            eq(nodeRunOutputs.portName, 'accepted'),
          ),
        )
    )[0]!
    expect(accepted.content).toBe('cases/a.md\ncases/c.md') // order preserved, b excluded
    expect(accepted.kind).toBe('list<path<md>>')

    const metaRow = (
      await db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(
            eq(nodeRunOutputs.nodeRunId, reviewNodeRunId),
            eq(nodeRunOutputs.portName, 'approval_meta'),
          ),
        )
    )[0]!
    const meta = JSON.parse(metaRow.content)
    expect(meta.itemCount).toBe(3)
    expect(meta.acceptedCount).toBe(2)
    expect(meta.acceptedItemIndices).toEqual([0, 2])

    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewNodeRunId)))[0]!
    expect(run.status).toBe('done')
  })

  test('approve with an undecided document → 409 review-selection-incomplete — A5', async () => {
    const { reviewNodeRunId, docs } = await dispatchRound()
    await setDocumentSelection({
      db,
      nodeRunId: reviewNodeRunId,
      docVersionId: docs[0]!.id,
      selection: 'accepted',
    })
    // docs[1], docs[2] left 'unselected'
    await expect(
      submitReviewDecision({
        db,
        appHome,
        nodeRunId: reviewNodeRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
      }),
    ).rejects.toMatchObject({ code: 'review-selection-incomplete' })
    expect(ConflictError).toBeDefined()
  })

  test('iterate aggregates per-item comments with File headers, no bleed — C3', async () => {
    const { taskId, reviewNodeRunId, docs } = await dispatchRound()
    // comment on a (0) and c (2); b (1) gets none.
    const addComment = async (docVersionId: string, text: string): Promise<void> => {
      await db.insert(reviewComments).values({
        id: ulid(),
        docVersionId,
        anchorSectionPath: 'h0',
        anchorParagraphIdx: 0,
        anchorOffsetStart: 0,
        anchorOffsetEnd: 4,
        selectedText: 'Case',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
        commentText: text,
        createdAt: Date.now(),
      })
    }
    await addComment(docs[0]!.id, 'tighten case a')
    await addComment(docs[2]!.id, 'expand case c')

    const result = await submitReviewDecision({
      db,
      appHome,
      nodeRunId: reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
    expect(result.reviewIteration).toBe(1) // bumped

    // each item is now iterated; review back to pending for the scheduler rerun.
    const after = await db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, reviewNodeRunId))
    expect(after.every((d) => d.decision === 'iterated')).toBe(true)

    const ctx = await buildReviewPromptContext(db, appHome, 'src', taskId, 0)
    expect(ctx).toBeDefined()
    const comments = ctx?.comments ?? ''
    expect(comments).toContain('cases/a.md')
    expect(comments).toContain('tighten case a')
    expect(comments).toContain('cases/c.md')
    expect(comments).toContain('expand case c')
    // b had no comment → its (empty) section is not present.
    expect(comments).not.toContain('cases/b.md')
  })

  test('reject drives the upstream-rerun path (cancel + mint fresh pending) — C4', async () => {
    const { taskId, reviewNodeRunId, docs } = await dispatchRound()
    const result = await submitReviewDecision({
      db,
      appHome,
      nodeRunId: reviewNodeRunId,
      decision: 'rejected',
      rejectReason: 'cases too coarse',
      expectedReviewIteration: 0,
    })
    expect(result.reviewIteration).toBe(1)

    // every item recorded the round-level reject reason.
    const after = await db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, reviewNodeRunId))
    expect(after.every((d) => d.decision === 'rejected')).toBe(true)
    expect(after.every((d) => d.decisionReason === 'cases too coarse')).toBe(true)

    // upstream src was superseded + a fresh retry_index=1 pending row minted —
    // the rerun path ran (not bypassed by multi-doc).
    const srcRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'src')))
    expect(srcRuns.length).toBe(2)
    const pending = srcRuns.find((r) => r.status === 'pending')
    expect(pending?.retryIndex).toBe(1)
    expect(srcRuns.some((r) => r.status === 'canceled')).toBe(true)
    void docs
  })

  test('getReviewDetail exposes documents[] + listReviewSummaries.isMultiDoc', async () => {
    const { taskId, reviewNodeRunId, docs } = await dispatchRound()
    await setDocumentSelection({
      db,
      nodeRunId: reviewNodeRunId,
      docVersionId: docs[1]!.id,
      selection: 'accepted',
    })

    const detail = await getReviewDetail(db, appHome, reviewNodeRunId)
    expect(detail.documents).toBeDefined()
    expect(detail.documents!.length).toBe(3)
    // ordered by item_index, titles extracted from each file's first heading
    expect(detail.documents!.map((d) => d.itemIndex)).toEqual([0, 1, 2])
    expect(detail.documents!.map((d) => d.itemPath)).toEqual(PATHS)
    expect(detail.documents![0]!.title).toBe('Case cases/a.md')
    expect(detail.documents![1]!.selection).toBe('accepted')
    expect(detail.documents![0]!.selection).toBe('unselected')
    // currentVersion defaults to the first item
    expect(detail.currentVersion.itemIndex).toBe(0)

    const summaries = await listReviewSummaries(db, { taskId })
    const summary = summaries.find((s) => s.nodeRunId === reviewNodeRunId)
    expect(summary?.isMultiDoc).toBe(true)
  })
})
