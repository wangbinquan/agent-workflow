// RFC-370: the real idle tree cancellation, reason and audit finish under the
// original owner after loss; the next tree is not admitted. No native signals
// are mocked into proof here: the fixture has no live node runs.
import { expect, spyOn, test } from 'bun:test'
import { ConfigSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { tasks, workflows, recoveryEvents } from '@/db/schema'
import { createTaskIdleTimeoutPersistence } from '@/modules/task-execution/composition/taskIdleTimeout'
import { bindTaskIdleTimeoutHostOwner } from '../src/cli/daemonHostExecutionOwners'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { cancelViaEngine } from './helpers/cancelEngine'
import { installTaskLifecycleAfterCommitTestPump } from './helpers/taskLifecycleCommittedEvents'
import { deferred } from './helpers/taskHostExecution'

async function seed(harness: ProviderHarness) {
  const now = Date.now()
  await harness.db.insert(workflows).values({
    id: 'idle-owner-workflow',
    name: 'idle owner',
    definition: '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[]}',
    createdAt: now,
    updatedAt: now,
  })
  for (const [index, id] of ['idle-first', 'idle-second'].entries())
    await harness.db.insert(tasks).values({
      id,
      name: id,
      workflowId: 'idle-owner-workflow',
      workflowSnapshot: '{}',
      repoPath: '/fixture/not-used',
      worktreePath: '/fixture/not-used',
      baseBranch: 'main',
      branch: 'aw/' + id,
      status: 'running',
      inputs: '{}',
      startedAt: now - (4 - index) * 3_600_000,
      runningSince: now - (4 - index) * 3_600_000,
      runningMs: 0,
      rootTaskId: id,
      ownerUserId: '__system__',
      executionLineageId: id,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
      ]),
    })
}
function grant(harness: ProviderHarness) {
  let active = true
  const context = {
    generation: 'idle-owner-generation',
    reference: Object.freeze({}),
    current() {
      expect(this).toBe(context)
      return active
    },
  }
  return {
    context,
    scope: {
      provider: harness.applicationBinding.provider,
      generationId: context.generation,
      operationId: 'idle-owner',
    },
    lose() {
      active = false
    },
  }
}
const config = () => ({
  ...ConfigSchema.parse({}),
  taskIdleTimeout: { enabled: true, idleHours: 1 },
})
const _spyTimeout = () => spyOn(globalThis, 'setTimeout')
function fireOriginalTick(timer: ReturnType<typeof _spyTimeout>) {
  const index = timer.mock.calls.findIndex((call) => call[1] === DAEMON_CADENCE.taskIdleTimeout)
  const args = timer.mock.calls[index],
    result = timer.mock.results[index]
  if (!args || result?.type !== 'return' || typeof args[0] !== 'function')
    throw new Error('original idle polling timer missing')
  clearTimeout(result.value)
  args[0](...args.slice(2))
}

describeEachProvider('RFC-370 actual idle owner and original task cancellation', (harness) => {
  for (const held of ['configuration', 'snapshot'] as const)
    test(`loss during ${held} does not cancel or audit an unadmitted tree`, async () => {
      await seed(harness)
      const persistence = createTaskIdleTimeoutPersistence(harness.db),
        entered = deferred(),
        release = deferred()
      let cancels = 0
      const owner = bindTaskIdleTimeoutHostOwner({
        configuration: {
          async read() {
            if (held === 'configuration') {
              entered.resolve()
              await release.promise
            }
            return config()
          },
        },
        operations: {
          persistence: {
            ...persistence,
            async loadTreeActivity(id) {
              const snapshot = await persistence.loadTreeActivity(id)
              if (held === 'snapshot') {
                entered.resolve()
                await release.promise
              }
              return snapshot
            },
          },
          async cancelTask() {
            cancels += 1
          },
          killRunProcessTree: async () => {
            throw new Error('fixture has no runs')
          },
        },
        onError(error) {
          throw error
        },
      })
      const g = grant(harness),
        timer = spyOn(globalThis, 'setTimeout'),
        handle = await owner.start(g)
      try {
        fireOriginalTick(timer)
        await entered.promise
        g.lose()
        await owner.quiesceAuthorityLoss({ context: g.context, handle })
        let drained = false
        const draining = Promise.resolve(
          owner.drainAuthorityLoss({ context: g.context, handle }),
        ).then(() => {
          drained = true
        })
        expect(drained).toBe(false)
        release.resolve()
        await draining
        expect(cancels).toBe(0)
        expect((await harness.db.select().from(tasks)).map((row) => row.status)).toEqual([
          'running',
          'running',
        ])
        expect(await harness.db.select().from(recoveryEvents)).toEqual([])
      } finally {
        release.resolve()
        await handle.stop()
        await handle.drain()
        timer.mockRestore()
      }
    })

  test('the admitted cancellation finishes its real reason and audit, while a second tree remains running', async () => {
    await seed(harness)
    const entered = deferred(),
      release = deferred(),
      canceled: string[] = []
    const pump = installTaskLifecycleAfterCommitTestPump(harness.db, {})
    const owner = bindTaskIdleTimeoutHostOwner({
      configuration: { read: config },
      operations: {
        persistence: createTaskIdleTimeoutPersistence(harness.db),
        async cancelTask(id) {
          canceled.push(id)
          entered.resolve()
          await release.promise
          await cancelViaEngine(harness.db, id)
        },
        killRunProcessTree: async () => {
          throw new Error('fixture has no runs')
        },
      },
      onError(error) {
        throw error
      },
    })
    const g = grant(harness),
      timer = spyOn(globalThis, 'setTimeout'),
      handle = await owner.start(g)
    try {
      fireOriginalTick(timer)
      await entered.promise
      g.lose()
      await owner.quiesceAuthorityLoss({ context: g.context, handle })
      let drained = false
      const draining = Promise.resolve(
        owner.drainAuthorityLoss({ context: g.context, handle }),
      ).then(() => {
        drained = true
      })
      expect(drained).toBe(false)
      release.resolve()
      await draining
      expect(canceled).toEqual(['idle-first'])
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, 'idle-first')))[0],
      ).toMatchObject({ status: 'canceled', errorSummary: 'task-idle-timeout' })
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, 'idle-second')))[0]?.status,
      ).toBe('running')
      expect(
        (await harness.db.select().from(recoveryEvents)).filter(
          (row) => row.kind === 'idle-timeout-reap',
        ),
      ).toHaveLength(1)
    } finally {
      release.resolve()
      await handle.stop()
      await handle.drain()
      timer.mockRestore()
      pump()
    }
  })
})
