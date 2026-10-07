// RFC-370 H7: the actual provider session must keep resource delegates usable
// while its selected execution handles wait for activation or retire on loss.
import { describe, expect, test } from 'bun:test'
import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderHostExecutionHandleBinding,
  type DaemonProviderRuntimeHandle,
  type DaemonProviderRuntimeHandleFactory,
} from '../src/cli/daemonProviderRuntimeSession'
import { composeHostExecutionAuthorityBinding } from '../src/modules/system-operations/composition/hostExecutionAuthority'
import type {
  HostExecutionAuthorityObservation,
  HostExecutionGrantContext,
  HostExecutionGroup,
} from '../src/modules/system-operations/public/participants'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const groups: readonly HostExecutionGroup[] = [
  'intent',
  'task',
  'maintenance',
  'diagnostics',
  'observation',
  'event-dispatch',
  'maintenance',
  'development',
  'event-dispatch',
  'memory',
  'development',
  'digital-employee',
  'event-dispatch',
  'knowledge',
  'maintenance',
  'task',
  'maintenance',
  'maintenance',
  'maintenance',
]

for (const provider of ['sqlite', 'postgresql'] as const) {
  describe(`RFC-370 ${provider} provider host-authority runtime`, () => {
    const generation = `${provider}-authority-runtime`
    const scope = { operationId: 'resource-resume', provider, generationId: generation }

    async function fixture(
      options: {
        beforeStart?: (id: string) => Promise<void>
        beforeLossQuiesce?: (id: string) => Promise<void>
        beforeLossDrain?: (id: string) => Promise<void>
        beforeNormalStop?: (id: string) => Promise<void>
        beforeNormalDrain?: (id: string) => Promise<void>
        mapBindings?: (
          bindings: readonly DaemonProviderHostExecutionHandleBinding[],
        ) => readonly DaemonProviderHostExecutionHandleBinding[]
      } = {},
    ) {
      const events: string[] = []
      const contexts: HostExecutionGrantContext[] = []
      const owners = new WeakMap<DaemonProviderRuntimeHandle, string>()
      const native: DaemonProviderRuntimeHandleFactory[] = groups.map((_, index) => ({
        id: `handle-${index}`,
        start() {
          events.push(`native:${index}`)
          throw new Error('explicit selection must not start the legacy fallback')
        },
      }))
      const bindings: DaemonProviderHostExecutionHandleBinding[] = native.map((factory, index) => ({
        id: factory.id,
        group: groups[index]!,
        async start({ context, scope: actualScope }) {
          expect(actualScope.provider).toBe(provider)
          expect(actualScope.generationId).toBe(generation)
          contexts.push(context)
          events.push(`start:${factory.id}`)
          await options.beforeStart?.(factory.id)
          const handle: DaemonProviderRuntimeHandle = {
            stop() {
              events.push(`normal-stop:${factory.id}`)
              return options.beforeNormalStop?.(factory.id)
            },
            drain() {
              events.push(`normal-drain:${factory.id}`)
              return options.beforeNormalDrain?.(factory.id)
            },
          }
          owners.set(handle, factory.id)
          return handle
        },
        async quiesceAuthorityLoss({ handle, context }) {
          expect(owners.get(handle)).toBe(factory.id)
          expect(context.generation).toBe(generation)
          events.push(`loss-quiesce:${factory.id}`)
          await options.beforeLossQuiesce?.(factory.id)
        },
        async drainAuthorityLoss({ handle, context }) {
          expect(owners.get(handle)).toBe(factory.id)
          expect(context.generation).toBe(generation)
          events.push(`loss-drain:${factory.id}`)
          await options.beforeLossDrain?.(factory.id)
        },
      }))
      const session = await createDaemonProviderRuntimeSession({
        provider,
        generationId: generation,
        runtime: {
          fetch: () => new Response('resources-ready'),
          tryUpgrade: () => false as const,
          websocketHandlers: Object.freeze({}),
        },
        admission: {
          closeWriterAdmission: () => {
            events.push('resource-writes:close')
          },
          openWriterAdmission: () => {
            events.push('resource-writes:open')
          },
          closeWebSocketAdmission: () => {
            events.push('resource-ws:close')
          },
          openWebSocketAdmission: () => {
            events.push('resource-ws:open')
          },
        },
        runtimeFactories: native.slice(0, 5),
        backgroundWriterFactories: native.slice(5),
        hostExecutionRuntime: { handles: options.mapBindings?.(bindings) ?? bindings },
        providerCloseParticipants: [
          {
            id: 'close-owner',
            close: () => {
              events.push('owner:close')
            },
          },
        ],
        shutdownIdentity: () => {
          events.push('identity:close')
        },
        closeProvider: () => {
          events.push('provider:close')
        },
      })
      return { events, contexts, native, bindings, session }
    }

    function grant() {
      let current = true
      return {
        context: Object.freeze({ generation, reference: {}, current: () => current }),
        lose() {
          current = false
        },
      }
    }

    test('resource resume starts zero of nineteen handles without a prepared grant', async () => {
      const f = await fixture()
      await f.session.resume(scope)
      expect(f.session.state()).toEqual({ phase: 'running', activeHandleIds: [] })
      expect(f.session.execution.state()).toEqual({
        enabled: false,
        running: false,
        activeHandleIds: [],
      })
      expect(await (await f.session.runtime.fetch(new Request('http://aw/resources'))).text()).toBe(
        'resources-ready',
      )
      expect(f.events).toEqual([
        'resource-writes:close',
        'resource-ws:close',
        'resource-ws:open',
        'resource-writes:open',
      ])
      await expect(f.session.execution.resume(scope)).rejects.toThrow('no current prepared grant')
      await f.session.close({ reason: 'daemon-shutdown' })
      expect(f.events.slice(-3)).toEqual(['owner:close', 'identity:close', 'provider:close'])
      expect(
        f.events.some((event) => event.startsWith('start:') || event.startsWith('native:')),
      ).toBe(false)
    })

    test('requires the whole actual handle selection before admission or any start', async () => {
      await expect(fixture({ mapBindings: (bindings) => bindings.slice(0, -1) })).rejects.toThrow(
        'selection-incomplete',
      )
      await expect(
        fixture({ mapBindings: (bindings) => [...bindings.slice(0, -1), bindings[0]!] }),
      ).rejects.toThrow('selection-mismatch')
      await expect(
        fixture({
          mapBindings: (bindings) =>
            bindings.map((binding, index) =>
              index === 0 ? { ...binding, drainAuthorityLoss: undefined as never } : binding,
            ),
        }),
      ).rejects.toThrow('missing-drainAuthorityLoss')
      await expect(
        fixture({
          mapBindings: (bindings) =>
            bindings.map((binding, index) =>
              index === 0 ? { ...binding, group: undefined as never } : binding,
            ),
        }),
      ).rejects.toThrow('handle-group-missing')
    })

    test('starts only ready groups in original handle order and waits for their actual start ACK', async () => {
      const entered = deferred<void>(),
        release = deferred<void>()
      const f = await fixture({
        beforeStart: (id) => {
          if (id !== 'handle-15') return Promise.resolve()
          entered.resolve()
          return release.promise
        },
      })
      await f.session.resume(scope)
      const g = grant(),
        started = f.session.hostExecutionRuntime!.start({
          context: g.context,
          groups: ['task', 'intent'],
        })
      await entered.promise
      expect(f.events.filter((event) => event.startsWith('start:'))).toEqual([
        'start:handle-0',
        'start:handle-1',
        'start:handle-15',
      ])
      expect(f.session.execution.state().running).toBe(false)
      release.resolve()
      await started
      expect(f.session.execution.state().activeHandleIds).toEqual([
        'handle-0',
        'handle-1',
        'handle-15',
      ])
      expect(f.contexts.every((context) => context === g.context)).toBe(true)
      g.lose()
      await f.session.hostExecutionRuntime!.quiesce({
        context: g.context,
        reason: 'authority-loss',
      })
      await f.session.hostExecutionRuntime!.drain(g.context)
      await f.session.close({ reason: 'daemon-shutdown' })
    })

    test('loss uses all nineteen exact owner ACKs, keeps resources ready, and never calls normal stop', async () => {
      const entered = deferred<void>(),
        release = deferred<void>()
      const f = await fixture({
        beforeLossDrain: (id) => {
          if (id !== 'handle-18') return Promise.resolve()
          entered.resolve()
          return release.promise
        },
      })
      await f.session.resume(scope)
      const g = grant()
      await f.session.hostExecutionRuntime!.start({
        context: g.context,
        groups: [...new Set(groups)],
      })
      expect(f.session.state().activeHandleIds).toHaveLength(19)
      g.lose()
      const quiesced = f.session.hostExecutionRuntime!.quiesce({
        context: g.context,
        reason: 'authority-loss',
      })
      expect(f.session.execution.state().enabled).toBe(false)
      await quiesced
      const draining = Promise.resolve(f.session.hostExecutionRuntime!.drain(g.context))
      let drained = false
      void draining.then(() => {
        drained = true
      })
      await entered.promise
      expect(drained).toBe(false)
      expect(f.events.filter((event) => event.startsWith('loss-quiesce:'))).toEqual(
        f.native.map((factory) => `loss-quiesce:${factory.id}`).reverse(),
      )
      expect(
        f.events.some((event) => event.startsWith('normal-') || event.startsWith('native:')),
      ).toBe(false)
      expect(await (await f.session.runtime.fetch(new Request('http://aw/resources'))).text()).toBe(
        'resources-ready',
      )
      release.resolve()
      await draining
      expect(f.events.filter((event) => event.startsWith('loss-drain:'))).toEqual(
        f.native.map((factory) => `loss-drain:${factory.id}`).reverse(),
      )
      expect(f.session.state()).toEqual({ phase: 'running', activeHandleIds: [] })
      await f.session.close({ reason: 'daemon-shutdown' })
    }, 30_000)

    test('an old queued resume cannot reopen loss; a new grant starts fresh handles', async () => {
      const entered = deferred<void>(),
        release = deferred<void>()
      const f = await fixture({
        beforeLossQuiesce: (id) => {
          if (id !== 'handle-15') return Promise.resolve()
          entered.resolve()
          return release.promise
        },
      })
      await f.session.resume(scope)
      const g = grant()
      await f.session.hostExecutionRuntime!.start({ context: g.context, groups: ['task'] })
      g.lose()
      const loss = f.session.hostExecutionRuntime!.quiesce({
        context: g.context,
        reason: 'authority-loss',
      })
      await entered.promise
      const oldResume = f.session.execution.resume(scope)
      const repeatedLoss = f.session.hostExecutionRuntime!.quiesce({
        context: g.context,
        reason: 'authority-loss',
      })
      release.resolve()
      await loss
      await oldResume
      await repeatedLoss
      await f.session.hostExecutionRuntime!.drain(g.context)
      expect(f.events.filter((event) => event.startsWith('start:'))).toEqual([
        'start:handle-1',
        'start:handle-15',
      ])
      await expect(f.session.execution.resume(scope)).rejects.toThrow('no current prepared grant')
      await expect(
        f.session.hostExecutionRuntime!.start({ context: g.context, groups: ['task'] }),
      ).rejects.toThrow('unavailable')
      const successor = grant()
      await f.session.hostExecutionRuntime!.start({ context: successor.context, groups: ['task'] })
      expect(f.events.filter((event) => event.startsWith('start:'))).toHaveLength(4)
      await f.session.hostExecutionRuntime!.drain(g.context)
      expect(f.session.execution.state().activeHandleIds).toEqual(['handle-1', 'handle-15'])
      await f.session.close({ reason: 'daemon-shutdown' })
    }, 30_000)

    test('a late start after loss retires its exact returned handle and starts no later group', async () => {
      const entered = deferred<void>(),
        release = deferred<void>()
      const f = await fixture({
        beforeStart: (id) => {
          if (id !== 'handle-0') return Promise.resolve()
          entered.resolve()
          return release.promise
        },
      })
      await f.session.resume(scope)
      const g = grant(),
        starting = f.session.hostExecutionRuntime!.start({
          context: g.context,
          groups: [...new Set(groups)],
        })
      const failed = expect(starting).rejects.toThrow('grant-lost')
      await entered.promise
      g.lose()
      const quiesced = f.session.hostExecutionRuntime!.quiesce({
        context: g.context,
        reason: 'authority-loss',
      })
      release.resolve()
      await failed
      await quiesced
      await f.session.hostExecutionRuntime!.drain(g.context)
      expect(f.events.filter((event) => event.startsWith('start:'))).toEqual(['start:handle-0'])
      expect(f.events.filter((event) => event.startsWith('loss-'))).toEqual([
        'loss-quiesce:handle-0',
        'loss-drain:handle-0',
      ])
      expect(f.events.some((event) => event.startsWith('normal-'))).toBe(false)
      await f.session.close({ reason: 'daemon-shutdown' })
    }, 30_000)

    test('normal execution pause keeps its original stop/drain and resumes only the current grant', async () => {
      const f = await fixture()
      await f.session.resume(scope)
      const g = grant()
      await f.session.hostExecutionRuntime!.start({ context: g.context, groups: ['task'] })
      await f.session.execution.pause(scope)
      expect(f.events.filter((event) => event.startsWith('normal-'))).toEqual([
        'normal-stop:handle-15',
        'normal-stop:handle-1',
        'normal-drain:handle-15',
        'normal-drain:handle-1',
      ])
      expect(f.events.some((event) => event.startsWith('loss-'))).toBe(false)
      await f.session.execution.resume(scope)
      expect(f.session.execution.state().activeHandleIds).toEqual(['handle-1', 'handle-15'])
      await f.session.close({ reason: 'daemon-shutdown' })
    })

    test('retries only the exact loss quiesce and drain ACKs that failed', async () => {
      let quiesceAttempts = 0
      let drainAttempts = 0
      const f = await fixture({
        beforeLossQuiesce: async (id) => {
          if (id === 'handle-15' && quiesceAttempts++ === 0)
            throw new Error('owner-loss-quiesce-failed')
        },
        beforeLossDrain: async (id) => {
          if (id === 'handle-15' && drainAttempts++ === 0)
            throw new Error('owner-loss-drain-failed')
        },
      })
      await f.session.resume(scope)
      const g = grant()
      await f.session.hostExecutionRuntime!.start({ context: g.context, groups: ['task'] })
      g.lose()
      await expect(
        f.session.hostExecutionRuntime!.quiesce({ context: g.context, reason: 'authority-loss' }),
      ).rejects.toThrow('owner-loss-quiesce-failed')
      await expect(f.session.hostExecutionRuntime!.drain(g.context)).rejects.toThrow(
        'drain-before-quiesce',
      )
      await f.session.hostExecutionRuntime!.quiesce({
        context: g.context,
        reason: 'authority-loss',
      })
      await expect(f.session.hostExecutionRuntime!.drain(g.context)).rejects.toThrow(
        'owner-loss-drain-failed',
      )
      expect(f.session.state().activeHandleIds).toEqual(['handle-15'])
      await f.session.hostExecutionRuntime!.drain(g.context)
      expect(f.events.filter((event) => event === 'loss-quiesce:handle-15')).toHaveLength(2)
      expect(f.events.filter((event) => event === 'loss-quiesce:handle-1')).toHaveLength(1)
      expect(f.events.filter((event) => event === 'loss-drain:handle-15')).toHaveLength(2)
      expect(f.events.filter((event) => event === 'loss-drain:handle-1')).toHaveLength(1)
      expect(f.events.some((event) => event.startsWith('normal-'))).toBe(false)
      await f.session.close({ reason: 'daemon-shutdown' })
    })

    test('explicit loss replaces a failed normal-stop retry without issuing another cancel', async () => {
      const entered = deferred<void>()
      const ack = deferred<void>()
      const f = await fixture({
        async beforeNormalStop(id) {
          if (id !== 'handle-15') return
          entered.resolve()
          await ack.promise
          throw new Error('held-normal-stop-failed')
        },
      })
      await f.session.resume(scope)
      const g = grant()
      await f.session.hostExecutionRuntime!.start({ context: g.context, groups: ['task'] })
      const pausing = f.session.execution.pause(scope)
      await entered.promise
      g.lose()
      const quiesced = f.session.hostExecutionRuntime!.quiesce({
        context: g.context,
        reason: 'authority-loss',
      })
      ack.resolve()
      await expect(pausing).rejects.toThrow('held-normal-stop-failed')
      await quiesced
      await f.session.hostExecutionRuntime!.drain(g.context)
      expect(f.events.filter((event) => event.startsWith('normal-stop:'))).toEqual([
        'normal-stop:handle-15',
      ])
      expect(f.events.filter((event) => event === 'loss-quiesce:handle-15')).toHaveLength(1)
      expect(f.events.filter((event) => event === 'loss-drain:handle-15')).toHaveLength(1)
      expect(f.session.state().activeHandleIds).toEqual([])
      await f.session.close({ reason: 'daemon-shutdown' })
    }, 30_000)

    test('a successful normal drain ACK cannot remove a handle awaiting its actual loss ACKs', async () => {
      const entered = deferred<void>()
      const ack = deferred<void>()
      const f = await fixture({
        async beforeNormalDrain(id) {
          if (id !== 'handle-15') return
          entered.resolve()
          await ack.promise
        },
      })
      await f.session.resume(scope)
      const g = grant()
      await f.session.hostExecutionRuntime!.start({ context: g.context, groups: ['task'] })
      const pausing = f.session.execution.pause(scope)
      await entered.promise
      g.lose()
      const quiesced = f.session.hostExecutionRuntime!.quiesce({
        context: g.context,
        reason: 'authority-loss',
      })
      ack.resolve()
      await pausing
      await quiesced
      expect(f.session.state().activeHandleIds).toEqual(['handle-1', 'handle-15'])
      await f.session.hostExecutionRuntime!.drain(g.context)
      expect(f.events.filter((event) => event.startsWith('normal-stop:'))).toEqual([
        'normal-stop:handle-15',
        'normal-stop:handle-1',
      ])
      expect(f.events.filter((event) => event.startsWith('normal-drain:'))).toEqual([
        'normal-drain:handle-15',
      ])
      expect(f.events.filter((event) => event.startsWith('loss-quiesce:'))).toEqual([
        'loss-quiesce:handle-15',
        'loss-quiesce:handle-1',
      ])
      expect(f.events.filter((event) => event.startsWith('loss-drain:'))).toEqual([
        'loss-drain:handle-15',
        'loss-drain:handle-1',
      ])
      expect(f.session.state()).toEqual({ phase: 'running', activeHandleIds: [] })
      await f.session.close({ reason: 'daemon-shutdown' })
    }, 30_000)

    test('provider close waits for a late lost handle without turning its loss into a cancel', async () => {
      const entered = deferred<void>()
      const releaseStart = deferred<void>()
      const drainEntered = deferred<void>()
      const releaseDrain = deferred<void>()
      const f = await fixture({
        beforeStart: (id) => {
          if (id !== 'handle-0') return Promise.resolve()
          entered.resolve()
          return releaseStart.promise
        },
        beforeLossDrain: (id) => {
          if (id !== 'handle-0') return Promise.resolve()
          drainEntered.resolve()
          return releaseDrain.promise
        },
      })
      await f.session.resume(scope)
      const g = grant()
      const starting = f.session.hostExecutionRuntime!.start({
        context: g.context,
        groups: [...new Set(groups)],
      })
      const failed = expect(starting).rejects.toThrow('grant-lost')
      await entered.promise
      g.lose()
      const loss = f.session.hostExecutionRuntime!.quiesce({
        context: g.context,
        reason: 'authority-loss',
      })
      const closing = f.session.close({ reason: 'daemon-shutdown' })
      releaseStart.resolve()
      await drainEntered.promise
      expect(f.events).not.toContain('provider:close')
      expect(f.events.some((event) => event.startsWith('normal-'))).toBe(false)
      releaseDrain.resolve()
      await failed
      await loss
      await closing
      expect(f.events.filter((event) => event.startsWith('start:'))).toEqual(['start:handle-0'])
      expect(f.events.filter((event) => event.startsWith('loss-'))).toEqual([
        'loss-quiesce:handle-0',
        'loss-drain:handle-0',
      ])
      expect(f.events.slice(-3)).toEqual(['owner:close', 'identity:close', 'provider:close'])
      expect(f.session.state()).toEqual({ phase: 'closed', activeHandleIds: [] })
    }, 30_000)

    test('wrong generations and empty activation groups perform no owner work', async () => {
      const f = await fixture()
      await f.session.resume(scope)
      const g = grant()
      const wrong = { ...g.context, generation: `${generation}-other` }
      await expect(
        f.session.hostExecutionRuntime!.start({ context: wrong, groups: ['task'] }),
      ).rejects.toThrow('generation-mismatch')
      await expect(
        f.session.hostExecutionRuntime!.quiesce({ context: wrong, reason: 'authority-loss' }),
      ).rejects.toThrow('generation-mismatch')
      await expect(f.session.hostExecutionRuntime!.drain(wrong)).rejects.toThrow(
        'generation-mismatch',
      )
      await expect(
        f.session.hostExecutionRuntime!.start({ context: g.context, groups: [] }),
      ).rejects.toThrow('unavailable')
      expect(f.events.some((event) => /^(start|native|loss|normal):/.test(event))).toBe(false)
      await f.session.close({ reason: 'daemon-shutdown' })
    })

    test('normal SO shutdown during a held start uses normal stop/drain without a loss observation', async () => {
      const entered = deferred<void>()
      const ack = deferred<void>()
      const f = await fixture({
        async beforeStart() {
          entered.resolve()
          await ack.promise
        },
      })
      await f.session.resume(scope)
      const reference = {}
      const binding = await composeHostExecutionAuthorityBinding({
        provider,
        generation,
        mode: 'execution',
        onFailure: () => {},
        selection: {
          kind: 'selected',
          factory: {
            create: () => ({
              claim: () => ({ kind: 'granted' as const, reference }),
              renew: () => ({ kind: 'granted' as const, reference }),
              activate: () => ({ kind: 'granted' as const, reference }),
              quiesce: ({ reason }) => {
                f.events.push(`authority:quiesce:${reason}`)
              },
              release: () => {
                f.events.push('authority:release')
              },
              subscribe: () => ({ close: () => {} }),
            }),
          },
          recovery: {
            kind: 'durable-intent',
            prepare: () => ({
              kind: 'prepared',
              preparationDigest: 'normal-shutdown',
              acceptedTaskContractVersions: ['test-contract-v1'],
              readyGroups: ['intent'],
            }),
            quiesce: () => {},
            drain: () => {},
          },
          runtime: f.session.hostExecutionRuntime!,
        },
      })
      const starting = binding.lifecycle.start()
      await entered.promise
      let closed = false
      const closing = binding.lifecycle.close().then(() => {
        closed = true
      })
      expect(binding.admission.acquire('intent').kind).toBe('unavailable')
      await Promise.resolve()
      expect(closed).toBe(false)
      ack.resolve()
      await expect(starting).rejects.toThrow('host-execution-runtime-grant-lost')
      await closing
      expect(f.events.filter((event) => event.startsWith('normal-'))).toEqual([
        'normal-stop:handle-0',
        'normal-drain:handle-0',
      ])
      expect(f.events.filter((event) => event.startsWith('loss-'))).toEqual([])
      expect(f.events).toContain('authority:quiesce:shutdown')
      expect(f.events.indexOf('normal-drain:handle-0')).toBeLessThan(
        f.events.indexOf('authority:release'),
      )
      expect(binding.queries.snapshot().phase).toBe('closed')
      expect(f.session.state()).toEqual({ phase: 'running', activeHandleIds: [] })
      await f.session.close({ reason: 'daemon-shutdown' })
    }, 30_000)

    test('the real SO lifecycle activates before handles and drains before authority release', async () => {
      const f = await fixture()
      await f.session.resume(scope)
      const reference = {}
      let observe!: (value: HostExecutionAuthorityObservation) => void
      const binding = await composeHostExecutionAuthorityBinding({
        provider,
        generation,
        mode: 'execution',
        onFailure: (error) => {
          throw error
        },
        selection: {
          kind: 'selected',
          factory: {
            create: () => ({
              claim: () => {
                f.events.push('authority:claim')
                return { kind: 'granted' as const, reference }
              },
              renew: () => ({ kind: 'granted' as const, reference }),
              activate: () => {
                f.events.push('authority:activate')
                return { kind: 'granted' as const, reference }
              },
              quiesce: () => {
                f.events.push('authority:quiesce')
              },
              release: () => {
                f.events.push('authority:release')
              },
              subscribe: (receiver) => {
                observe = receiver.onObservation
                return {
                  close: () => {
                    f.events.push('authority:unsubscribe')
                  },
                }
              },
            }),
          },
          recovery: {
            kind: 'durable-intent',
            prepare: (context) => {
              expect(context.current()).toBe(true)
              f.events.push('recovery:prepare')
              return {
                kind: 'prepared',
                preparationDigest: 'prepared-real-session',
                acceptedTaskContractVersions: ['test-contract-v1'],
                readyGroups: ['task', 'intent'],
              }
            },
            quiesce: () => {
              f.events.push('recovery:quiesce')
            },
            drain: () => {
              f.events.push('recovery:drain')
            },
          },
          runtime: f.session.hostExecutionRuntime!,
        },
      })
      await binding.lifecycle.start()
      expect(binding.queries.snapshot().phase).toBe('active')
      expect(f.events.indexOf('authority:activate')).toBeLessThan(
        f.events.indexOf('start:handle-0'),
      )
      const admitted = binding.admission.acquire('task')
      expect(admitted.kind).toBe('admitted')
      if (admitted.kind !== 'admitted') throw new Error('missing actual admission')
      observe({ kind: 'lost', reason: 'platform-authority-lost' })
      expect(binding.admission.acquire('task').kind).toBe('unavailable')
      expect(await admitted.lease.stopped).toBe('authority-loss')
      admitted.lease.complete()
      await binding.lifecycle.settled()
      expect(f.events.indexOf('loss-drain:handle-0')).toBeLessThan(
        f.events.indexOf('authority:release'),
      )
      expect(f.session.state()).toEqual({ phase: 'running', activeHandleIds: [] })
      expect(f.events.some((event) => event.startsWith('normal-'))).toBe(false)
      await binding.lifecycle.close()
      await f.session.close({ reason: 'daemon-shutdown' })
    }, 30_000)
  })
}
