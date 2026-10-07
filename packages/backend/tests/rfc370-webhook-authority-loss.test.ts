// RFC-370 H7: terminal-control authority loss must preserve admitted receipts
// and prevent a later claim or cancellation without using normal abortAll.
import { describe, expect, test } from 'bun:test'
import { createDaemonProviderRuntimeSession } from '../src/cli/daemonProviderRuntimeSession'
import { MrLaunchGuardCoordinator } from '../src/modules/integration/application/mrLaunchGuard'
import { MrTerminalControlWorker } from '../src/modules/integration/application/mrTerminalControlWorker'
import type {
  MrControlEffectClaim,
  MrLaunchGuardPersistencePort,
  MrTerminalEffectPersistencePort,
} from '../src/modules/integration/application/ports/mrTerminalControlPersistence'
import { composeMrTerminalControlWithPorts } from '../src/modules/integration/composition/webhookTerminalControl'
import { mintSourceTerminationEffectCapability } from '../src/modules/task-execution/application/sourceTerminationCapability'
import type { TaskSourceTerminationReceipt } from '../src/modules/task-execution/public/participants'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const effect: MrControlEffectClaim = {
  id: 'exact-terminal-effect',
  binding: 'exact-stream',
  endpointId: 'endpoint',
  streamKey: 'stream',
  revision: 7,
  kind: 'fence-closed',
  deliveryId: 'exact-delivery',
  attemptCount: 1,
}
const receipt: TaskSourceTerminationReceipt = {
  taskId: 'exact-task',
  priorStatus: 'running',
  fenceOutcome: 'fenced-closed',
  cancelOutcome: 'canceled',
  releaseOutcome: 'released',
  errorCode: null,
}

function fixture(
  options: {
    canDispatch?: () => boolean
    claim?: () => Promise<MrControlEffectClaim | null>
    apply?: () => Promise<readonly TaskSourceTerminationReceipt[]>
    barrier?: () => Promise<boolean>
    guardIds?: () => Promise<readonly string[]>
    boot?: () => Promise<void>
  } = {},
) {
  const events: string[] = []
  const claimEntered = deferred<void>()
  const applyEntered = deferred<void>()
  const barrierEntered = deferred<void>()
  const guardReadEntered = deferred<void>()
  const bootEntered = deferred<void>()
  const finished = deferred<void>()
  const receipts: Array<Parameters<MrTerminalEffectPersistencePort['recordReceipts']>> = []
  const attempts: Array<Parameters<MrTerminalEffectPersistencePort['finishAttempt']>[0]> = []
  let claimed = false
  const persistence: MrTerminalEffectPersistencePort = {
    async claimNextDue() {
      events.push('claim')
      claimEntered.resolve()
      if (options.claim !== undefined) return await options.claim()
      if (claimed) return null
      claimed = true
      return effect
    },
    async recordReceipts(...args) {
      events.push('receipt')
      receipts.push(args)
    },
    async finishAttempt(input) {
      events.push(`finish:${input.status}`)
      attempts.push(input)
      finished.resolve()
    },
    async listReleaseOutcomes() {
      events.push('release-outcomes')
      return []
    },
  }
  const guardPersistence: MrLaunchGuardPersistencePort = {
    reserve: async () => {},
    markLaunching: async () => {},
    assertCanCommit: async () => true,
    markTaskCommitted: async () => {},
    markLaunchSettled: async () => {},
    markFailed: async () => {},
    async listRevokingGuardIds() {
      events.push('guard-read')
      guardReadEntered.resolve()
      return (await options.guardIds?.()) ?? []
    },
    async reconcileStaleOnBoot() {
      events.push('boot')
      bootEntered.resolve()
      await options.boot?.()
    },
    async hasLaunchBarrier() {
      events.push('barrier')
      barrierEntered.resolve()
      return (await options.barrier?.()) ?? false
    },
  }
  const guards = new MrLaunchGuardCoordinator(
    guardPersistence,
    {
      register: () => true,
      abort() {
        events.push('abort-one')
        return true
      },
      release: () => true,
      abortAll() {
        events.push('abort-all')
      },
    },
    options.canDispatch,
  )
  const participant = {
    async apply() {
      events.push('apply')
      applyEntered.resolve()
      return (await options.apply?.()) ?? [receipt]
    },
  }
  const worker = new MrTerminalControlWorker(
    persistence,
    guards,
    participant,
    mintSourceTerminationEffectCapability,
    options.canDispatch,
  )
  return {
    events,
    worker,
    guards,
    persistence,
    guardPersistence,
    participant,
    receipts,
    attempts,
    claimEntered,
    applyEntered,
    barrierEntered,
    guardReadEntered,
    bootEntered,
    finished,
  }
}

