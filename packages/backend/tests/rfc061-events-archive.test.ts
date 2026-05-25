// RFC-061 follow-up P1-5 — events archival on the projection model.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { events as eventsTable, eventsArchive, tasks, workflows } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { archiveEvents } from '../src/services/eventsArchive'
import { writeEvent } from '../src/services/writeEvents'
import { listTaskTimeline } from '../src/services/timeline'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAY_MS = 86_400_000

interface Seeded {
  db: DbClient
  taskId: string
}

async function seedTerminalTask(opts: {
  finishedAt: number
  status?: 'done' | 'failed' | 'canceled' | 'interrupted'
}): Promise<Seeded> {
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
    status: opts.status ?? 'done',
    inputs: '{}',
    startedAt: opts.finishedAt - 60_000,
    finishedAt: opts.finishedAt,
  })
  await writeEvent(db, { taskId, kind: 'task-started', payload: {}, actor: 'system' })
  await writeEvent(db, { taskId, kind: 'task-completed', payload: {}, actor: 'system' })
  return { db, taskId }
}

describe('archiveEvents', () => {
  test('terminal task older than cutoff: events move to events_archive', async () => {
    const finishedAt = 1_000_000
    const { db, taskId } = await seedTerminalTask({ finishedAt })
    const now = finishedAt + 31 * DAY_MS
    const r = await archiveEvents(db, { now: () => now })
    expect(r.archivedTasks).toBe(1)
    expect(r.archivedRows).toBeGreaterThan(0)

    const live = await db.select().from(eventsTable).where(eq(eventsTable.taskId, taskId))
    expect(live.length).toBe(0)

    const arch = await db.select().from(eventsArchive).where(eq(eventsArchive.taskId, taskId))
    expect(arch.length).toBe(r.archivedRows)
    expect(arch[0]?.archivedAt).toBe(now)
  })

  test('terminal task inside cutoff: events stay live', async () => {
    const finishedAt = 1_000_000
    const { db, taskId } = await seedTerminalTask({ finishedAt })
    const now = finishedAt + 5 * DAY_MS
    const r = await archiveEvents(db, { now: () => now })
    expect(r.archivedTasks).toBe(0)
    const live = await db.select().from(eventsTable).where(eq(eventsTable.taskId, taskId))
    expect(live.length).toBeGreaterThan(0)
  })

  test('non-terminal task: never archives even if old', async () => {
    const finishedAt = 1_000_000
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(workflows).values({ id: 'wf', name: 'wf', definition: '{}' })
    await db.insert(tasks).values({
      id: 'running-task',
      name: 't',
      workflowId: 'wf',
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/running-task',
      status: 'running',
      inputs: '{}',
      startedAt: finishedAt - 60_000,
      finishedAt: null,
    })
    await writeEvent(db, {
      taskId: 'running-task',
      kind: 'task-started',
      payload: {},
      actor: 'system',
    })
    const r = await archiveEvents(db, { now: () => finishedAt + 90 * DAY_MS })
    expect(r.archivedTasks).toBe(0)
  })

  test('timeline endpoint falls back to archive for archived tasks', async () => {
    const finishedAt = 1_000_000
    const { db, taskId } = await seedTerminalTask({ finishedAt })
    await archiveEvents(db, { now: () => finishedAt + 31 * DAY_MS })

    const r = await listTaskTimeline(db, taskId, { afterId: null, limit: 100, kindFilter: null })
    expect(r.events.length).toBeGreaterThan(0)
    const kinds = r.events.map((e) => e.kind)
    expect(kinds).toContain('task-started')
    expect(kinds).toContain('task-completed')
  })
})
