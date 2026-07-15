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
import { tasks, workflows } from '../src/db/schema'
import { retryNode } from '../src/services/task'

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
        deps: { db, appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
      })
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe('node-run-not-found')

    const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(rows[0]?.status).toBe('done')
    expect(rows[0]?.finishedAt).toBe(finishedAt)
  })
})