describe('RFC-370 webhook terminal authority-loss lifetime', () => {
  test('standby starts no timer, boot writer, claim or control operation', async () => {
    const f = fixture({ canDispatch: () => false })
    f.worker.resume()
    f.worker.wake()
    await f.worker.reconcileOnBoot()
    f.worker.quiesceAuthorityLoss()
    await f.worker.drainAuthorityLoss()
    expect(f.events).toEqual([])
  })

  test('loss while a claim ACK is held waits for it and never applies its late result', async () => {
    const claim = deferred<MrControlEffectClaim | null>()
    const f = fixture({ claim: () => claim.promise })
    f.worker.wake()
    await f.claimEntered.promise
    f.worker.quiesceAuthorityLoss()
    let drained = false
    const draining = f.worker.drainAuthorityLoss().then(() => {
      drained = true
    })
    f.worker.wake()
    await Promise.resolve()
    expect(drained).toBe(false)
    claim.resolve(effect)
    await draining
    expect(f.events.filter((event) => event === 'claim')).toHaveLength(1)
    expect(f.events).not.toContain('apply')
    expect(f.events).not.toContain('abort-all')
    expect(f.attempts).toEqual([])
    expect(f.receipts).toEqual([])
  })

  test('an admitted apply retains its actual receipt after loss without a second sweep', async () => {
    const applied = deferred<readonly TaskSourceTerminationReceipt[]>()
    const f = fixture({ apply: () => applied.promise })
    f.worker.wake()
    await f.applyEntered.promise
    f.worker.quiesceAuthorityLoss()
    let drained = false
    const draining = f.worker.drainAuthorityLoss().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    applied.resolve([receipt])
    await draining
    expect(f.events.filter((event) => event === 'apply')).toHaveLength(1)
    expect(f.receipts).toHaveLength(1)
    expect(f.receipts[0]![0]).toBe(effect.id)
    expect(f.receipts[0]![1]).toEqual([receipt])
    expect(f.events).not.toContain('barrier')
    expect(f.events).not.toContain('abort-all')
    expect(f.attempts).toEqual([])
  })

  test('loss during an awaited launch barrier cannot issue the final cancellation sweep', async () => {
    const barrier = deferred<boolean>()
    const f = fixture({ barrier: () => barrier.promise })
    f.worker.wake()
    await f.barrierEntered.promise
    f.worker.quiesceAuthorityLoss()
    const draining = f.worker.drainAuthorityLoss()
    barrier.resolve(false)
    await draining
    expect(f.events.filter((event) => event === 'apply')).toHaveLength(1)
    expect(f.receipts).toHaveLength(1)
    expect(f.attempts).toEqual([])
    expect(f.events).not.toContain('release-outcomes')
    expect(f.events).not.toContain('abort-all')
  })

  test('the actual guard coordinator checks the old invocation after an awaited guard list', async () => {
    const ids = deferred<readonly string[]>()
    const f = fixture({ guardIds: () => ids.promise })
    f.worker.wake()
    await f.guardReadEntered.promise
    f.worker.quiesceAuthorityLoss()
    const draining = f.worker.drainAuthorityLoss()
    ids.resolve(['late-guard'])
    await draining
    expect(f.events).toEqual(['guard-read'])
  })

  test('loss drain includes the actual earlier boot writer ACK', async () => {
    const boot = deferred<void>()
    const f = fixture({ boot: () => boot.promise })
    const preparing = f.worker.reconcileOnBoot()
    await f.bootEntered.promise
    f.worker.quiesceAuthorityLoss()
    let drained = false
    const draining = f.worker.drainAuthorityLoss().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    boot.resolve()
    await preparing
    await draining
    expect(f.events).toEqual(['boot'])
  })

  test('normal stop retains bulk launch abort and waits for the admitted control attempt', async () => {
    const applied = deferred<readonly TaskSourceTerminationReceipt[]>()
    let applies = 0
    const f = fixture({
      apply: async () => (++applies === 1 ? await applied.promise : [receipt]),
    })
    f.worker.wake()
    await f.applyEntered.promise
    let stopped = false
    const stopping = f.worker.stop().then(() => {
      stopped = true
    })
    expect(f.events).toContain('abort-all')
    await Promise.resolve()
    expect(stopped).toBe(false)
    applied.resolve([receipt])
    await stopping
    expect(applies).toBe(2)
    expect(f.receipts).toHaveLength(2)
    expect(f.attempts.map((attempt) => attempt.status)).toEqual(['succeeded'])
  })

  test('the real worker receives loss quiesce after a successful held normal stop ACK', async () => {
    for (const provider of ['sqlite', 'postgresql'] as const) {
      let current = true
      const applied = deferred<readonly TaskSourceTerminationReceipt[]>()
      const normalStopEntered = deferred<void>()
      const f = fixture({ canDispatch: () => current, apply: () => applied.promise })
      const generation = `${provider}-webhook-stop-race`
      const context = Object.freeze({ generation, reference: {}, current: () => current })
      const scope = { operationId: 'webhook-resources', provider, generationId: generation }
      const session = await createDaemonProviderRuntimeSession({
        provider,
        generationId: generation,
        runtime: {
          fetch: () => new Response('resources-ready'),
          tryUpgrade: () => false as const,
          websocketHandlers: Object.freeze({}),
        },
        admission: {
          closeWriterAdmission: () => {},
          openWriterAdmission: () => {},
          closeWebSocketAdmission: () => {},
          openWebSocketAdmission: () => {},
        },
        backgroundWriterFactories: [
          {
            id: 'webhook-terminal-control',
            start() {
              throw new Error('selected webhook must not use the native factory')
            },
          },
        ],
        hostExecutionRuntime: {
          handles: [
            {
              id: 'webhook-terminal-control',
              group: 'event-dispatch',
              start() {
                f.worker.resume()
                return {
                  async stop() {
                    f.events.push('normal-stop')
                    const stopping = f.worker.stop()
                    normalStopEntered.resolve()
                    await stopping
                  },
                  drain: () => {},
                }
              },
              quiesceAuthorityLoss() {
                f.events.push('loss-quiesce')
                f.worker.quiesceAuthorityLoss()
              },
              async drainAuthorityLoss() {
                f.events.push('loss-drain')
                await f.worker.drainAuthorityLoss()
              },
            },
          ],
        },
        shutdownIdentity: () => {},
        closeProvider: () => {},
      })
      await session.resume(scope)
      await session.hostExecutionRuntime!.start({ context, groups: ['event-dispatch'] })
      f.worker.wake()
      await f.applyEntered.promise
      const pausing = session.execution.pause(scope)
      await normalStopEntered.promise
      expect(f.events.filter((event) => event === 'abort-all')).toHaveLength(1)
      current = false
      const quiesced = session.hostExecutionRuntime!.quiesce({
        context,
        reason: 'authority-loss',
      })
      applied.resolve([receipt])
      await pausing
      await quiesced
      await session.hostExecutionRuntime!.drain(context)
      expect(f.events.filter((event) => event === 'normal-stop')).toHaveLength(1)
      expect(f.events.filter((event) => event === 'abort-all')).toHaveLength(1)
      expect(f.events.filter((event) => event === 'apply')).toHaveLength(1)
      expect(f.events.filter((event) => event === 'loss-quiesce')).toHaveLength(1)
      expect(f.events.filter((event) => event === 'loss-drain')).toHaveLength(1)
      expect(f.events.indexOf('loss-quiesce')).toBeLessThan(f.events.indexOf('loss-drain'))
      expect(f.receipts).toHaveLength(1)
      expect(f.receipts[0]![0]).toBe(effect.id)
      expect(f.receipts[0]![1]).toEqual([receipt])
      expect(f.attempts).toEqual([])
      expect(session.state()).toEqual({ phase: 'running', activeHandleIds: [] })
      expect(await (await session.runtime.fetch(new Request('http://aw/resources'))).text()).toBe(
        'resources-ready',
      )
      await session.close({ reason: 'daemon-shutdown' })
    }
  }, 30_000)

  test('new execution must await old loss drain and never adopts its late claim', async () => {
    const late = deferred<MrControlEffectClaim | null>()
    let claims = 0
    const nextEffect = { ...effect, id: 'new-generation-effect' }
    const f = fixture({
      claim: async () => {
        claims += 1
        if (claims === 1) return await late.promise
        if (claims === 2) return nextEffect
        return null
      },
    })
    f.worker.wake()
    await f.claimEntered.promise
    f.worker.quiesceAuthorityLoss()
    expect(() => f.worker.resume()).toThrow('authority-loss-not-drained')
    const draining = f.worker.drainAuthorityLoss()
    late.resolve(effect)
    await draining
    f.worker.resume()
    f.worker.wake()
    await f.finished.promise
    await f.worker.stop()
    expect(f.receipts.map(([id]) => id)).toEqual([nextEffect.id, nextEffect.id])
    expect(f.attempts.map((attempt) => attempt.effectId)).toEqual([nextEffect.id])
  })

  test('a retired retry timer cannot wake the resumed generation', async () => {
    const f = fixture({ barrier: async () => true })
    f.worker.wake()
    await f.finished.promise
    // Let the admitted attempt finish registering its timer before retiring it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const claimsBeforeLoss = f.events.filter((event) => event === 'claim').length
    f.worker.quiesceAuthorityLoss()
    await f.worker.drainAuthorityLoss()
    f.worker.resume()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(f.events.filter((event) => event === 'claim')).toHaveLength(claimsBeforeLoss)
    expect(f.events).not.toContain('abort-all')
    await f.worker.stop()
  })

  test('loss drain cannot report success before its quiesce face', async () => {
    const f = fixture()
    await expect(f.worker.drainAuthorityLoss()).rejects.toThrow('drain-before-quiesce')
    f.worker.quiesceAuthorityLoss()
    await f.worker.drainAuthorityLoss()
    expect(f.events).toEqual([])
  })

  test('the actual neutral composition supplies both faces and the selected current predicate', async () => {
    const f = fixture()
    const runtime = composeMrTerminalControlWithPorts({
      persistence: {
        launchGuards: f.guardPersistence,
        terminalEffects: f.persistence,
      },
      taskTermination: {
        participant: f.participant,
        mintCapability: mintSourceTerminationEffectCapability,
      },
      canDispatch: () => false,
    })
    runtime.resume()
    runtime.wake()
    await runtime.reconcileOnBoot()
    runtime.quiesceAuthorityLoss()
    await runtime.drainAuthorityLoss()
    expect(f.events).toEqual([])
  })
})
