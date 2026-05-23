// RFC-061 PR-B T9-extra — daemon resume sequence tests (design.md §8).

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  attempts,
  events as eventsTable,
  logicalRuns,
  projectionMeta,
  tasks,
  workflows,
} from '../src/db/schema'
import { writeEvents } from '../src/services/writeEvents'
import {
  catchUpProjections,
  enqueueResumeWakes,
  markCrashedAttempts,
  resumeFromDisk,
} from '../src/scheduler-v2/daemonResume'
import { TaskActorRegistry, taskActorRegistry } from '../src/scheduler-v2/actorRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function setupDb(
  taskStatus: 'pending' | 'running' | 'done' | 'awaiting_review' = 'running',
): DbClient {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(workflows)
    .values({
      id: 'wf1',
      name: 'test-wf',
      schemaVersion: 4,
      definition: '{}',
    })
    .run()
  db.insert(tasks)
    .values({
      id: 't1',
      name: 'rfc061-resume-test',
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw-resume-test/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'agent-workflow/t1',
      status: taskStatus,
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    .run()
  return db
}

describe('catchUpProjections', () => {
  test('cursor=NULL → full rebuild', () => {
    const db = setupDb()
    const r = catchUpProjections(db, 100)
    expect(r.fullRebuild).toBe(true)
  })

  test('no new events → 0 incremental', async () => {
    const db = setupDb()
    await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'n1',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
    ])
    const r = catchUpProjections(db, 100)
    expect(r.fullRebuild).toBe(false)
    expect(r.appliedEvents).toBe(0)
  })
})

describe('markCrashedAttempts', () => {
  test('no orphan attempts → 0', async () => {
    const db = setupDb()
    const n = await markCrashedAttempts(db)
    expect(n).toBe(0)
  })

  test('orphan attempt → attempt-finished-crash event written', async () => {
    const db = setupDb()
    // Seed a logical_run + an in-flight attempt (no finishedAt).
    await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'attempt-started',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId: 'att_pending',
        actor: 'system',
        payload: {},
      },
    ])
    // Verify the orphan attempts row exists.
    const before = db.select().from(attempts).all()
    expect(before).toHaveLength(1)
    expect(before[0]!.finishedAt).toBeNull()

    const n = await markCrashedAttempts(db)
    expect(n).toBe(1)

    const after = db.select().from(attempts).all()
    expect(after[0]!.outcome).toBe('crash')
    expect(after[0]!.finishedAt).not.toBeNull()
    expect(after[0]!.errorMessage).toContain('daemon-restart-orphan-attempt')

    const crashEvents = db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.kind, 'attempt-finished-crash'))
      .all()
    expect(crashEvents).toHaveLength(1)
  })
})

describe('enqueueResumeWakes', () => {
  test('terminal task → no resume', async () => {
    const db = setupDb('done')
    // Clear the registry to avoid leaking actor state across tests
    // (taskActorRegistry is a singleton — bun:test parallel files share it).
    taskActorRegistry.deregisterAll('test-isolate')
    const n = await enqueueResumeWakes(db)
    expect(n).toBe(0)
  })

  test('running task → resume event written + actor registered', async () => {
    const db = setupDb('running')
    taskActorRegistry.deregisterAll('test-isolate')
    const n = await enqueueResumeWakes(db)
    expect(n).toBe(1)

    const resumeEvents = db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.kind, 'task-resumed-after-daemon-restart'))
      .all()
    expect(resumeEvents).toHaveLength(1)

    const actor = taskActorRegistry.get('t1')
    expect(actor).toBeDefined()
    expect(actor!.queue.bufferedCount).toBeGreaterThan(0)

    taskActorRegistry.deregisterAll('cleanup')
  })

  test('awaiting_review task (legacy status) → still resumed', async () => {
    const db = setupDb('awaiting_review')
    taskActorRegistry.deregisterAll('test-isolate')
    const n = await enqueueResumeWakes(db)
    expect(n).toBe(1)
    taskActorRegistry.deregisterAll('cleanup')
  })
})

describe('resumeFromDisk (full sequence)', () => {
  test('happy path with orphan attempt + running task', async () => {
    const db = setupDb('running')
    // Seed: logical-run + in-flight attempt + projection state.
    await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'attempt-started',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId: 'att_pending',
        actor: 'system',
        payload: {},
      },
    ])
    taskActorRegistry.deregisterAll('test-isolate')

    const report = await resumeFromDisk({ db })
    expect(report.crashedAttempts).toBe(1)
    expect(report.resumedTasks).toBe(1)

    // After resume, the attempt should be marked crashed (orphan handler).
    const aft = db.select().from(attempts).all()
    expect(aft[0]!.outcome).toBe('crash')

    // Projection cursor should be advanced.
    const cursor = db.select().from(projectionMeta).all()[0]
    expect(cursor!.lastProcessedEventId).not.toBeNull()

    taskActorRegistry.deregisterAll('cleanup')
  })

  test('empty events table → no crashed/no resume', async () => {
    const db = setupDb('done')
    taskActorRegistry.deregisterAll('test-isolate')
    const report = await resumeFromDisk({ db })
    expect(report.crashedAttempts).toBe(0)
    expect(report.resumedTasks).toBe(0)
  })
})

import { eq } from 'drizzle-orm'
// Re-export to silence the unused TaskActorRegistry import (kept for future tests).
void TaskActorRegistry
// Re-export logicalRuns to silence its currently-unused import.
void logicalRuns
