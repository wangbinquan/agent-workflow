// RFC-061 follow-up — getSessionTree rebuilt on attempt-subagent-*
// events. Verifies the synthesised envelope shape feeds parseSessionTree
// correctly and the 404 / 410 contracts are preserved.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { getSessionTree } from '../src/services/sessionView'
import { writeEvent } from '../src/services/writeEvents'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Seeded {
  db: DbClient
  taskId: string
  logicalRunId: string
}

async function seed(opts: { nodeKind?: string } = {}): Promise<Seeded> {
  const db = createInMemoryDb(MIGRATIONS)
  const wfId = ulid()
  const nodeId = 'agent_a'
  const def = {
    $schema_version: 1,
    inputs: [],
    nodes: [
      {
        id: nodeId,
        kind: opts.nodeKind ?? 'agent-single',
        agentName: 'coder',
      },
    ],
    edges: [],
    outputs: [],
  }
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: JSON.stringify(def),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw',
    worktreePath: '/tmp/aw-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const lrEvt = await writeEvent(db, {
    taskId,
    kind: 'logical-run-created',
    payload: {},
    actor: 'system',
    nodeId,
    loopIter: 0,
    shardKey: '',
    iter: 0,
  })
  return { db, taskId, logicalRunId: lrEvt.id }
}

describe('getSessionTree (projection-rebuilt)', () => {
  let h: Seeded
  beforeEach(async () => {
    h = await seed()
  })
  afterEach(() => {
    // in-memory DB GCs when h reassigned
  })

  test('empty tree when the logical_run has no attempts', async () => {
    const r = await getSessionTree(h.db, h.taskId, h.logicalRunId)
    expect(r.tree).toBeDefined()
    expect(r.tree.captureComplete).toBeDefined()
  })

  test('subagent text events surface as assistant messages', async () => {
    const scope = { nodeId: 'agent_a', loopIter: 0, shardKey: '', iter: 0 } as const
    const attemptId = `att_${ulid()}`
    await writeEvent(h.db, {
      taskId: h.taskId,
      kind: 'attempt-started',
      payload: { opencodeSessionId: 'sess_root', pid: 42 },
      actor: 'system',
      ...scope,
      attemptId,
    })
    await writeEvent(h.db, {
      taskId: h.taskId,
      kind: 'attempt-subagent-output',
      payload: { sessionId: 'sess_root', content: 'Hello there.' },
      actor: 'system',
      ...scope,
      attemptId,
    })
    const r = await getSessionTree(h.db, h.taskId, h.logicalRunId)
    expect(r.tree.captureComplete).toBe(true)
    const flat = JSON.stringify(r.tree)
    expect(flat).toContain('Hello there.')
  })

  test('subagent tool-use events surface as tool calls', async () => {
    const scope = { nodeId: 'agent_a', loopIter: 0, shardKey: '', iter: 0 } as const
    const attemptId = `att_${ulid()}`
    await writeEvent(h.db, {
      taskId: h.taskId,
      kind: 'attempt-started',
      payload: { opencodeSessionId: 'sess_root' },
      actor: 'system',
      ...scope,
      attemptId,
    })
    await writeEvent(h.db, {
      taskId: h.taskId,
      kind: 'attempt-subagent-tool-use',
      payload: { sessionId: 'sess_root', toolName: 'bash', detail: { cmd: 'ls' } },
      actor: 'system',
      ...scope,
      attemptId,
    })
    const r = await getSessionTree(h.db, h.taskId, h.logicalRunId)
    expect(r.tree.captureComplete).toBe(true)
    const flat = JSON.stringify(r.tree)
    expect(flat).toContain('bash')
  })

  test('404 when task does not exist', async () => {
    await expect(() => getSessionTree(h.db, 'no_such_task', h.logicalRunId)).toThrow()
  })

  test('404 when node_run is not under the task', async () => {
    await expect(() => getSessionTree(h.db, h.taskId, 'no_such_lr')).toThrow()
  })

  test('410 for non-agent node kinds', async () => {
    const h2 = await seed({ nodeKind: 'review' })
    await expect(() => getSessionTree(h2.db, h2.taskId, h2.logicalRunId)).toThrow()
  })
})
