import { rimrafDir } from './helpers/cleanup'
// P-5-01: events archival background task + endpoint fallback.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { archiveEvents, readArchivedEvents } from '../src/services/eventsArchive'
import { getNodeRunEvents, getNodeRunStdout } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  logsDir: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-events-archive-'))
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    logsDir: join(tmp, 'logs'),
    cleanup: () => rimrafDir(tmp),
  }
}

async function seedTaskWithNodeRun(
  h: Harness,
  opts: { events?: number; kind?: 'text' | 'stderr' } = {},
): Promise<{ taskId: string; nodeRunId: string; eventIds: number[] }> {
  const workflowId = ulid()
  const taskId = ulid()
  const nodeRunId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/r',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  await h.db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'n1',
    status: 'running',
    startedAt: Date.now(),
  })
  const eventIds: number[] = []
  const n = opts.events ?? 0
  for (let i = 0; i < n; i++) {
    const row = await h.db
      .insert(nodeRunEvents)
      .values({
        nodeRunId,
        ts: Date.now() + i,
        kind: opts.kind ?? 'text',
        payload: JSON.stringify({ chunk: i }),
      })
      .returning({ id: nodeRunEvents.id })
    eventIds.push(row[0]!.id)
  }
  return { taskId, nodeRunId, eventIds }
}

describe('archiveEvents', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('no-op when row count is below per-group threshold', async () => {
    const { nodeRunId } = await seedTaskWithNodeRun(h, { events: 5 })
    const r = await archiveEvents(
      h.db,
      { eventsArchiveThresholds: { perNodeRunRows: 10, globalRows: 1000 } },
      h.logsDir,
    )
    expect(r.perGroupArchived).toBe(0)
    expect(r.globalArchived).toBe(0)
    expect(r.files).toEqual([])
    const remaining = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(remaining.length).toBe(5)
  })

  test('archives oldest rows when per-group threshold is exceeded', async () => {
    const { taskId, nodeRunId } = await seedTaskWithNodeRun(h, { events: 10 })
    const r = await archiveEvents(
      h.db,
      { eventsArchiveThresholds: { perNodeRunRows: 4, globalRows: 1000 } },
      h.logsDir,
    )
    expect(r.perGroupArchived).toBe(6)
    expect(r.files.length).toBe(1)
    const file = join(h.logsDir, taskId, `${nodeRunId}.jsonl`)
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(6)
    const first = JSON.parse(lines[0]!) as { id: number; payload: string }
    expect(first.payload).toContain('"chunk":0')
    // DB now holds the latest 4.
    const remaining = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    expect(remaining.length).toBe(4)
  })

  test('archives globally when total exceeds globalRows even if per-group is fine', async () => {
    // Two node_runs, each with 5 events; perNodeRunRows=10 (untouched), globalRows=6.
    const a = await seedTaskWithNodeRun(h, { events: 5 })
    const b = await seedTaskWithNodeRun(h, { events: 5 })
    const r = await archiveEvents(
      h.db,
      { eventsArchiveThresholds: { perNodeRunRows: 10, globalRows: 6 } },
      h.logsDir,
    )
    expect(r.perGroupArchived).toBe(0)
    expect(r.globalArchived).toBeGreaterThan(0)
    const remainingA = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, a.nodeRunId))
    const remainingB = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, b.nodeRunId))
    expect(remainingA.length + remainingB.length).toBeLessThanOrEqual(6)
    // Oldest node_run (a) is the one that gets shaved.
    expect(remainingA.length).toBeLessThan(5)
  })

  test('getNodeRunEvents falls back to JSONL for archived ids', async () => {
    const { taskId, nodeRunId, eventIds } = await seedTaskWithNodeRun(h, { events: 8 })
    await archiveEvents(
      h.db,
      { eventsArchiveThresholds: { perNodeRunRows: 3, globalRows: 1000 } },
      h.logsDir,
    )
    // since=0 should return all 8 events: 5 from archive + 3 from DB, in id order.
    const r = await getNodeRunEvents(h.db, taskId, nodeRunId, { logsDir: h.logsDir })
    expect(r.events.length).toBe(8)
    expect(r.events.map((e) => e.id)).toEqual(eventIds)
    expect(r.cursor).toBe(eventIds[eventIds.length - 1]!)
  })

  test('getNodeRunEvents since cursor skips archived rows already seen', async () => {
    const { taskId, nodeRunId, eventIds } = await seedTaskWithNodeRun(h, { events: 8 })
    await archiveEvents(
      h.db,
      { eventsArchiveThresholds: { perNodeRunRows: 3, globalRows: 1000 } },
      h.logsDir,
    )
    // since=fourth-event-id -> should return events 5..8 (4 rows).
    const since = eventIds[3]!
    const r = await getNodeRunEvents(h.db, taskId, nodeRunId, { since, logsDir: h.logsDir })
    expect(r.events.length).toBe(4)
    expect(r.events.map((e) => e.id)).toEqual(eventIds.slice(4))
  })

  test('getNodeRunStdout includes archived + live rows in order', async () => {
    const { taskId, nodeRunId } = await seedTaskWithNodeRun(h, { events: 6 })
    await archiveEvents(
      h.db,
      { eventsArchiveThresholds: { perNodeRunRows: 2, globalRows: 1000 } },
      h.logsDir,
    )
    const text = await getNodeRunStdout(h.db, taskId, nodeRunId, { logsDir: h.logsDir })
    const lines = text.split('\n')
    expect(lines.length).toBe(6)
    expect(lines[0]!).toContain('"chunk":0')
    expect(lines[5]!).toContain('"chunk":5')
  })

  test('readArchivedEvents returns [] when file does not exist', async () => {
    const rows = await readArchivedEvents(h.logsDir, 'no-such-task', 'no-such-run', 0, 100)
    expect(rows).toEqual([])
  })
})
