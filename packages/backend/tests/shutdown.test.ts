import { readTaskFixtures, taskFixture, workflowFixture } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '../src/modules/task-execution/domain/ownership'
import { DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import { runtimeSession, lifecycle } from './helpers/daemonLifecycle'
// P-4-06: graceful shutdown budget.
//
// We don't spawn a real daemon process here — the budget loop polls the DB
// for tasks in `running` and flips survivors to `interrupted`. We seed a
// task that stays running and verify the survivor path.

import { describeEachProvider } from './helpers/eachProvider'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { gracefulShutdown } from '../src/services/shutdown'
import {
  taskExecutionModule,
  createTaskExecutionShutdownController,
  createProviderTaskExecutionModule,
  createTaskExecutionTestModule,
} from '../src/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '../src/modules/task-execution/composition/taskExecutionPersistence'

interface Harness {
  db: PersistenceDb
  appHome: string
  cleanup: () => void
}

function buildHarness(db: PersistenceDb): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-shutdown-'))
  return {
    db,
    appHome,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedRunning(db: PersistenceDb): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await workflowFixture(db, {
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await taskFixture(db, {
    name: 'fixture-task',

    id: taskId,
    // Preserve the root lineage supplied by the original SQLite INSERT trigger.
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
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

describeEachProvider('gracefulShutdown', (harness) => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness(harness.db)
  })
  afterEach(() => {
    taskExecutionModule.resetForTesting()
    h.cleanup()
  })

  test('returns immediately when no tasks are running', async () => {
    const t0 = Date.now()
    const persistence = createTaskExecutionPersistence(h.db)
    await gracefulShutdown(
      {
        controller: {
          async shutdownActive() {
            return []
          },
        },
        operations: persistence.shutdown,
        recovery: persistence.recoveryAdministration,
      },
      5000,
    )
    expect(Date.now() - t0).toBeLessThan(500)
  })

  test('flips survivors to interrupted after budget elapses', async () => {
    const taskId = await seedRunning(h.db)
    // No AbortController registered — abortAllActiveTasks is a no-op, and
    // the row stays running. After the short budget, the survivor path
    // marks it interrupted.
    const persistence = createTaskExecutionPersistence(h.db)
    await gracefulShutdown(
      {
        controller: {
          async shutdownActive() {
            return []
          },
        },
        operations: persistence.shutdown,
        recovery: persistence.recoveryAdministration,
      },
      300,
    )
    const t = (await readTaskFixtures(h.db, { id: taskId }))[0]
    expect(t?.status).toBe('interrupted')
    // RFC-202 T4: survivors stamp DAEMON_RESTART_ERROR_SUMMARY ('daemon-restart')
    // — the exact summary autoResume's boot pass matches — instead of the old
    // 'daemon-shutdown' string that no recovery path ever picked up.
    expect(t?.errorSummary).toBe('daemon-restart')
  })
  // RFC-379: a driver that ignores abort cannot hold the provider open indefinitely.
  test('session shutdown bounds a stuck provider driver then persists its survivor', async () => {
    const taskId = await seedRunning(h.db)
    const persistence = createTaskExecutionPersistence(h.db)
    const module =
      harness.applicationBinding.provider === 'postgresql'
        ? createProviderTaskExecutionModule({ daemonGeneration: 'rfc379', persistence })
        : createTaskExecutionTestModule('rfc379')
    const { taskExecutionOwners } = tablesOf(h.db)
    await insertOne(h.db, taskExecutionOwners, {
      taskId,
      ownerId: 'driver',
      daemonGeneration: 'rfc379',
      epoch: 1,
      state: 'claimed',
      leaseUntil: Date.now() + 60_000,
      revision: 1,
      lastHeartbeatAt: Date.now(),
      updatedAt: Date.now(),
    })
    const unrelated = createTaskExecutionTestModule('unrelated')
    const driver = new AbortController()
    const token = createOwnershipToken({
      taskId,
      identity: createWorkerIdentity({ ownerId: 'driver', daemonGeneration: 'rfc379' }),
      epoch: 1,
      leaseUntil: Date.now() + 60_000,
      ownerRevision: 1,
    })
    const permit = module.claimGate.enter()
    module.claimGate.bind(permit, token)
    expect(
      module.runtimeRegistry.tryAttach({ token, intentId: 'fixture', permit, controller: driver }),
    ).toBe('attached')
    module.claimGate.leave(permit)
    let aborted = false,
      providerClosed = false
    const controller = createTaskExecutionShutdownController(module)
    const session = await runtimeSession({
      provider: harness.applicationBinding.provider,
      runtimeFactories: [
        {
          id: 'task-execution',
          stopTimeoutMs: 10,
          start: () => ({
            async stop() {
              const tickets = await module.pause(DAEMON_SHUTDOWN_ABORT_REASON)
              aborted = driver.signal.aborted
              await Promise.all(
                tickets.map((ticket) => module.runtimeRegistry.awaitStopped(ticket)),
              )
            },
            drain() {},
          }),
        },
      ],
      providerCloseParticipants: [
        {
          id: 'task-execution-graceful-shutdown',
          close: () =>
            gracefulShutdown(
              {
                controller,
                operations: persistence.shutdown,
                recovery: persistence.recoveryAdministration,
              },
              0,
            ),
        },
      ],
      closeProvider: () => {
        providerClosed = true
      },
    })
    await session.resume({ ...lifecycle, provider: harness.applicationBinding.provider })
    await session.close({ reason: 'daemon-shutdown' })
    expect(aborted).toBe(true)
    expect(providerClosed).toBe(true)
    expect(module.claimGate.isSealed).toBe(true)
    expect(unrelated.claimGate.isSealed).toBe(false)
    expect(session.state().jobs[0]!.stopOutcome).toBe('timeout')
    const row = (await readTaskFixtures(h.db, { id: taskId }))[0]!
    expect(row.status).toBe('interrupted')
    expect(row.errorSummary).toBe('daemon-restart')
    expect(
      (
        await h.db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
      )[0]?.recoveryCode,
    ).toBe('daemon-shutdown-survivor')
    expect(driver.signal.reason).toBe(DAEMON_SHUTDOWN_ABORT_REASON)
    module.runtimeRegistry.release({ token, controller: driver })
    module.runtimeRegistry.settle(token)
  })
})
