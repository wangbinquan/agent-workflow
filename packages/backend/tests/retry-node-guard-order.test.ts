// Locks the RFC-099 audit (2026-07-15) fix: retryNode must validate that the
// nodeRunId belongs to the task BEFORE it CASes the task status to pending
// (that CAS also clears finishedAt/errorSummary/errorMessage/failedNodeId).
// The old order ran the CAS first and only then checked `runRow.taskId`, so a
// member passing a bogus / cross-task nodeRunId knocked a finished task into a
// scheduler-less `pending` zombie and wiped its completion metadata before the
// 404 fired. A bad nodeRunId must now leave the task completely untouched.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { retryNode } from '../src/services/task'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('retryNode validates nodeRunId before mutating task state (RFC-099 audit)', () => {
  let db: DbClient
  let appHome: string

  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-retry-guard-'))
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('bogus nodeRunId → 404 and the done task is left intact', async () => {
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'wf',
      description: '',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const taskId = ulid()
    const finishedAt = Date.now()
    await db.insert(tasks).values({
      id: taskId,
      name: 't',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/repo',
      // Must exist on disk — setTaskStatus's revival gate 410s (workspace-pruned)
      // before the UPDATE when the worktree is missing, which would mask the bug
      // (the CAS wouldn't run at all). With a real dir the CAS proceeds, so this
      // test exercises the actual "state mutated before the nodeRunId 404" path.
      worktreePath: appHome,
      baseBranch: 'main',
      branch: 'b',
      baseCommit: null,
      status: 'done',
      inputs: '{}',
      // RFC-292 regression: even a corrupt frozen trigger context must not
      // outrank the RFC-099 node-run ownership guard for an attacker-supplied
      // bogus id. The request still has zero mutation and reports the 404.
      triggerContextJson: 'not-json',
      maxDurationMs: null,
      maxTotalTokens: null,
      startedAt: finishedAt - 100,
      finishedAt,
      errorSummary: null,
    })

    let code: string | undefined
    try {
      await retryNode(db, taskId, 'no_such_node_run', {
        cascade: true,
        deps: {
          db,
          schedulerDriver: createTaskExecutionTestTopology({ db: db, driver: 'real' })
            .schedulerDriver,
          appHome,
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      })
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe('node-run-not-found')

    const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(rows[0]?.status).toBe('done')
    expect(rows[0]?.finishedAt).toBe(finishedAt)
  })

  test('valid owned nodeRun + missing frozen webhook context fails before retry CAS', async () => {
    const workflowId = ulid()
    const definition = {
      $schema_version: 5,
      inputs: [],
      nodes: [
        {
          id: 'agent',
          kind: 'agent-single',
          agentName: 'fixture',
          promptTemplate: 'Review {{trigger.webhook.comment_text}}',
        },
      ],
      edges: [],
    }
    await db.insert(workflows).values({
      id: workflowId,
      name: 'wf-trigger-retry',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const taskId = ulid()
    const runId = ulid()
    const finishedAt = Date.now()
    await db.insert(tasks).values({
      id: taskId,
      name: 'trigger-retry',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: appHome,
      worktreePath: appHome,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'failed',
      inputs: '{}',
      startedAt: finishedAt - 100,
      finishedAt,
      errorSummary: 'original-summary',
      errorMessage: 'original-detail',
      failedNodeId: 'agent',
    })
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'agent',
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      startedAt: finishedAt - 50,
      finishedAt,
      errorMessage: 'run-detail',
    })

    await expect(
      retryNode(db, taskId, runId, {
        cascade: true,
        deps: {
          db,
          schedulerDriver: createTaskExecutionTestTopology({ db: db, driver: 'real' })
            .schedulerDriver,
          appHome,
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      }),
    ).rejects.toMatchObject({ code: 'trigger-context-missing' })

    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(task).toMatchObject({
      status: 'failed',
      finishedAt,
      errorSummary: 'original-summary',
      errorMessage: 'original-detail',
      failedNodeId: 'agent',
    })
    expect(run).toMatchObject({ status: 'failed', errorMessage: 'run-detail' })
  })

  test("cross-task call row → 404 without canceling that row's live child", async () => {
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'wf-cross-task',
      description: '',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    const targetTaskId = ulid()
    const foreignTaskId = ulid()
    const foreignCallRunId = ulid()
    const foreignChildId = ulid()
    const common = {
      workflowId,
      workflowSnapshot: '{}',
      repoPath: appHome,
      worktreePath: appHome,
      baseBranch: 'main',
      inputs: '{}',
      startedAt: Date.now() - 100,
    }
    await db.insert(tasks).values([
      {
        ...common,
        id: targetTaskId,
        name: 'target-task',
        branch: `agent-workflow/${targetTaskId}`,
        status: 'done',
        finishedAt: Date.now(),
      },
      {
        ...common,
        id: foreignTaskId,
        name: 'foreign-parent',
        branch: `agent-workflow/${foreignTaskId}`,
        status: 'failed',
        finishedAt: Date.now(),
      },
    ])
    await db.insert(nodeRuns).values({
      id: foreignCallRunId,
      taskId: foreignTaskId,
      nodeId: 'call_foreign',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 50,
    })
    await db.insert(tasks).values({
      ...common,
      id: foreignChildId,
      name: 'foreign-live-child',
      branch: `agent-workflow/${foreignChildId}`,
      status: 'awaiting_human',
      parentTaskId: foreignTaskId,
      parentNodeRunId: foreignCallRunId,
      invocationDepth: 1,
    })
    await db
      .update(nodeRuns)
      .set({ childTaskId: foreignChildId })
      .where(eq(nodeRuns.id, foreignCallRunId))

    await expect(
      retryNode(db, targetTaskId, foreignCallRunId, {
        cascade: true,
        deps: {
          db,
          schedulerDriver: createTaskExecutionTestTopology({ db: db, driver: 'real' })
            .schedulerDriver,
          appHome,
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      }),
    ).rejects.toMatchObject({ code: 'node-run-not-found' })

    const target = (await db.select().from(tasks).where(eq(tasks.id, targetTaskId)))[0]
    const child = (await db.select().from(tasks).where(eq(tasks.id, foreignChildId)))[0]
    expect(target?.status).toBe('done')
    expect(child?.status).toBe('awaiting_human')
    expect(child?.errorMessage).toBeNull()
  })
})
