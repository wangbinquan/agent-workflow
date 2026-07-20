// P-4-04: per-task duration + token limit enforcement.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { enforceLimits } from '../src/services/limits'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-limits-'))
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedTask(
  db: DbClient,
  overrides: Partial<typeof tasks.$inferInsert>,
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now() - 1000,
    ...overrides,
  })
  return taskId
}

describe('enforceLimits', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('no-op when no running tasks', async () => {
    const r = await enforceLimits(h.db)
    expect(r).toEqual({ scanned: 0, canceled: [] })
  })

  test('cancels task whose duration exceeds maxDurationMs', async () => {
    // RFC-207 §3.8 — the cap is measured against ACCUMULATED running time, so the
    // seed must open a running stretch (`runningSince`) rather than only backdate
    // `startedAt`; wall clock since creation no longer decides this.
    const startedAt = Date.now() - 10_000
    const taskId = await seedTask(h.db, {
      maxDurationMs: 5_000,
      startedAt,
      runningSince: startedAt,
    })
    const r = await enforceLimits(h.db, Date.now())
    expect(r.canceled).toEqual([taskId])
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('canceled')
    expect(t?.errorSummary).toBe('task-time-limit-exceeded')
  })

  test('leaves a task alone when within its duration cap', async () => {
    const startedAt = Date.now() - 1_000
    const taskId = await seedTask(h.db, { maxDurationMs: 60_000, startedAt })
    const r = await enforceLimits(h.db)
    expect(r.canceled).toEqual([])
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('running')
  })

  test('cancels task when total tokens exceed maxTotalTokens', async () => {
    const taskId = await seedTask(h.db, { maxTotalTokens: 100 })
    // Two node_runs with 60 and 80 tokens → total 140 > 100.
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'a',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      tokTotal: 60,
    })
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'b',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      tokTotal: 80,
    })
    const r = await enforceLimits(h.db)
    expect(r.canceled).toEqual([taskId])
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.errorSummary).toBe('task-token-limit-exceeded')
    expect(t?.errorMessage).toContain('140')
  })

  test('maxTotalTokens=0 disables the token cap', async () => {
    const taskId = await seedTask(h.db, { maxTotalTokens: 0 })
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'a',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      tokTotal: 999_999,
    })
    const r = await enforceLimits(h.db)
    expect(r.canceled).toEqual([])
  })
})
