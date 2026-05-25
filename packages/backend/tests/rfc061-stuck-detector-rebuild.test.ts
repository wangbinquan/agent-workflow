// RFC-061 follow-up — stuck-task detector rebuilt on the projection.
// Verifies S5 (scheduler-stalled) + S6 (suspension-stale) emit findings
// against the right tasks and stay silent on healthy ones.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'
import { writeEvent } from '../src/services/writeEvents'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  taskId: string
}

async function seed(
  opts: { status?: 'pending' | 'running' | 'done' | 'failed' | 'canceled' } = {},
): Promise<H> {
  const db = createInMemoryDb(MIGRATIONS)
  const wfId = ulid()
  await db.insert(workflows).values({ id: wfId, name: 'wf', definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: opts.status ?? 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { db, taskId }
}

describe('stuckTaskDetector — S5 (scheduler stalled)', () => {
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => resetBroadcastersForTests())

  test('silent when no events exist (task just started)', async () => {
    const { db } = await seed()
    const r = await runStuckTaskDetector({ db, now: () => Date.now() })
    expect(r.scanned).toBe(1)
    expect(r.openAlerts.filter((a) => a.rule === 'S5').length).toBe(0)
  })

  test('silent when the last event is recent', async () => {
    const { db, taskId } = await seed()
    await writeEvent(db, { taskId, kind: 'task-started', payload: {}, actor: 'system' })
    const r = await runStuckTaskDetector({ db, now: () => Date.now() })
    expect(r.openAlerts.filter((a) => a.rule === 'S5').length).toBe(0)
  })

  test('fires when max(events.ts) older than threshold', async () => {
    const { db, taskId } = await seed()
    await writeEvent(db, {
      taskId,
      kind: 'task-started',
      payload: {},
      actor: 'system',
      ts: 1_000_000,
    })
    const now = 1_000_000 + 31 * 60 * 1000
    const r = await runStuckTaskDetector({ db, now: () => now })
    const s5 = r.openAlerts.filter((a) => a.rule === 'S5')
    expect(s5.length).toBe(1)
    expect(s5[0]?.severity).toBe('warning')
  })

  test('silent when task.status != running', async () => {
    const { db, taskId } = await seed({ status: 'done' })
    await writeEvent(db, {
      taskId,
      kind: 'task-started',
      payload: {},
      actor: 'system',
      ts: 1_000_000,
    })
    const now = 1_000_000 + 31 * 60 * 1000
    const r = await runStuckTaskDetector({ db, now: () => now })
    expect(r.openAlerts.length).toBe(0)
  })
})

describe('stuckTaskDetector — S6 (suspension stale)', () => {
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => resetBroadcastersForTests())

  test('fires when an open user-awaited suspension is older than threshold', async () => {
    const { db, taskId } = await seed()
    const baseScope = { nodeId: 'agent_a', loopIter: 0, shardKey: '', iter: 0 } as const
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      ...baseScope,
      ts: 500_000,
    })
    const suspensionId = `sus_${ulid()}`
    await writeEvent(db, {
      taskId,
      kind: 'suspension-created',
      payload: {
        suspensionId,
        signalKind: 'self-clarify',
        awaitsActor: 'user:alice',
        body: { questions: [] },
      },
      actor: 'system',
      ...baseScope,
      ts: 1_000_000,
    })
    const now = 1_000_000 + 31 * 60 * 1000
    const r = await runStuckTaskDetector({ db, now: () => now })
    const s6 = r.openAlerts.filter((a) => a.rule === 'S6')
    expect(s6.length).toBe(1)
    const detail = s6[0]?.detail as { suspensionId?: string }
    expect(detail.suspensionId).toBe(suspensionId)
  })

  test('silent when the suspension is system-awaited (retry-pending-auto)', async () => {
    const { db, taskId } = await seed()
    const baseScope = { nodeId: 'n', loopIter: 0, shardKey: '', iter: 0 } as const
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      ...baseScope,
      ts: 1_000_000,
    })
    const suspensionId = `sus_${ulid()}`
    await writeEvent(db, {
      taskId,
      kind: 'suspension-created',
      payload: {
        suspensionId,
        signalKind: 'retry-pending-auto',
        awaitsActor: 'system',
        body: {},
      },
      actor: 'system',
      ...baseScope,
      ts: 1_000_001,
    })
    const now = 1_000_000 + 60 * 60 * 1000
    const r = await runStuckTaskDetector({ db, now: () => now })
    expect(r.openAlerts.filter((a) => a.rule === 'S6').length).toBe(0)
  })
})
