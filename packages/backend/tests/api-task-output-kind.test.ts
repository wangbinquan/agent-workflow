// RFC-072 — locks the REST projection of node_run_outputs.kind into the
// wire-level `kind` field on NodeRunOutput (getTaskNodeRuns). The Outputs tab
// reads `kind` to decide whether a port is a downloadable file. Covers:
//   - persisted kind string surfaces verbatim,
//   - NULL column (legacy row / undeclared kind) surfaces as null,
//   - value (content) is unchanged alongside kind.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { getTaskNodeRuns } from '../src/services/task'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTaskAndWorkflow(db: DbClient): { taskId: string } {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 't',
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

function seedRun(db: DbClient, taskId: string, nodeId = 'n'): string {
  const id = ulid()
  db.insert(nodeRuns).values({ id, taskId, nodeId, status: 'done', startedAt: Date.now() }).run()
  return id
}

describe('RFC-072 — getTaskNodeRuns surfaces output kind', () => {
  let db: DbClient
  beforeEach(() => {
    resetBroadcastersForTests()
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test('persisted kind string surfaces verbatim; content unchanged', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const runId = seedRun(db, taskId)
    db.insert(nodeRunOutputs)
      .values({
        nodeRunId: runId,
        portName: 'doc',
        content: 'out/report.md',
        kind: 'markdown_file',
      })
      .run()
    const res = await getTaskNodeRuns(db, taskId)
    const out = res.outputs.find((o) => o.port === 'doc')
    expect(out).toBeDefined()
    expect(out?.kind).toBe('markdown_file')
    expect(out?.value).toBe('out/report.md')
  })

  test('NULL kind (legacy / undeclared) surfaces as null', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const runId = seedRun(db, taskId)
    db.insert(nodeRunOutputs)
      .values({ nodeRunId: runId, portName: 'summary', content: 'all good', kind: null })
      .run()
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.outputs.find((o) => o.port === 'summary')?.kind).toBeNull()
  })
})
