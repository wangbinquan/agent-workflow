// RFC-052 regression: `dispatchReviewNode` must short-circuit when the
// freshest top-level review node_run is already in a terminal state
// (`done` / `canceled`). Without this short-circuit, an upstream
// retry-cascade that minted a higher-retryIndex `failed/queued for retry`
// placeholder row for the review node confused `latestPerNode` into
// re-entering dispatch on every resume, which reset the approved review row
// back to `awaiting_review` and spawned a phantom v(n+1) `pending`
// doc_version. The next user approve then crashed on the
// node_run_outputs(node_run_id, port_name) PK and left the row in a
// half-decided middle state forever.
//
// Locks the fix for production task 01KS1N8WVZWE8FTR4K9WSETRNW.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchReviewNode } from '../src/services/review'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('dispatchReviewNode terminal-state short-circuit (RFC-052)', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-term-'))
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

  async function seedWorkflow(): Promise<{
    taskId: string
    definition: WorkflowDefinition
    docRunId: string
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
      name: 'w',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })

    const taskId = ulid()
    await db.insert(tasks).values({
      name: 'rfc-052',
      id: taskId,
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

    // Upstream agent done with a docpath output.
    const docRunId = ulid()
    await db.insert(nodeRuns).values({
      id: docRunId,
      taskId,
      nodeId: 'doc',
      iteration: 0,
      retryIndex: 0,
      status: 'done',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 500,
    })
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: docRunId, portName: 'docpath', content: '# body' })

    return { taskId, definition, docRunId }
  }

  test('returns ok + does NOT touch a done review row + does NOT mint a phantom doc_version', async () => {
    const { taskId, definition } = await seedWorkflow()
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!

    // Original review row: previously approved (status=done) at v1.
    const approvedRunId = ulid()
    const approvedFinishedAt = Date.now() - 200
    await db.insert(nodeRuns).values({
      id: approvedRunId,
      taskId,
      nodeId: 'rev_1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      startedAt: Date.now() - 800,
      finishedAt: approvedFinishedAt,
    })
    await db.insert(docVersions).values({
      id: ulid(),
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: approvedRunId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'doc_versions/v1.md',
      decision: 'approved',
      decidedAt: approvedFinishedAt,
      decidedBy: 'tester',
    })

    // Placeholder row from an upstream retry-cascade — higher retryIndex,
    // status=failed, errorMessage='queued for retry'. This is what the
    // pre-RFC-052 latestPerNode / dispatchReviewNode interaction picked up
    // and used to reset the approved row.
    const placeholderRunId = ulid()
    await db.insert(nodeRuns).values({
      id: placeholderRunId,
      taskId,
      nodeId: 'rev_1',
      iteration: 0,
      retryIndex: 1,
      reviewIteration: 0,
      status: 'failed',
      errorMessage: 'queued for retry',
      startedAt: Date.now() - 100,
      finishedAt: Date.now() - 100,
    })

    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    const result = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })

    expect(result.kind).toBe('ok')

    // Approved row's status + finishedAt must be untouched.
    const approvedAfter = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, approvedRunId))
    )[0]!
    expect(approvedAfter.status).toBe('done')
    expect(approvedAfter.finishedAt).toBe(approvedFinishedAt)

    // No new doc_version minted.
    const dvs = await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))
    expect(dvs.length).toBe(1)
    expect(dvs[0]!.decision).toBe('approved')

    // Placeholder row is allowed to linger — RFC-052 only requires that we
    // not act on it. (The fixup script + retryNode patch handle cleanup of
    // future placeholders.) The terminal-state short-circuit must work
    // regardless of whether placeholders are still there.
    const placeholderAfter = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, placeholderRunId))
    )[0]!
    expect(placeholderAfter.status).toBe('failed')
  })

  test('still parks a pending review row at awaiting_review (no regression on normal path)', async () => {
    const { taskId, definition } = await seedWorkflow()
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!

    // Single review row in `pending` (e.g., post-iterate). Dispatch should
    // pick it, set status=awaiting_review, and create v1.
    const reviewRunId = ulid()
    await db.insert(nodeRuns).values({
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'pending',
      startedAt: Date.now(),
    })

    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
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
    const after = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]!
    expect(after.status).toBe('awaiting_review')
    const dvs = await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))
    expect(dvs.length).toBe(1)
    expect(dvs[0]!.decision).toBe('pending')
  })
})
