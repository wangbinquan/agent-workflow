// RFC-311 PR-2 — events archiver at real backlog scale.
//
// The pre-RFC-311 archiver deleted one batch with `DELETE … IN (<toDrop ids>)`.
// Any backlog above SQLite's 32766 bound-parameter limit made that statement a
// hard runtime error, so the hourly archiver FAILED EVERY TICK while the table
// kept growing — the exact death spiral the production 2.2GB DB was in (audit
// L3-4). This file pins the rewrite: range deletes in bounded batches, a
// per-run incremental high-water scan, and a per-tick row budget.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, users, workflows } from '../src/db/schema'
import { archiveEvents, readArchivedEvents } from '../src/services/eventsArchive'
import { readMaintenanceNumber } from '../src/services/maintenanceState'
import { count } from 'drizzle-orm'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Db = ReturnType<typeof createInMemoryDb>

async function seedRun(db: Db, taskId: string, runId: string): Promise<void> {
  const now = 1_788_278_400_000
  await db
    .insert(users)
    .values({
      id: 'u1',
      username: 'u1',
      displayName: 'U',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
  await db
    .insert(workflows)
    .values({ id: 'wf1', name: 'wf', definition: '{"nodes":[],"edges":[],"inputs":[]}' })
    .onConflictDoNothing()
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/never',
      worktreePath: '/tmp/never',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'done',
      inputs: '{}',
      startedAt: 100,
      finishedAt: 200,
      runningMs: 0,
      ownerUserId: 'u1',
    })
    .onConflictDoNothing()
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'n1',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: 100,
  })
}

async function insertEvents(
  db: Db,
  runId: string,
  n: number,
  payloadOf: (i: number) => string = (i) => `line-${i}`,
): Promise<void> {
  const CHUNK = 2_000
  for (let i = 0; i < n; i += CHUNK) {
    const batch = Array.from({ length: Math.min(CHUNK, n - i) }, (_, j) => ({
      nodeRunId: runId,
      ts: 1_000 + i + j,
      kind: 'stderr' as const,
      payload: payloadOf(i + j),
    }))
    await db.insert(nodeRunEvents).values(batch)
  }
}

async function eventCount(db: Db): Promise<number> {
  const rows = await db.select({ n: count(nodeRunEvents.id) }).from(nodeRunEvents)
  return rows[0]?.n ?? 0
}

describe('RFC-311 — events archiver at backlog scale', () => {
  test('a 40k-row backlog (>32766 params under the old shape) archives cleanly', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = mkdtempSync(join(tmpdir(), 'rfc311-arch-'))
    try {
      await seedRun(db, 't1', 'run1')
      await insertEvents(db, 'run1', 40_000)

      const result = await archiveEvents(
        db,
        { eventsArchiveThresholds: { perNodeRunRows: 5_000, globalRows: 1_000_000 } },
        logsDir,
      )
      expect(result.perGroupArchived).toBe(35_000)
      expect(await eventCount(db)).toBe(5_000)

      // The JSONL carries exactly the archived prefix, ids ascending.
      const archived = await readArchivedEvents(logsDir, 't1', 'run1', 0, 50_000)
      expect(archived.length).toBe(35_000)
      expect(archived[0]!.payload).toBe('line-0')
      expect(archived.at(-1)!.payload).toBe('line-34999')

      // DB retains the newest tail — seamless continuation for the reader.
      const remaining = await db
        .select({ payload: nodeRunEvents.payload })
        .from(nodeRunEvents)
        .limit(1)
      expect(remaining[0]?.payload).toBe('line-35000')
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  })

  test('high-water advances after a clean pass and skips unchanged runs', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = mkdtempSync(join(tmpdir(), 'rfc311-arch-hw-'))
    try {
      await seedRun(db, 't1', 'run1')
      await insertEvents(db, 'run1', 1_000)
      const thresholds = { perNodeRunRows: 600, globalRows: 1_000_000 }

      const first = await archiveEvents(db, { eventsArchiveThresholds: thresholds }, logsDir)
      expect(first.perGroupArchived).toBe(400)
      const highWater = await readMaintenanceNumber(db, 'events_archive_high_water')
      expect(highWater).not.toBeNull()

      // No new rows → the incremental scan sees nothing and archives nothing.
      const second = await archiveEvents(db, { eventsArchiveThresholds: thresholds }, logsDir)
      expect(second.perGroupArchived).toBe(0)

      // New rows push the run back over the threshold → caught incrementally.
      await insertEvents(db, 'run1', 200)
      const third = await archiveEvents(db, { eventsArchiveThresholds: thresholds }, logsDir)
      expect(third.perGroupArchived).toBe(200)
      expect(await eventCount(db)).toBe(600)
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  })

  test('byte watermark fires while the ROW watermark is still far away (proposal C3)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = mkdtempSync(join(tmpdir(), 'rfc311-arch-bytes-'))
    try {
      await seedRun(db, 't1', 'run1')
      // 5000 × 1KiB ≈ 5MB — far under the 1M-row watermark, well over 2MB.
      await insertEvents(db, 'run1', 5_000, () => 'x'.repeat(1024))
      const result = await archiveEvents(
        db,
        {
          eventsArchiveThresholds: {
            perNodeRunRows: 1_000_000,
            globalRows: 1_000_000,
            perNodeRunBytes: 0,
            globalBytes: 2 * 1024 * 1024,
          },
        },
        logsDir,
      )
      // Derived rows = 2MiB / (1024B payload + fixed-overhead estimate):
      // exact value tracks the sampling constant, so pin a tolerance band.
      const remaining = await eventCount(db)
      expect(result.globalArchived).toBeGreaterThan(2_500)
      expect(remaining).toBeGreaterThanOrEqual(1_000)
      expect(remaining).toBeLessThanOrEqual(2_200)
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  })

  test('global cap also archives via range deletes without parameter blowups', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const logsDir = mkdtempSync(join(tmpdir(), 'rfc311-arch-glob-'))
    try {
      await seedRun(db, 't1', 'run1')
      await insertEvents(db, 'run1', 36_000)
      const result = await archiveEvents(
        db,
        { eventsArchiveThresholds: { perNodeRunRows: 1_000_000, globalRows: 1_000 } },
        logsDir,
      )
      expect(result.globalArchived).toBe(35_000)
      expect(await eventCount(db)).toBe(1_000)
    } finally {
      rmSync(logsDir, { recursive: true, force: true })
    }
  })
})
