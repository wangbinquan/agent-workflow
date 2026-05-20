// Regression: when an upstream agent has multiple done node_runs at the same
// iteration — a stale (clarifyIteration=0, retryIndex=N>0) row finished before
// a clarify session opened, plus a fresh (clarifyIteration=1, retryIndex=0)
// row that ran AFTER the user answered clarify questions — dispatchReviewNode
// must pick the freshest by the same comparator the scheduler uses
// (`isFresherNodeRun`: clarifyIteration first, then retryIndex), NOT just
// `desc(retryIndex)`.
//
// Repro from a real failure: task "贪吃蛇" (01KS1N8WVZWE8FTR4K9WSETRNW). The
// agent emitted a docpath port on the clarify-rerun (retryIndex=0,
// clarifyIteration=1), but the stale process-retry row (retryIndex=1,
// clarifyIteration=0) had no docpath — the old retryIndex-only sort picked
// the stale row and the task failed with
// `review-source-port-missing: upstream 'agent_p69bj1' did not emit port 'docpath'`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

describe('dispatchReviewNode upstream selection — clarify rerun must beat stale process retry', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-cl-'))
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

  test('picks the (clarifyIteration=1, retryIndex=0) run over the stale (clarifyIteration=0, retryIndex=1) run', async () => {
    const agentId = ulid()
    await db.insert(agentsTable).values({
      id: agentId,
      name: 'doc',
      description: '',
      outputs: JSON.stringify(['docpath']),
      readonly: false,
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
      name: 'clarify-rerun-task',
      id: taskId,
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

    // Stale row: process retry that ran BEFORE the clarify session. retryIndex
    // is higher than the clarify-rerun's, but clarifyIteration is 0. No
    // docpath port was emitted on this attempt.
    const staleRunId = ulid()
    await db.insert(nodeRuns).values({
      id: staleRunId,
      taskId,
      nodeId: 'doc',
      iteration: 0,
      retryIndex: 1,
      clarifyIteration: 0,
      status: 'done',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 500,
    })
    // (Intentionally NO node_run_outputs row for staleRunId — that's the
    // bug shape we're locking out.)

    // Fresh row: clarify-driven rerun minted at retryIndex=0,
    // clarifyIteration=1 (see submitClarifyAnswers + isFresherNodeRun in
    // packages/backend/src/services/scheduler.ts). Emitted docpath.
    const clarifyRunId = ulid()
    await db.insert(nodeRuns).values({
      id: clarifyRunId,
      taskId,
      nodeId: 'doc',
      iteration: 0,
      retryIndex: 0,
      clarifyIteration: 1,
      status: 'done',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: clarifyRunId,
      portName: 'docpath',
      content: '# approved doc body',
    })

    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    const result = await dispatchReviewNode({
      db,
      taskId: task.id,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })

    // Must NOT be `review-source-port-missing` — that'd mean it read the
    // stale row (which has no docpath output).
    expect(result.kind).toBe('awaiting_review')
    const dvs = await db.select().from(docVersions)
    expect(dvs.length).toBe(1)
    // Stronger assertion: archived body must match the clarify rerun's port
    // content, not the stale row's (which has none).
    const onDisk = readFileSync(join(appHome, dvs[0]!.bodyPath), 'utf8')
    expect(onDisk).toBe('# approved doc body')
  })
})
