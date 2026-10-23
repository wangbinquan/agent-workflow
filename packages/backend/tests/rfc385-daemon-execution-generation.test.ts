// RFC-385: reproduce former standalone wiring through real boot recovery on both providers,
// then prove process generations release crash/shutdown owners for a real successor claim.
import { nodeRunFixture, readNodeRunFixtures } from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import {
  createProviderTaskExecutionModule,
  createTaskExecutionShutdownController,
} from '@/modules/task-execution/composition'
import {
  createDaemonLockProof,
  runTaskExecutionBootRecovery,
} from '@/modules/task-execution/composition/bootRecovery'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { pickInheritableRunConfig } from '@/modules/task-execution/public/commands'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import { gracefulShutdown } from '@/services/shutdown'
import { describeEachProvider } from './helpers/eachProvider'
import { seedBundleTask, taskBundleInput } from './helpers/daemonTaskExecutionBundle'

const homes: string[] = []
function home() {
  const path = mkdtempSync(join(tmpdir(), 'rfc385-generation-'))
  homes.push(path)
  return path
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})
const log = { info: () => {}, warn: () => {} }

describeEachProvider('RFC-385 process execution generation', (harness) => {
  async function previousProcess(daemonGeneration: string, shutdownSurvivor: boolean) {
    const appHome = home()
    const bundle = taskBundleInput(harness, appHome).compose()
    const persistence = bundle.persistence
    const seeded = await seedBundleTask(harness, appHome)
    const runId = ulid()
    const { taskExecutionIntents } = tablesOf(harness.db)
    // A dead process with no remaining native child: the real reaper takes its no-pid path.
    await nodeRunFixture(harness.db, {
      id: runId,
      taskId: seeded.taskId,
      nodeId: 'worker',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1_000,
    })
    const previous = createProviderTaskExecutionModule({ daemonGeneration, persistence })
    const claimed = await previous.claimPersisted({ intentId: seeded.intentId })
    previous.claimGate.leave(claimed.permit)
    if (shutdownSurvivor) {
      await gracefulShutdown(
        {
          controller: createTaskExecutionShutdownController(previous),
          operations: persistence.shutdown,
          recovery: persistence.recoveryAdministration,
        },
        0,
      )
    }
    const owner = (await persistence.ownership.read(seeded.taskId))!
    expect(owner.state).toBe(shutdownSurvivor ? 'recovery-required' : 'claimed')
    expect((await seeded.row()).status).toBe(shutdownSurvivor ? 'interrupted' : 'running')
    return {
      ...seeded,
      bundle,
      persistence,
      owner,
      run: async () => {
        return (await readNodeRunFixtures(harness.db, { id: runId }))[0]!
      },
      intent: async () => {
        return (
          await harness.db
            .select()
            .from(taskExecutionIntents)
            .where(eq(taskExecutionIntents.id, seeded.intentId))
        )[0]!
      },
      recover: (generation: string) =>
        runTaskExecutionBootRecovery({
          persistence,
          runtimeSessionLeases: createRuntimeSessionLeaseOperations(harness.db),
          lockProof: createDaemonLockProof({
            lockPath: join(appHome, 'daemon.lock'),
            lockPid: process.pid,
            daemonGeneration: generation,
          }),
          log,
        }),
      async submitResume() {
        const task = await seeded.row()
        const intentId = ulid()
        await persistence.intents.submit({
          intentId,
          request: {
            taskId: seeded.taskId,
            kind: 'resume',
            source: 'rest',
            actorUserId: 'actor-1',
            expectedTaskRevision: task.lifecycleEventRevision,
            scope: {
              executionLineageId: seeded.taskId,
              continuationSlotKey: `${seeded.taskId}:resume`,
              slotPath: [
                {
                  stableNodeKey: 'task-root',
                  frozenOccurrenceKey: seeded.taskId,
                  workflowRevision: 1,
                },
              ],
              operationGeneration: 0,
            },
            payload: { v: 1 },
          },
        })
        return intentId
      },
    }
  }

  test('former wiring / crash: same generation leaves owner claimed, boot throws before finalize', async () => {
    const generation = 'dbg_former_standalone'
    const fixture = await previousProcess(generation, false)
    const prepare = spyOn(fixture.persistence.recovery, 'prepare')
    const finalize = spyOn(fixture.persistence.recovery, 'finalize')
    try {
      await expect(fixture.recover(generation)).rejects.toMatchObject({
        name: 'TaskExecutionError',
        code: 'task-execution-stale-owner',
        message: `ownerless task mutation refused durable owner for '${fixture.taskId}'`,
      })
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(await prepare.mock.results[0]!.value).toEqual({ revokedTaskIds: [] })
      expect(finalize).not.toHaveBeenCalled()
      expect(await fixture.persistence.ownership.read(fixture.taskId)).toEqual(fixture.owner)
      expect((await fixture.row()).status).toBe('running')
      expect((await fixture.run()).status).toBe('running')
      expect((await fixture.intent()).state).toBe('claimed')
    } finally {
      prepare.mockRestore()
      finalize.mockRestore()
    }
  })

  test('former wiring / shutdown survivor: boot succeeds but finalize skips recovery-required owner', async () => {
    const generation = 'dbg_former_standalone'
    const fixture = await previousProcess(generation, true)
    const report = await fixture.recover(generation)
    expect(report.revokedTaskIds).toEqual([])
    expect(report.reap).toEqual({ tasks: 0, runs: 1 })
    expect(report.finalization.releasedTaskIds).toEqual([])
    expect(report.finalization.outcomeUnknownTaskIds).toEqual([])
    expect(await fixture.persistence.ownership.read(fixture.taskId)).toEqual(fixture.owner)
    expect(await fixture.row()).toMatchObject({
      status: 'interrupted',
      errorSummary: 'daemon-restart',
    })
    expect((await fixture.run()).status).toBe('interrupted')
    expect(await fixture.intent()).toMatchObject({
      state: 'failed',
      failureCode: 'daemon-shutdown-survivor',
    })
    const intentId = await fixture.submitResume()
    await expect(
      fixture.bundle.executionModule.claim({ db: harness.db, intentId }),
    ).rejects.toMatchObject({ code: 'task-execution-recovery-required' })
  })

  for (const shutdownSurvivor of [false, true]) {
    test(`process wiring / ${shutdownSurvivor ? 'shutdown survivor' : 'crash'}: boot releases old owner and resume claims next epoch`, async () => {
      const fixture = await previousProcess(`previous-process-${ulid()}`, shutdownSurvivor)
      const successor = fixture.bundle.executionModule
      expect(successor.daemonGeneration).toBe(DAEMON_GENERATION)
      expect(successor.daemonGeneration).not.toBe(fixture.owner.daemonGeneration)
      const report = await fixture.recover(DAEMON_GENERATION)
      // Shutdown already made the owner non-claimed; only a crash needs prepare's revocation.
      expect(report.revokedTaskIds).toEqual(shutdownSurvivor ? [] : [fixture.taskId])
      expect(report.reap).toEqual({ tasks: shutdownSurvivor ? 0 : 1, runs: 1 })
      expect(report.finalization.releasedTaskIds).toEqual([fixture.taskId])
      expect(report.finalization.outcomeUnknownTaskIds).toEqual([])
      const { taskExecutionOwners } = tablesOf(harness.db)
      const owner = (
        await harness.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, fixture.taskId))
      )[0]!
      expect(owner).toMatchObject({
        state: 'released',
        epoch: fixture.owner.epoch,
        recoveryCode: 'daemon-restart-recovered',
      })
      expect(await fixture.row()).toMatchObject({
        status: 'interrupted',
        errorSummary: 'daemon-restart',
      })
      expect((await fixture.run()).status).toBe('interrupted')
      expect(await fixture.intent()).toMatchObject({
        state: 'failed',
        failureCode: shutdownSurvivor ? 'daemon-shutdown-survivor' : 'daemon-restart',
      })
      const intentId = await fixture.submitResume()
      const resumed = await successor.claim({ db: harness.db, intentId })
      successor.claimGate.leave(resumed.permit)
      expect(resumed.token.epoch).toBe(fixture.owner.epoch + 1)
      expect(resumed.token.daemonGeneration).toBe(DAEMON_GENERATION)
      expect((await fixture.persistence.ownership.read(fixture.taskId))?.state).toBe('claimed')
    })
  }

  test('real provider bundle stamps owners, live run configuration and child inheritance with the process generation', async () => {
    const appHome = home()
    const fixture = taskBundleInput(harness, appHome)
    const bundle = fixture.compose()
    const config = await bundle.runConfiguration()
    expect(config.daemonGeneration).toBe(DAEMON_GENERATION)
    expect(pickInheritableRunConfig(config).daemonGeneration).toBe(DAEMON_GENERATION)
    const seeded = await seedBundleTask(harness, appHome)
    await bundle.coordinator.submit({
      taskId: seeded.taskId,
      intentId: seeded.intentId,
      completionMode: 'await-settle',
    })
    expect((await bundle.persistence.ownership.read(seeded.taskId))?.daemonGeneration).toBe(
      DAEMON_GENERATION,
    )
    expect(fixture.driven).toHaveLength(1)
    expect(fixture.driven[0]?.daemonGeneration).toBe(DAEMON_GENERATION)
  })
})
