// RFC-061 follow-up P2-1 — resolveSuspension enqueues a distill job
// after every self-clarify / cross-clarify / review resolution.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memoryDistillJobs, tasks, workflows } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { resolveSuspension } from '../src/services/suspensions'
import { writeEvent } from '../src/services/writeEvents'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  taskId: string
}

async function seed(): Promise<H> {
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
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { db, taskId }
}

async function seedSuspension(
  db: DbClient,
  taskId: string,
  kind: 'self-clarify' | 'review',
): Promise<string> {
  const scope = { nodeId: 'agent_a', loopIter: 0, shardKey: '', iter: 0 } as const
  await writeEvent(db, {
    taskId,
    kind: 'logical-run-created',
    payload: {},
    actor: 'system',
    ...scope,
  })
  const suspensionId = `sus_${ulid()}`
  const body =
    kind === 'self-clarify'
      ? { questions: [{ id: 'q1', text: 'what color?' }] }
      : { docNodeId: 'agent_a', docPortName: 'out', docContent: 'draft' }
  await writeEvent(db, {
    taskId,
    kind: 'suspension-created',
    payload: { suspensionId, signalKind: kind, awaitsActor: 'user:alice', body },
    actor: 'system',
    ...scope,
  })
  return suspensionId
}

describe('resolveSuspension → enqueueDistillJob', () => {
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => resetBroadcastersForTests())

  test('self-clarify resolution enqueues a clarify distill job', async () => {
    const { db, taskId } = await seed()
    const suspensionId = await seedSuspension(db, taskId, 'self-clarify')
    await resolveSuspension(db, suspensionId, {
      answers: [{ questionId: 'q1', text: 'blue' }],
    })
    const jobs = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.sourceEventId, suspensionId))
    expect(jobs.length).toBe(1)
    expect(jobs[0]?.sourceKind).toBe('clarify')
    expect(jobs[0]?.taskId).toBe(taskId)
  })

  test('review approve enqueues a review distill job', async () => {
    const { db, taskId } = await seed()
    const suspensionId = await seedSuspension(db, taskId, 'review')
    await resolveSuspension(db, suspensionId, { decision: 'approve' })
    const jobs = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.sourceEventId, suspensionId))
    expect(jobs.length).toBe(1)
    expect(jobs[0]?.sourceKind).toBe('review')
  })

  test('retry-pending-human resolution does NOT enqueue a distill job', async () => {
    const { db, taskId } = await seed()
    const scope = { nodeId: 'agent_a', loopIter: 0, shardKey: '', iter: 0 } as const
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      ...scope,
    })
    const suspensionId = `sus_${ulid()}`
    await writeEvent(db, {
      taskId,
      kind: 'suspension-created',
      payload: {
        suspensionId,
        signalKind: 'retry-pending-human',
        awaitsActor: 'user:alice',
        body: {},
      },
      actor: 'system',
      ...scope,
    })
    await resolveSuspension(db, suspensionId, { decision: 'retry' })
    const jobs = await db
      .select()
      .from(memoryDistillJobs)
      .where(eq(memoryDistillJobs.sourceEventId, suspensionId))
    expect(jobs.length).toBe(0)
  })
})
