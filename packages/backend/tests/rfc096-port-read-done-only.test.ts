// LOCKS: RFC-096 (audit S-13 / 附录 C #5, design §3.3) — port reads select the
// newest visible DONE row only.
//
// `readPortRowAtFrame` (task-execution composition) is the single read point
// behind every projection of a produced value: wrapper return promotion, loop
// exit conditions, output nodes and closure / parameter resolution. Before
// RFC-096 the picker took the freshest row of (node, iteration) by pure id with
// NO status filter: a freshly minted non-done row landing in the window between
// the producer settling and the read — e.g. a concurrent designer-rerun
// `pending` row — was picked, had no node_run_outputs (the runner only persists
// ports on done), and the read returned ''. Two observable failures back then:
// a `port-empty` exit false-fired, and a wrapper output was clobbered to ''.
//
// RFC-354 (schema v6) moved every one of those read paths onto frames and
// edges, so the historical runtime reproduction — a "ghost" source outside
// every dispatch scope, read through a v5 exit condition / output binding —
// has no v6 shape any more (a return edge must come from a body member, and a
// closure edge gates readiness). The invariant is locked here at the read
// primitive itself, against the real SQLite persistence, with the very row
// pair that used to bite: a done row WITH a port value plus a younger pending
// row WITHOUT outputs in the same frame.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { readPortRowAtFrame } from '../src/modules/task-execution/composition/nodeMechanics'
import { SqliteNodeExecutionPersistence } from '../src/modules/task-execution/infrastructure/sqliteNodeExecutionPersistence'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOP_FRAME = { containerRunId: null, iteration: 0 }

async function seedTask(db: DbClient): Promise<string> {
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf-rfc096-portread',
    definition: JSON.stringify({ $schema_version: 6, inputs: [], nodes: [], edges: [] }),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't-rfc096-portread',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify({ $schema_version: 6, inputs: [], nodes: [], edges: [] }),
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

/** done row WITH a port value + younger pending row WITHOUT outputs, same frame. */
async function seedDonePlusYoungerPending(
  db: DbClient,
  taskId: string,
  nodeId: string,
  portName: string,
  content: string,
): Promise<{ doneId: string; pendingId: string }> {
  const doneId = ulid()
  await db.insert(nodeRuns).values({
    id: doneId,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 100,
    finishedAt: Date.now() - 50,
  })
  await db.insert(nodeRunOutputs).values({ nodeRunId: doneId, portName, content })
  const pendingId = ulid()
  await db.insert(nodeRuns).values({
    id: pendingId,
    taskId,
    nodeId,
    status: 'pending',
    retryIndex: 1,
    iteration: 0,
  })
  return { doneId, pendingId }
}

describe('RFC-096 §3.3 — readPortRowAtFrame reads the newest DONE row only', () => {
  test('a younger pending row in the same frame never shadows the done value', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const { doneId } = await seedDonePlusYoungerPending(db, taskId, 'src', 'signal', 'real-content')

    const read = await readPortRowAtFrame(
      new SqliteNodeExecutionPersistence(db),
      taskId,
      'src',
      'signal',
      TOP_FRAME,
    )
    expect(read.runId).toBe(doneId)
    expect(read.content).toBe('real-content')
    expect(read.active).toBe(true)
  })

  test('no done row at all reads as an empty value, never as the pending row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'src',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })

    const read = await readPortRowAtFrame(
      new SqliteNodeExecutionPersistence(db),
      taskId,
      'src',
      'signal',
      TOP_FRAME,
    )
    expect(read.runId).toBeNull()
    expect(read.content).toBe('')
  })

  test('the read is frame-scoped: a done row of another frame is invisible', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const generationId = ulid()
    await db.insert(nodeRuns).values({
      id: generationId,
      taskId,
      nodeId: 'loop',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 300,
      finishedAt: Date.now() - 200,
    })
    const insideId = ulid()
    await db.insert(nodeRuns).values({
      id: insideId,
      taskId,
      nodeId: 'src',
      containerRunId: generationId,
      status: 'done',
      retryIndex: 0,
      iteration: 1,
      startedAt: Date.now() - 100,
      finishedAt: Date.now() - 50,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: insideId,
      portName: 'signal',
      content: 'round-1',
    })

    const persistence = new SqliteNodeExecutionPersistence(db)
    expect((await readPortRowAtFrame(persistence, taskId, 'src', 'signal', TOP_FRAME)).runId).toBe(
      null,
    )
    expect(
      (
        await readPortRowAtFrame(persistence, taskId, 'src', 'signal', {
          containerRunId: generationId,
          iteration: 1,
        })
      ).content,
    ).toBe('round-1')
  })
})
