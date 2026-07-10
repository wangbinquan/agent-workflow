import { rimrafDir } from './helpers/cleanup'
// P-4-07: daemon-restart orphan reaper.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { reapOrphanRuns } from '../src/services/orphans'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-orphans-'))
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedRunning(db: DbClient): Promise<{ taskId: string; runId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  const runId = ulid()
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
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'a',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  return { taskId, runId }
}

describe('reapOrphanRuns', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('no-op when no running rows exist', async () => {
    const r = await reapOrphanRuns(h.db)
    expect(r).toEqual({ tasks: 0, runs: 0 })
  })

  test('flips running tasks + node_runs to interrupted with daemon-restart message', async () => {
    const { taskId, runId } = await seedRunning(h.db)
    const r = await reapOrphanRuns(h.db)
    expect(r).toEqual({ tasks: 1, runs: 1 })
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('interrupted')
    expect(t?.errorSummary).toBe('daemon-restart')
    const nr = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(nr?.status).toBe('interrupted')
  })
})
