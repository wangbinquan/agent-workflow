// RFC-040 — locks migration 0022: node_runs gains a nullable
// `wrapper_progress_json` column. Legacy rows (pre-RFC-040, inserted without
// the field) come back with wrapperProgressJson == NULL. New rows can write
// and read JSON payloads back round-trip.
//
// If this test fails, RFC-040's "wrapper resumes from persisted iteration /
// baseline" mechanism (design.md §2, §4.2, §4.3) is broken — wrappers would
// either fail to persist (silent bug returning) or fail to resume (the
// column read would crash before findResumableWrapperRun could decide).

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows, first } from '@/platform/persistence/queryHelpers'
import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTaskAndWorkflow(db: DbClient): { taskId: string } {
  const wfId = ulid()
  const { workflows, tasks } = tablesOf(db)
  insertOne(db, workflows, {
    id: wfId,
    name: 'wf',
    definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const taskId = ulid()
  insertOne(db, tasks, {
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/wt',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    baseCommit: null,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId }
}

describe('migration 0022 (RFC-040 node_runs.wrapper_progress_json)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('wrapper_progress_json stores JSON values and is null when omitted', () => {
    const { taskId } = seedTaskAndWorkflow(db)

    const idWithProgress = ulid()
    const idLegacy = ulid()

    const payload = JSON.stringify({
      kind: 'loop',
      iteration: 3,
      phase: 'awaiting',
    })

    const { nodeRuns } = tablesOf(db)
    insertOne(db, nodeRuns, {
      id: idWithProgress,
      taskId,
      nodeId: 'wrapper-loop-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_human',
      wrapperProgressJson: payload,
    })

    insertOne(db, nodeRuns, {
      id: idLegacy,
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      // wrapperProgressJson intentionally omitted — legacy / non-wrapper row
    })

    const rows = queryRows(db.select().from(nodeRuns))
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(idWithProgress)?.wrapperProgressJson).toBe(payload)
    expect(byId.get(idLegacy)?.wrapperProgressJson).toBeNull()
  })

  test('wrapper_progress_json round-trips git-baseline payload', () => {
    const { taskId } = seedTaskAndWorkflow(db)

    const id = ulid()
    const payload = JSON.stringify({
      kind: 'git',
      baseline: 'a1b2c3d4e5f6',
      phase: 'awaiting',
    })

    const { nodeRuns } = tablesOf(db)
    insertOne(db, nodeRuns, {
      id,
      taskId,
      nodeId: 'wrapper-git-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
      wrapperProgressJson: payload,
    })

    const row = first(db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))
    expect(row?.wrapperProgressJson).toBe(payload)
  })
})
