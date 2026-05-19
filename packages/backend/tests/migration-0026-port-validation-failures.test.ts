// RFC-049 — locks migration 0026: node_runs gains a nullable
// `port_validation_failures_json` column. Legacy rows (pre-RFC-049, inserted
// without the field) come back with portValidationFailuresJson == NULL. New
// rows can write and read the JSON payload round-trip.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
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
    .run()
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

    db.insert(nodeRuns)
      .values({
        id: withJson,
        taskId,
        nodeId: 'agent-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        clarifyIteration: 0,
        status: 'failed',
        portValidationFailuresJson: payload,
      })
      .run()

    db.insert(nodeRuns)
      .values({
        id: legacy,
        taskId,
        nodeId: 'agent-2',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        clarifyIteration: 0,
        status: 'done',
        // portValidationFailuresJson intentionally omitted — legacy row
      })
      .run()

    const rows = db.select().from(nodeRuns).all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(withJson)?.portValidationFailuresJson).toBe(payload)
    expect(byId.get(legacy)?.portValidationFailuresJson).toBeNull()
  })

  test('M2: empty-array payload round-trips (distinct from NULL)', () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const id = ulid()
    db.insert(nodeRuns)
      .values({
        id,
        taskId,
        nodeId: 'agent-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        clarifyIteration: 0,
        status: 'failed',
        portValidationFailuresJson: '[]',
      })
      .run()
    const row = db.select().from(nodeRuns).where(eq(nodeRuns.id, id)).get()
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
    db.insert(nodeRuns)
      .values({
        id,
        taskId,
        nodeId: 'agent-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        clarifyIteration: 0,
        status: 'failed',
        portValidationFailuresJson: payload,
      })
      .run()
    const row = db.select().from(nodeRuns).where(eq(nodeRuns.id, id)).get()
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
