// RFC-049 — locks migration 0026: node_runs gains a nullable
// `port_validation_failures_json` column. Legacy rows (pre-RFC-049, inserted
// without the field) come back with portValidationFailuresJson == NULL. New
// rows can write and read the JSON payload round-trip.

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

describe('migration 0026 (RFC-049 node_runs.port_validation_failures_json)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('M1: column stores JSON and is null when omitted', () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const withJson = ulid()
    const legacy = ulid()
    const payload = JSON.stringify([
      {
        port: 'docpath',
        kind: 'markdown_file',
        subReason: 'missing-file',
        detail: "markdown_file 'report.md': ENOENT: no such file or directory",
      },
    ])

    const { nodeRuns } = tablesOf(db)
    insertOne(db, nodeRuns, {
      id: withJson,
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'failed',
      portValidationFailuresJson: payload,
    })

    insertOne(db, nodeRuns, {
      id: legacy,
      taskId,
      nodeId: 'agent-2',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      // portValidationFailuresJson intentionally omitted — legacy row
    })

    const rows = queryRows(db.select().from(nodeRuns))
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(withJson)?.portValidationFailuresJson).toBe(payload)
    expect(byId.get(legacy)?.portValidationFailuresJson).toBeNull()
  })

  test('M2: empty-array payload round-trips (distinct from NULL)', () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const id = ulid()
    const { nodeRuns } = tablesOf(db)
    insertOne(db, nodeRuns, {
      id,
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'failed',
      portValidationFailuresJson: '[]',
    })
    const row = first(db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))
    expect(row?.portValidationFailuresJson).toBe('[]')
  })

  test('M3: multi-failure payload round-trips with kind namespace + detail', () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const id = ulid()
    const payload = JSON.stringify([
      { port: 'a', kind: 'markdown_file', subReason: 'empty-path' },
      {
        port: 'b',
        kind: 'markdown_file',
        subReason: 'escapes-worktree',
        detail: "markdown_file port content '../etc/passwd' resolves outside the task worktree",
      },
    ])
    const { nodeRuns } = tablesOf(db)
    insertOne(db, nodeRuns, {
      id,
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'failed',
      portValidationFailuresJson: payload,
    })
    const row = first(db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))
    expect(row?.portValidationFailuresJson).toBe(payload)
    const parsed = JSON.parse(row!.portValidationFailuresJson!) as Array<{
      port: string
      kind: string
      subReason: string
      detail?: string
    }>
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.port).toBe('a')
    expect(parsed[0]!.subReason).toBe('empty-path')
    expect(parsed[1]!.detail).toContain('outside the task worktree')
  })
})
