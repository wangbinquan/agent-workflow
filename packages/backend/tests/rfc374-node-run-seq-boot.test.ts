// RFC-395 D4: normal boot has four recovery steps; hosted admission waits for recovery.
import { describe, expect, test } from 'bun:test'
import { runTaskExecutionBootRecovery } from '@/modules/task-execution/composition/bootRecovery'
import type {
  TaskExecutionBootRecoveryInput,
  BootExecutionRecoveryFactory,
} from '@/modules/task-execution/application/ports/bootExecutionRecovery'
import { selectExecutionInitialization } from '@/bootstrap/executionInitialization'
import type {
  ExecutionAuthorityPort,
  ExecutionAuthorityState,
  ExecutionFence,
} from '@/modules/system-operations/application/ports/executionAuthority'

function bootInput(factory: BootExecutionRecoveryFactory): TaskExecutionBootRecoveryInput {
  return {
    persistence: {
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
describe('RFC-395 normal boot without sequence compatibility', () => {
  test('runs exactly four recovery steps and has no backfill report', async () => {
    const order: string[] = []
    const report = await runTaskExecutionBootRecovery(bootInput(sequence(order)))
    expect(order).toEqual(['create', 'prepare', 'reap', 'repair', 'finalize'])
    expect(Object.keys(report).sort()).toEqual([
      'finalization',
      'reap',
      'repairedRuntimeLeases',
      'revokedTaskIds',
    ])
  })
  test('prepare failure stops before reaping and listeners', async () => {
    const order: string[] = []
    const factory = sequence(order)
    const start = async () => {
      await runTaskExecutionBootRecovery(
        bootInput({
          create(input) {
            return {
              ...factory.create(input),
              prepare() {
                throw new Error('prepare-injected')
              },
            }
          },
        }),
      )
      order.push('listen')
    }
    await expect(start()).rejects.toThrow('prepare-injected')
    expect(order).toEqual(['create'])
  })
})
describe('RFC-374 hosted activation', () => {
  for (const fail of [false, true])
    test(`recovery waits for activation and ${fail ? 'freezes on failure' : 'finishes before business admission'}`, async () => {
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
      const factory = sequence(order)
      const delayed: BootExecutionRecoveryFactory = {
        create(input) {
          const effects = factory.create(input)
          return {
            ...effects,
            async prepare() {
              entered.resolve()
              await release.promise
              if (fail) throw new Error('prepare-injected')
              return effects.prepare()
            },
          }
        },
      }
      await selected.initialize(async () => {
        await runTaskExecutionBootRecovery(bootInput(delayed))
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
      expect(order).toEqual(['create'])
      release.resolve()
      if (fail) {
        await lost.promise
        expect(selected.authority.current()).toEqual({
          kind: 'frozen',
          reason: 'execution-initialization-failed: prepare-injected',
        })
        expect(order).toEqual(['create'])
      } else {
        await selected.authority.whenActive()
        expect(order).toEqual(['create', 'prepare', 'reap', 'repair', 'finalize'])
      }
      await selected.authority.close()
    })
})
