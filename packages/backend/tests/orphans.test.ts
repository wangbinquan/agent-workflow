import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { o2Ports } from './helpers/o2Closure'
// P-4-07: daemon-restart orphan reaper.

import {
  nodeRunFixture,
  patchNodeRunFixture,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { describeEachProvider } from './helpers/eachProvider'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { reapOrphanRuns } from '../src/services/orphans'
import {
  claimNewRuntimeSession,
  repairRuntimeSessionLeasesAfterOrphanReap,
} from '../src/services/runtimeSessionLease'
import { createTaskExecutionPersistence } from '../src/modules/task-execution/composition/taskExecutionPersistence'
import { createRuntimeSessionLeaseOperations } from '../src/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'

interface Harness {
  db: PersistenceDb
  appHome: string
  cleanup: () => void
}

function buildHarness(db: PersistenceDb): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-orphans-'))
  return {
    db,
    appHome,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedRunning(db: PersistenceDb): Promise<{ taskId: string; runId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  const runId = ulid()
  await workflowFixture(db, {
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await taskFixture(db, {
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
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
  await nodeRunFixture(db, {
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

describeEachProvider('reapOrphanRuns', (harness) => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness(harness.db)
  })
  afterEach(() => h.cleanup())

  test('no-op when no running rows exist', async () => {
    const r = await reapOrphanRuns(
      createTaskExecutionPersistence(h.db, {
        historyRestrictions: epoch2RuntimeTestPorts(h.db).historyRestrictions,
        recoveryHumanGates: o2Ports(h.db).collaborationReads.recovery,
      }).recoveryAdministration,
    )
    expect(r).toEqual({ tasks: 0, runs: 0 })
  })

  test('flips running tasks + node_runs to interrupted with daemon-restart message', async () => {
    const { taskId, runId } = await seedRunning(h.db)
    const r = await reapOrphanRuns(
      createTaskExecutionPersistence(h.db, {
        historyRestrictions: epoch2RuntimeTestPorts(h.db).historyRestrictions,
        recoveryHumanGates: o2Ports(h.db).collaborationReads.recovery,
      }).recoveryAdministration,
    )
    expect(r).toEqual({ tasks: 1, runs: 1 })
    const { nodeRuns } = tablesOf(h.db)
    const t = (await readTaskFixtures(h.db, { id: taskId }))[0]
    expect(t?.status).toBe('interrupted')
    expect(t?.errorSummary).toBe('daemon-restart')
    const nr = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(nr?.status).toBe('interrupted')
  })

  test('a child which survives SIGKILL aborts the barrier and leaves its run live', async () => {
    const { runId } = await seedRunning(h.db)
    await expect(
      reapOrphanRuns(
        createTaskExecutionPersistence(h.db, {
          historyRestrictions: epoch2RuntimeTestPorts(h.db).historyRestrictions,
          recoveryHumanGates: o2Ports(h.db).collaborationReads.recovery,
        }).recoveryAdministration,
        {
          killStaleRunProcessTree: async () => 'kill-failed',
        },
      ),
    ).rejects.toThrow('boot recovery refused')
    const { nodeRuns } = tablesOf(h.db)
    const nr = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(nr?.status).toBe('running')
  })

  test('terminal run with a held native lease is reaped before lease repair', async () => {
    const { taskId, runId } = await seedRunning(h.db)
    await claimNewRuntimeSession(createRuntimeSessionLeaseOperations(h.db), {
      protocol: 'claude-code',
      sessionId: 'terminal-held-native',
      taskId,
      nodeId: 'a',
      currentNodeRunId: runId,
      leaseNonceDigest: 'terminal-held-nonce',
    })
    const { runtimeSessionLeases } = tablesOf(h.db)
    await patchNodeRunFixture(
      h.db,
      { id: runId },
      { status: 'failed', failureCode: 'runtime-session-identity-invalid', pid: 4242 },
    )
    const calls: string[] = []

    await reapOrphanRuns(
      createTaskExecutionPersistence(h.db, {
        historyRestrictions: epoch2RuntimeTestPorts(h.db).historyRestrictions,
        recoveryHumanGates: o2Ports(h.db).collaborationReads.recovery,
      }).recoveryAdministration,
      {
        killStaleRunProcessTree: async (row) => {
          calls.push(`kill:${row.pid}`)
          return 'killed'
        },
      },
    )
    expect(calls).toEqual(['kill:4242'])
    expect(
      await repairRuntimeSessionLeasesAfterOrphanReap(
        createRuntimeSessionLeaseOperations(h.db),
        true,
      ),
    ).toBe(1)
    expect(
      await first(
        h.db
          .select()
          .from(runtimeSessionLeases)
          .where(eq(runtimeSessionLeases.sessionId, 'terminal-held-native')),
      ),
    ).toBeUndefined()
  })

  test('terminal child that survives keeps its native lease held and aborts boot recovery', async () => {
    const { taskId, runId } = await seedRunning(h.db)
    await claimNewRuntimeSession(createRuntimeSessionLeaseOperations(h.db), {
      protocol: 'claude-code',
      sessionId: 'terminal-live-native',
      taskId,
      nodeId: 'a',
      currentNodeRunId: runId,
      leaseNonceDigest: 'terminal-live-nonce',
    })
    const { runtimeSessionLeases } = tablesOf(h.db)
    await patchNodeRunFixture(h.db, { id: runId }, { status: 'failed', pid: 4343 })

    await expect(
      reapOrphanRuns(
        createTaskExecutionPersistence(h.db, {
          historyRestrictions: epoch2RuntimeTestPorts(h.db).historyRestrictions,
          recoveryHumanGates: o2Ports(h.db).collaborationReads.recovery,
        }).recoveryAdministration,
        {
          killStaleRunProcessTree: async () => 'kill-failed',
        },
      ),
    ).rejects.toThrow('boot recovery refused')
    expect(
      await first(
        h.db
          .select({ holder: runtimeSessionLeases.leaseNodeRunId })
          .from(runtimeSessionLeases)
          .where(eq(runtimeSessionLeases.sessionId, 'terminal-live-native')),
      ),
    ).toEqual({ holder: runId })
  })

  test('a held native lease with no PID is not treated as proof that its child is gone', async () => {
    const { taskId, runId } = await seedRunning(h.db)
    await claimNewRuntimeSession(createRuntimeSessionLeaseOperations(h.db), {
      protocol: 'claude-code',
      sessionId: 'held-without-pid',
      taskId,
      nodeId: 'a',
      currentNodeRunId: runId,
      leaseNonceDigest: 'held-without-pid-nonce',
    })

    await expect(
      reapOrphanRuns(
        createTaskExecutionPersistence(h.db, {
          historyRestrictions: epoch2RuntimeTestPorts(h.db).historyRestrictions,
          recoveryHumanGates: o2Ports(h.db).collaborationReads.recovery,
        }).recoveryAdministration,
        {
          killStaleRunProcessTree: async () => 'no-pid',
        },
      ),
    ).rejects.toThrow('reap was unproven')
    const { runtimeSessionLeases } = tablesOf(h.db)
    expect(
      await first(
        h.db
          .select({ holder: runtimeSessionLeases.leaseNodeRunId })
          .from(runtimeSessionLeases)
          .where(eq(runtimeSessionLeases.sessionId, 'held-without-pid')),
      ),
    ).toEqual({ holder: runId })
  })
})
