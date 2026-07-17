// RFC-203 T6/T4 — uniform error bodies + task-level failureCode projection.
//
// LOCKS: (1) /call-targets missing methodRef returns the uniform
// {ok:false, code, message} body with the call-target-specific code (was a
// bare {error:string} the shared decoder could not parse); (2) plantuml
// source guards return uniform bodies; (3) WS upgrade rejections return the
// FLAT uniform body (was nested {error:{...}}); (4) getTask / listTasks
// project the failed node's RFC-145 failure code (failed-run oracle) and
// getTaskNodeRuns surfaces the per-run code.

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { getTask, getTaskNodeRuns, listTasks } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedFailedTask(db: DbClient, failureCode: string | null): { taskId: string } {
  const workflowId = ulid()
  const taskId = ulid()
  db.insert(workflows)
    .values({
      id: workflowId,
      name: 'wf',
      definition: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 'ft',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/r',
      worktreePath: '/tmp/w',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'failed',
      failedNodeId: 'agent_x',
      errorSummary: 'no <workflow-output> envelope found in stdout',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  // Older retry (must lose the freshest pick) + freshest failed run.
  db.insert(nodeRuns)
    .values({
      id: '01OLD' + ulid().slice(5),
      taskId,
      nodeId: 'agent_x',
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      preSnapshot: null,
      startedAt: Date.now() - 1000,
      failureCode: null,
    })
    .run()
  db.insert(nodeRuns)
    .values({
      id: '01ZZZ' + ulid().slice(5),
      taskId,
      nodeId: 'agent_x',
      status: 'failed',
      retryIndex: 1,
      iteration: 0,
      preSnapshot: null,
      startedAt: Date.now(),
      failureCode,
    })
    .run()
  return { taskId }
}

describe('RFC-203 T4 — failureCode projection', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('getTask projects the freshest failed run failure code', async () => {
    const { taskId } = seedFailedTask(db, 'envelope-missing')
    const task = await getTask(db, taskId)
    expect(task?.failureCode).toBe('envelope-missing')
  })

  test('listTasks batches the projection; non-failed tasks stay null-free', async () => {
    const { taskId } = seedFailedTask(db, 'port-validation-failed')
    const rows = await listTasks(db, {})
    const row = rows.find((r) => r.id === taskId)
    expect(row?.failureCode).toBe('port-validation-failed')
  })

  test('failed task without a coded run projects null (legacy rows)', async () => {
    const { taskId } = seedFailedTask(db, null)
    const task = await getTask(db, taskId)
    expect(task?.failureCode ?? null).toBeNull()
  })

  test('getTaskNodeRuns surfaces per-run failureCode', async () => {
    const { taskId } = seedFailedTask(db, 'clarify-required')
    const res = await getTaskNodeRuns(db, taskId)
    const coded = res.runs.find((r) => r.failureCode === 'clarify-required')
    expect(coded).toBeDefined()
  })
})

describe('RFC-203 T6 — uniform error bodies (source locks)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dir, '..', ...rel.split('/')), 'utf8')

  test('call-targets missing methodRef throws the specific ValidationError', () => {
    const src = read('src/routes/tasks.ts')
    expect(src).toContain("'call-target-method-required'")
    expect(src).not.toContain("{ error: 'methodRef query param required' }")
  })

  test('plantuml guards use DomainError, no bare {error:string} bodies', () => {
    const src = read('src/routes/plantuml.ts')
    // Format-agnostic: prettier may wrap the DomainError(...) call across
    // lines, so match the code + DomainError presence separately rather than
    // a single-line literal.
    expect(src).toContain('DomainError')
    expect(src).toContain("'plantuml-source-too-large'")
    expect(src).toContain("'plantuml-source-required'")
    expect(src).not.toContain("c.json({ error: 'plantuml")
  })

  test('ws upgrade rejections use the flat uniform body', () => {
    const src = read('src/ws/server.ts')
    expect(src).toContain('ok: false')
    expect(src).not.toContain('JSON.stringify({ error: {')
    expect(src).not.toContain("new Response('upgrade-failed'")
  })
})
