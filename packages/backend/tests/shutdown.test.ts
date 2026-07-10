import { rimrafDir } from './helpers/cleanup'
// P-4-06: graceful shutdown budget.
//
// We don't spawn a real daemon process here — the budget loop polls the DB
// for tasks in `running` and flips survivors to `interrupted`. We seed a
// task that stays running and verify the survivor path.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { gracefulShutdown } from '../src/services/shutdown'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-shutdown-'))
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedRunning(db: DbClient): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
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

describe('gracefulShutdown', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('returns immediately when no tasks are running', async () => {
    const t0 = Date.now()
    await gracefulShutdown(h.db, 5000)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  test('flips survivors to interrupted after budget elapses', async () => {
    const taskId = await seedRunning(h.db)
    // No AbortController registered — abortAllActiveTasks is a no-op, and
    // the row stays running. After the short budget, the survivor path
    // marks it interrupted.
    await gracefulShutdown(h.db, 300)
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('interrupted')
    expect(t?.errorSummary).toBe('daemon-shutdown')
  })
})
