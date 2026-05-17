// RFC-026 T3 — locks migration 0010: node_runs gains a nullable
// `opencode_session_id` column. Legacy rows (pre-RFC-026, inserted without
// the field) come back with opencodeSessionId == NULL. New rows can write
// and read the value back.
//
// If this test fails, RFC-026's "inline mode rerun finds the prior session
// id by reading node_runs.opencode_session_id" assumption (proposal §2.1 #2,
// design §3) is broken.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTaskAndWorkflow(db: DbClient): { taskId: string } {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
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
    .run()
  return { taskId }
}

describe('migration 0010 (RFC-026 node_runs.opencode_session_id)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('opencode_session_id stores values and is null when omitted', () => {
    const { taskId } = seedTaskAndWorkflow(db)

    const idWithSession = ulid()
    const idWithout = ulid()

    db.insert(nodeRuns)
      .values({
        id: idWithSession,
        taskId,
        nodeId: 'n1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        clarifyIteration: 0,
        status: 'done',
        opencodeSessionId: 'opc_abc123',
      })
      .run()

    db.insert(nodeRuns)
      .values({
        id: idWithout,
        taskId,
        nodeId: 'n2',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        clarifyIteration: 0,
        status: 'pending',
        // opencodeSessionId intentionally omitted — should land as NULL
      })
      .run()

    const rows = db.select().from(nodeRuns).all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(idWithSession)?.opencodeSessionId).toBe('opc_abc123')
    expect(byId.get(idWithout)?.opencodeSessionId).toBeNull()
  })
})
