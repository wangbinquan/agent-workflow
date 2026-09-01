// P-4-07: daemon-restart orphan reaper.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, runtimeSessionLeases, tasks, workflows } from '../src/db/schema'
import { reapOrphanRuns } from '../src/services/orphans'
import {
  claimNewRuntimeSession,
  repairRuntimeSessionLeasesAfterOrphanReap,
} from '../src/services/runtimeSessionLease'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'
import { createSqliteRuntimeSessionLeaseOperations } from '../src/modules/task-execution/infrastructure/sqliteRuntimeSessionLeaseOperations'

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
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
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
    const r = await reapOrphanRuns(taskRecoveryOperations(h.db))
    expect(r).toEqual({ tasks: 0, runs: 0 })
  })

  test('flips running tasks + node_runs to interrupted with daemon-restart message', async () => {
    const { taskId, runId } = await seedRunning(h.db)
    const r = await reapOrphanRuns(taskRecoveryOperations(h.db))
    expect(r).toEqual({ tasks: 1, runs: 1 })
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('interrupted')
    expect(t?.errorSummary).toBe('daemon-restart')
    const nr = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(nr?.status).toBe('interrupted')
  })

  test('a child which survives SIGKILL aborts the barrier and leaves its run live', async () => {
    const { runId } = await seedRunning(h.db)
    await expect(
      reapOrphanRuns(taskRecoveryOperations(h.db), {
        killStaleRunProcessTree: async () => 'kill-failed',
      }),
    ).rejects.toThrow('boot recovery refused')
    const nr = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(nr?.status).toBe('running')
  })

  test('terminal run with a held native lease is reaped before lease repair', async () => {
    const { taskId, runId } = await seedRunning(h.db)
    await claimNewRuntimeSession(createSqliteRuntimeSessionLeaseOperations(h.db), {
      protocol: 'claude-code',
      sessionId: 'terminal-held-native',
      taskId,
      nodeId: 'a',
      currentNodeRunId: runId,
      leaseNonceDigest: 'terminal-held-nonce',
    })
    await h.db
      .update(nodeRuns)
      .set({ status: 'failed', failureCode: 'runtime-session-identity-invalid', pid: 4242 })
      .where(eq(nodeRuns.id, runId))
    const calls: string[] = []

    await reapOrphanRuns(taskRecoveryOperations(h.db), {
      killStaleRunProcessTree: async (row) => {
        calls.push(`kill:${row.pid}`)
        return 'killed'
      },
    })
    expect(calls).toEqual(['kill:4242'])
    expect(
      await repairRuntimeSessionLeasesAfterOrphanReap(
        createSqliteRuntimeSessionLeaseOperations(h.db),
        true,
      ),
    ).toBe(1)
    expect(
      h.db
        .select()
        .from(runtimeSessionLeases)
        .where(eq(runtimeSessionLeases.sessionId, 'terminal-held-native'))
        .get(),
    ).toBeUndefined()
  })

  test('terminal child that survives keeps its native lease held and aborts boot recovery', async () => {
    const { taskId, runId } = await seedRunning(h.db)
    await claimNewRuntimeSession(createSqliteRuntimeSessionLeaseOperations(h.db), {
      protocol: 'claude-code',
      sessionId: 'terminal-live-native',
      taskId,
      nodeId: 'a',
      currentNodeRunId: runId,
      leaseNonceDigest: 'terminal-live-nonce',
    })
    await h.db.update(nodeRuns).set({ status: 'failed', pid: 4343 }).where(eq(nodeRuns.id, runId))

    await expect(
      reapOrphanRuns(taskRecoveryOperations(h.db), {
        killStaleRunProcessTree: async () => 'kill-failed',
      }),
    ).rejects.toThrow('boot recovery refused')
    expect(
      h.db
        .select({ holder: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(eq(runtimeSessionLeases.sessionId, 'terminal-live-native'))
        .get(),
    ).toEqual({ holder: runId })
  })

  test('a held native lease with no PID is not treated as proof that its child is gone', async () => {
    const { taskId, runId } = await seedRunning(h.db)
    await claimNewRuntimeSession(createSqliteRuntimeSessionLeaseOperations(h.db), {
      protocol: 'claude-code',
      sessionId: 'held-without-pid',
      taskId,
      nodeId: 'a',
      currentNodeRunId: runId,
      leaseNonceDigest: 'held-without-pid-nonce',
    })

    await expect(
      reapOrphanRuns(taskRecoveryOperations(h.db), {
        killStaleRunProcessTree: async () => 'no-pid',
      }),
    ).rejects.toThrow('reap was unproven')
    expect(
      h.db
        .select({ holder: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(eq(runtimeSessionLeases.sessionId, 'held-without-pid'))
        .get(),
    ).toEqual({ holder: runId })
  })
})
