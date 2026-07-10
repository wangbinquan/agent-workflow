import { rimrafDir } from './helpers/cleanup'
// RFC-074 PR-B — review awaiting-refresh (B14-B15, design §7 / decision D5).
//
// When a review is parked at awaiting_review and its upstream source produces a
// FRESHER done run while the user is mid-review, dispatchReviewNode must refresh
// in place: supersede the stale pending doc_version, drop its now-meaningless
// anchored comments, mint a v(n+1) on the new body, and re-stamp the review
// row's consumed provenance to the new source run. This locks that transaction.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
    rimrafDir(appHome)
    rimrafDir(worktree)
  })

  async function seed(): Promise<{
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
      status: 'awaiting_review',
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
      task,
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
})
