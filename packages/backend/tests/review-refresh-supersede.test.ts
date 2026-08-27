// RFC-074 PR-B — review awaiting-refresh (B14-B15, design §7 / decision D5).
//
// When a review is parked at awaiting_review and its upstream source produces a
// FRESHER done run while the user is mid-review, dispatchReviewNode must refresh
// in place: supersede the stale pending doc_version, drop its now-meaningless
// anchored comments, mint a v(n+1) on the new body, and re-stamp the review
// row's consumed provenance to the new source run. This locks that transaction.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  collaborationGateOperations,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchReviewNode } from '../src/services/review'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-074 — review awaiting-refresh: supersede + recomment-drop + v(n+1) (B14-B15)', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-refresh-'))
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

  async function seed(status: 'running' | 'awaiting_review' = 'awaiting_review'): Promise<{
    taskId: string
    task: typeof tasks.$inferSelect
    definition: WorkflowDefinition
    reviewNode: WorkflowNode
  }> {
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
        { id: 'src', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'src', portName: 'docpath' },
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
      name: 'refresh',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: worktree,
      worktreePath: worktree,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status,
      inputs: '{}',
      startedAt: Date.now(),
    })
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    return { taskId, task, definition, reviewNode }
  }

  async function seedSrc(taskId: string, id: string, cci: number, body: string): Promise<void> {
    await db.insert(nodeRuns).values({
      id,
      taskId,
      nodeId: 'src',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'docpath', content: body })
  }

  test('awaiting review + fresher upstream → v1 superseded, comments dropped, v2 minted, consumed restamped', async () => {
    const { taskId, task, definition, reviewNode } = await seed()
    // Old source the review was opened against, plus a fresher source run.
    await seedSrc(taskId, '01A_OLD', 0, '# old body')
    await seedSrc(taskId, '01B_NEW', 4, '# new body after upstream rerun')

    // The awaiting review row consumed the OLD source.
    const reviewRunId = ulid()
    await db.insert(nodeRuns).values({
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      consumedUpstreamRunsJson: JSON.stringify({ src: '01A_OLD' }),
      startedAt: Date.now(),
    })
    // A pending v1 doc_version with an anchored comment (mid-review state).
    const v1Id = ulid()
    await db.insert(docVersions).values({
      id: v1Id,
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: reviewRunId,
      sourceNodeId: 'src',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'doc_versions/v1.md',
      decision: 'pending',
      createdAt: Date.now(),
    })
    await db.insert(reviewComments).values({
      id: ulid(),
      docVersionId: v1Id,
      anchorSectionPath: 'p0',
      anchorParagraphIdx: 0,
      anchorOffsetStart: 0,
      anchorOffsetEnd: 3,
      selectedText: 'old',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 0,
      commentText: 'this comment anchors the OLD body',
      createdAt: Date.now(),
    })

    const result = await dispatchReviewNode({
      db,
      taskId,
      scopeRoot: task.worktreePath,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('awaiting_review')

    // v1 retired as superseded with the upstream-refreshed reason.
    const v1After = (await db.select().from(docVersions).where(eq(docVersions.id, v1Id)))[0]!
    expect(v1After.decision).toBe('superseded')
    expect(v1After.decisionReason).toBe('upstream-refreshed')

    // v1's anchored comments are dropped (they pinned the old body).
    const v1Comments = await db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.docVersionId, v1Id))
    expect(v1Comments.length).toBe(0)

    // A fresh pending v2 exists on the same review row, against the new body.
    const allVersions = await db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.reviewNodeRunId, reviewRunId), eq(docVersions.decision, 'pending')))
    expect(allVersions.length).toBe(1)
    expect(allVersions[0]!.versionIndex).toBe(2)

    // The review row's provenance is re-stamped to the NEW source run.
    const reviewAfter = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]!
    expect(JSON.parse(reviewAfter.consumedUpstreamRunsJson ?? '{}').src).toBe('01B_NEW')
  })

  test('a T6 review refresh reuses one stable gate and advances its committed revision without overwriting v1', async () => {
    const { taskId, task, definition, reviewNode } = await seed('running')
    await seedSrc(taskId, '01A_OLD', 0, '# old body')

    const opened = await dispatchReviewNode({
      db,
      taskId,
      scopeRoot: task.worktreePath,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(opened.kind).toBe('awaiting_review')
    const firstRun = (await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'rev_1')))[0]!
    const firstVersion = (
      await db.select().from(docVersions).where(eq(docVersions.reviewNodeRunId, firstRun.id))
    )[0]!
    const revisionAfterOpen = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
      .lifecycleEventRevision

    await seedSrc(taskId, '01B_NEW', 4, '# new body after upstream rerun')
    const refreshed = await dispatchReviewNode({
      db,
      taskId,
      scopeRoot: task.worktreePath,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(refreshed.kind).toBe('awaiting_review')

    const reviewRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'rev_1'))
    expect(reviewRuns.map((run) => run.id)).toEqual([firstRun.id])
    const versions = await db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, firstRun.id))
    expect(versions.map((version) => [version.versionIndex, version.decision])).toEqual([
      [1, 'superseded'],
      [2, 'pending'],
    ])
    expect(versions[0]!.bodyPath).not.toBe(versions[1]!.bodyPath)
    expect(readFileSync(join(appHome, firstVersion.bodyPath), 'utf8')).toBe('# old body')
    expect(readFileSync(join(appHome, versions[1]!.bodyPath), 'utf8')).toBe(
      '# new body after upstream rerun',
    )
    const operations = await db
      .select()
      .from(collaborationGateOperations)
      .where(eq(collaborationGateOperations.taskId, taskId))
    expect(operations.map((operation) => operation.gateRef)).toEqual([
      `review:${firstRun.id}`,
      `review:${firstRun.id}`,
    ])
    expect(operations.map((operation) => operation.resultGateRevision)).toEqual([1, 2])
    expect(operations.map((operation) => operation.state)).toEqual(['completed', 'completed'])
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]).toMatchObject({
      status: 'awaiting_review',
      lifecycleEventRevision: revisionAfterOpen,
    })
  })

  test('refresh projection failure preserves the old pending round and retry commits the prepared operation', async () => {
    const { taskId, task, definition, reviewNode } = await seed()
    await seedSrc(taskId, '01A_OLD', 0, '# old body')
    await seedSrc(taskId, '01B_NEW', 4, '# new body after upstream rerun')
    const reviewRunId = ulid()
    await db.insert(nodeRuns).values({
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      consumedUpstreamRunsJson: JSON.stringify({ src: '01A_OLD' }),
      startedAt: Date.now(),
    })
    const v1Id = ulid()
    await db.insert(docVersions).values({
      id: v1Id,
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: reviewRunId,
      sourceNodeId: 'src',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'doc_versions/v1.md',
      decision: 'pending',
      createdAt: Date.now(),
    })
    const commentId = ulid()
    await db.insert(reviewComments).values({
      id: commentId,
      docVersionId: v1Id,
      anchorSectionPath: 'p0',
      anchorParagraphIdx: 0,
      anchorOffsetStart: 0,
      anchorOffsetEnd: 3,
      selectedText: 'old',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 0,
      commentText: 'preserve until refresh commits',
      createdAt: Date.now(),
    })
    db.$client.exec(`
      CREATE TRIGGER rfc333_refresh_projection_down
      BEFORE INSERT ON doc_versions
      BEGIN SELECT RAISE(ABORT, 'rfc333-refresh-projection'); END;
    `)

    await expect(
      dispatchReviewNode({
        db,
        taskId,
        scopeRoot: task.worktreePath,
        appHome,
        definition,
        node: reviewNode,
        iteration: 0,
      }),
    ).rejects.toThrow('rfc333-refresh-projection')
    expect((await db.select().from(docVersions).where(eq(docVersions.id, v1Id)))[0]).toMatchObject({
      decision: 'pending',
      decisionReason: null,
    })
    expect(
      await db.select().from(reviewComments).where(eq(reviewComments.id, commentId)),
    ).toHaveLength(1)
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]).toMatchObject(
      {
        status: 'awaiting_review',
        consumedUpstreamRunsJson: JSON.stringify({ src: '01A_OLD' }),
      },
    )
    const operation = (
      await db
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.taskId, taskId))
    )[0]!
    expect(operation.state).toBe('prepared')

    db.$client.exec('DROP TRIGGER rfc333_refresh_projection_down')
    const retried = await dispatchReviewNode({
      db,
      taskId,
      scopeRoot: task.worktreePath,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(retried.kind).toBe('awaiting_review')
    expect(
      (await db.select().from(docVersions).where(eq(docVersions.reviewNodeRunId, reviewRunId))).map(
        (version) => [version.versionIndex, version.decision],
      ),
    ).toEqual([
      [1, 'superseded'],
      [2, 'pending'],
    ])
    expect(
      (
        await db
          .select()
          .from(collaborationGateOperations)
          .where(eq(collaborationGateOperations.id, operation.id))
      )[0],
    ).toMatchObject({ state: 'completed', resultGateRevision: 1 })
  })
})
