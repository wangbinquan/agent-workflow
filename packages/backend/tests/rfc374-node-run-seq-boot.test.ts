// RFC-374 T6: catch-up is boot step zero and hosted recovery starts only after activation; failure stops execution initialization.
import { describe, expect, test } from 'bun:test'
import { nodeRuns } from '@/db/schema'
import { runTaskExecutionBootRecovery } from '@/modules/task-execution/composition/bootRecovery'
import { createNodeRunSeqBackfillStore } from '@/modules/task-execution/infrastructure/nodeRunSeqBackfillStore'
import type {
  TaskExecutionBootRecoveryInput,
  BootExecutionRecoveryFactory,
} from '@/modules/task-execution/application/ports/bootExecutionRecovery'
import type { NodeRunSeqBackfillStore } from '@/modules/task-execution/application/ports/nodeRunSeqBackfillStore'
import { selectExecutionInitialization } from '@/bootstrap/executionInitialization'
import type {
  ExecutionAuthorityPort,
  ExecutionAuthorityState,
  ExecutionFence,
} from '@/modules/system-operations/application/ports/executionAuthority'
import { describeEachProvider } from './helpers/eachProvider'
import { seedSequenceTask } from './helpers/rfc374Fixtures'

function bootInput(
  store: NodeRunSeqBackfillStore,
  factory: BootExecutionRecoveryFactory,
): TaskExecutionBootRecoveryInput {
  return {
    persistence: {
      nodeRunSeqBackfill: store,
      get recovery(): never {
        throw new Error('unexpected local recovery')
      },
      get recoveryAdministration(): never {
        throw new Error('unexpected local administration')
      },
    },
    get runtimeSessionLeases(): never {
      throw new Error('unexpected leases')
    },
    get lockProof(): never {
      throw new Error('unexpected proof')
    },
    log: { info() {}, warn() {} },
    recoveryEffects: factory,
  }
}
function sequence(order: string[]): BootExecutionRecoveryFactory {
  return {
    create() {
      order.push('create')
      return {
        prepare() {
          order.push('prepare')
          return { revokedTaskIds: [] }
        },
        reap() {
          order.push('reap')
          return { counts: { tasks: 0, runs: 0 }, reapRef: {} }
        },
        repair() {
          order.push('repair')
          return { leases: 0, finalizationRef: {} }
        },
        finalize() {
          order.push('finalize')
          return {
            releasedTaskIds: [],
            outcomeUnknownTaskIds: [],
            recoveredProcessEffectIds: [],
            recoveredCodeHostEffectIds: [],
            retryAuthorizedCodeHostEffectIds: [],
          }
        },
      }
    },
  }
}
describeEachProvider('RFC-374 boot step zero', (harness) => {
  test('real backfill completes before preparing or reaping, and reports its work', async () => {
    const taskId = await seedSequenceTask(harness.db)
    await harness.db
      .insert(nodeRuns)
      .values({ id: 'legacy', taskId, nodeId: 'n', status: 'running' })
    const order: string[] = [],
      store = createNodeRunSeqBackfillStore(harness.db)
    const report = await runTaskExecutionBootRecovery(
      bootInput(
        {
          ...store,
          async assertAllocatorCurrent() {
            await store.assertAllocatorCurrent()
            expect((await harness.db.select().from(nodeRuns))[0]!.seq).not.toBeNull()
            order.push('backfill')
          },
        },
        sequence(order),
      ),
    )
    expect(order).toEqual(['backfill', 'create', 'prepare', 'reap', 'repair', 'finalize'])
    expect(report.nodeRunSeqBackfill).toMatchObject({ tasks: 1, runs: 1 })
  })
  test('a real allocator failure rejects daemon boot before recovery or listeners', async () => {
    const taskId = await seedSequenceTask(harness.db)
    await harness.db
      .insert(nodeRuns)
      .values({ id: 'invalid', taskId, nodeId: 'n', status: 'running', seq: 1 })
    const order: string[] = []
    const start = async () => {
      await runTaskExecutionBootRecovery(
        bootInput(createNodeRunSeqBackfillStore(harness.db), sequence(order)),
      )
      order.push('listen')
    }
    await expect(start()).rejects.toThrow('node-run-seq-allocator-behind')
    expect(order).toEqual([])
  })
})
describe('RFC-374 hosted activation', () => {
  for (const fail of [false, true])
    test(`backfill waits for activation and ${fail ? 'freezes on failure' : 'finishes before business admission'}`, async () => {
      const grant = Promise.withResolvers<ExecutionFence>(),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      let state: ExecutionAuthorityState = { kind: 'standby', reason: null }
      const raw: ExecutionAuthorityPort & { start(): void } = {
        mode: 'crewstation',
        current: () => state,
        whenActive: () => grant.promise,
        onLost: () => () => {},
        async close() {},
        start() {},
      }
      const selected = selectExecutionInitialization(raw),
        lost = Promise.withResolvers<void>(),
        order: string[] = []
      selected.authority.onLost(() => lost.resolve())
      const store: NodeRunSeqBackfillStore = {
        async listTaskIds() {
          entered.resolve()
          await release.promise
          if (fail) throw new Error('backfill-injected')
          return []
        },
        async backfillTask() {
          return 0
        },
        async assertAllocatorCurrent() {},
        async pruneAllocations() {
          return 0
        },
      }
      await selected.initialize(async () => {
        await runTaskExecutionBootRecovery(bootInput(store, sequence(order)))
      })
      expect(order).toEqual([])
      expect(selected.authority.current().kind).toBe('standby')
      const fence = { epoch: 1, token: 'rfc374' }
      state = { kind: 'active', fence }
      grant.resolve(fence)
      await entered.promise
      expect(selected.authority.current()).toEqual({
        kind: 'standby',
        reason: 'execution-recovery-in-progress',
      })
      expect(order).toEqual([])
      release.resolve()
      if (fail) {
        await lost.promise
        expect(selected.authority.current()).toEqual({
          kind: 'frozen',
          reason: 'execution-initialization-failed: backfill-injected',
        })
        expect(order).toEqual([])
      } else {
        await selected.authority.whenActive()
        expect(order).toEqual(['create', 'prepare', 'reap', 'repair', 'finalize'])
      }
      await selected.authority.close()
    })
})
