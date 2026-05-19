// RFC-041 — task feedback service + clarify/review enqueue hooks.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memoryDistillJobs, taskFeedback, tasks, workflows } from '../src/db/schema'
import { createTaskFeedback, listTaskFeedback } from '../src/services/taskFeedback'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTask(db: DbClient): string {
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
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return taskId
}

describe('createTaskFeedback', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('inserts the feedback row + enqueues a distill job + back-links job id', async () => {
    const taskId = seedTask(db)
    const r = await createTaskFeedback(db, {
      taskId,
      authorUserId: 'u1',
      bodyMd: 'remember this',
    })
    expect(r.feedback.taskId).toBe(taskId)
    expect(r.feedback.bodyMd).toBe('remember this')
    expect(r.feedback.distilled).toBe(true)
    expect(r.feedback.distillJobId).toBe(r.distillJobId)

    // Distill job row created
    const jobs = db.select().from(memoryDistillJobs).all()
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.sourceKind).toBe('feedback')
    expect(jobs[0]!.sourceEventId).toBe(r.feedback.id)
    expect(jobs[0]!.debounceKey).toBe(`${taskId}:feedback`)

    // Feedback row updated with distill_job_id
    const fb = db.select().from(taskFeedback).where(eq(taskFeedback.id, r.feedback.id)).all()[0]!
    expect(fb.distillJobId).toBe(r.distillJobId)
    expect(fb.distilled).toBe(1)
  })

  test('listTaskFeedback returns asc by createdAt', async () => {
    const taskId = seedTask(db)
    await createTaskFeedback(db, { taskId, authorUserId: null, bodyMd: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    await createTaskFeedback(db, { taskId, authorUserId: null, bodyMd: 'second' })
    const list = await listTaskFeedback(db, taskId)
    expect(list.length).toBe(2)
    expect(list[0]!.bodyMd).toBe('first')
    expect(list[1]!.bodyMd).toBe('second')
  })
})
