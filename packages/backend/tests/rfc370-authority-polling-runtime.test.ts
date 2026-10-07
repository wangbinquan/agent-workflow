// RFC-370 H7: selected polling owns its exact loop and actual callback ACK.
// Provider scopes and the real RuntimeSession are exercised here; these are
// not acceptance evidence for nineteen business owners or database writes.
import { describe, expect, spyOn, test } from 'bun:test'
import {
  createAuthorityPollingDaemonRuntimeHandleBinding,
  type AuthorityPollingDaemonRuntimeHandleBindingInput,
  type AuthorityPollingDaemonRuntimeRunInput,
} from '../src/cli/daemonProviderRuntimeHandles'
import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderRuntimeHandle,
} from '../src/cli/daemonProviderRuntimeSession'
import type { HostExecutionGrantContext } from '../src/modules/system-operations/public/participants'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function yieldPromises() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

for (const provider of ['sqlite', 'postgresql'] as const) {
  describe(`RFC-370 ${provider} selected polling lifetime`, () => {
    const generation = `${provider}-polling-generation`
    const scope = { operationId: 'polling-operation', provider, generationId: generation }

    function grant() {
      let active = true
      const context = {
        generation,
        reference: {},
        current() {
          expect(this).toBe(context)
          return active
        },
      } satisfies HostExecutionGrantContext
      return {
        context,
        lose: () => {
          active = false
        },
      }
    }

    function input(
      overrides: Partial<AuthorityPollingDaemonRuntimeHandleBindingInput> = {},
    ): AuthorityPollingDaemonRuntimeHandleBindingInput {
      return {
        id: 'polling-owner',
        group: 'memory',
        intervalMs: 60_000,
        runImmediately: true,
        run: async () => undefined,
        onError: (error) => {
          throw error
        },
        ...overrides,
      }
    }

    async function session(bindingInput: AuthorityPollingDaemonRuntimeHandleBindingInput) {
      const events: string[] = []
      const binding = createAuthorityPollingDaemonRuntimeHandleBinding(bindingInput)
      const runtime = await createDaemonProviderRuntimeSession({
        provider,
        generationId: generation,
        runtime: {
          fetch: () => new Response('resources-ready'),
          tryUpgrade: () => false as const,
          websocketHandlers: {},
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
        runtimeFactories: [
          {
            id: binding.id,
            start() {
              events.push('native:fallback')
              throw new Error('selected polling must not start native fallback')
            },
          },
        ],
        hostExecutionRuntime: { handles: [binding] },
        shutdownIdentity: () => {
          events.push('identity:close')
        },
        closeProvider: () => {
          events.push('provider:close')
        },
      })
      await runtime.resume(scope)
      const family = runtime.hostExecutionRuntime!
      return { runtime, family, events, binding }
    }

    test('invalid complete selection and expired start have no timer or owner effects', async () => {
      const timer = spyOn(globalThis, 'setTimeout')
      let callbacks = 0
      const original = input({
        beforeStart: () => {
          callbacks += 1
        },
        run: async () => {
          callbacks += 1
        },
      })
      const g = grant()
      try {
        for (const invalid of [0, -1, 1.5, Number.NaN]) {
          expect(() =>
            createAuthorityPollingDaemonRuntimeHandleBinding({ ...original, intervalMs: invalid }),
          ).toThrow('positive integer')
        }
        expect(() =>
          createAuthorityPollingDaemonRuntimeHandleBinding({ ...original, id: '' }),
        ).toThrow('binding-incomplete')
        expect(() =>
          createAuthorityPollingDaemonRuntimeHandleBinding({
            ...original,
            run: undefined,
          } as unknown as AuthorityPollingDaemonRuntimeHandleBindingInput),
        ).toThrow('callback-incomplete')
        const binding = createAuthorityPollingDaemonRuntimeHandleBinding(original)
        await expect(
          binding.start({
            scope,
            context: { ...g.context, current: undefined } as unknown as HostExecutionGrantContext,
          }),
        ).rejects.toThrow('current-missing')
        await expect(
          binding.start({
            scope: { ...scope, generationId: 'other-generation' },
            context: g.context,
          }),
        ).rejects.toThrow('generation-mismatch')
        g.lose()
        await expect(binding.start({ scope, context: g.context })).rejects.toThrow('not-current')
        expect(callbacks).toBe(0)
        expect(timer).not.toHaveBeenCalled()
      } finally {
        timer.mockRestore()
      }
    })

    test('a late beforeStart ACK after loss returns a stopped zero-loop handle', async () => {
      const entered = deferred()
      const beforeAck = deferred()
      const timer = spyOn(globalThis, 'setTimeout')
      const g = grant()
      let runs = 0
      let returned = false
      const binding = createAuthorityPollingDaemonRuntimeHandleBinding(
        input({
          async beforeStart(actual) {
            expect(actual.scope).toBe(scope)
            expect(actual.context).toBe(g.context)
            entered.resolve()
            await beforeAck.promise
          },
          run: async () => {
            runs += 1
          },
        }),
      )
      const pending = Promise.resolve(binding.start({ scope, context: g.context }))
      void pending.then(() => {
        returned = true
      })
      try {
        await entered.promise
        g.lose()
        await yieldPromises()
        expect(returned).toBe(false)
        beforeAck.resolve()
        const handle = await pending
        expect(Object.isFrozen(handle)).toBe(true)
        expect(runs).toBe(0)
        expect(timer).not.toHaveBeenCalled()
        await binding.quiesceAuthorityLoss({ handle, context: g.context })
        await binding.drainAuthorityLoss({ handle, context: g.context })
        await handle.drain()
      } finally {
        beforeAck.resolve()
        timer.mockRestore()
      }
    })

    test('real provider resource resume starts no selected or native loop without a grant', async () => {
      let runs = 0
      const f = await session(
        input({
          run: async () => {
            runs += 1
          },
        }),
      )
      try {
        expect(f.runtime.execution.state().activeHandleIds).toEqual([])
        expect(await (await f.runtime.runtime.fetch(new Request('http://resource/'))).text()).toBe(
          'resources-ready',
        )
        expect(runs).toBe(0)
        expect(f.events).not.toContain('native:fallback')
      } finally {
        await f.runtime.close({ reason: 'daemon-shutdown' })
      }
    })

    test('real loss quiesce and drain await issued work while resource delegates stay usable', async () => {
      const entered = deferred()
      const work = deferred()
      const g = grant()
      let runs = 0
      let retired = false
      let callbackInput: AuthorityPollingDaemonRuntimeRunInput | undefined
      const f = await session(
        input({
          async run(actual) {
            runs += 1
            callbackInput = actual
            entered.resolve()
            await work.promise
          },
        }),
      )
      try {
        await f.family.start({ context: g.context, groups: ['memory'] })
        await entered.promise
        expect(callbackInput?.context).toBe(g.context)
        expect(callbackInput?.scope.provider).toBe(provider)
        expect(Object.keys(callbackInput!).sort()).toEqual(['context', 'current', 'scope'])
        const resourceEvents = [...f.events]
        g.lose()
        const retiring = f.family.quiesce({ context: g.context, reason: 'authority-loss' })
        void Promise.resolve(retiring).then(() => {
          retired = true
        })
        await yieldPromises()
        expect(retired).toBe(false)
        expect(f.events).toEqual(resourceEvents)
        expect(await (await f.runtime.runtime.fetch(new Request('http://resource/'))).text()).toBe(
          'resources-ready',
        )
        work.resolve()
        await retiring
        await f.family.drain(g.context)
        expect(runs).toBe(1)
        expect(f.runtime.execution.state().activeHandleIds).toEqual([])
      } finally {
        work.resolve()
        await f.runtime.close({ reason: 'daemon-shutdown' })
      }
    })

    test('the captured current callback blocks dispatch after an owner query ACK', async () => {
      const entered = deferred()
      const query = deferred()
      const g = grant()
      let writes = 0
      const f = await session(
        input({
          async run(actual) {
            entered.resolve()
            await query.promise
            if (actual.current()) writes += 1
          },
        }),
      )
      try {
        await f.family.start({ context: g.context, groups: ['memory'] })
        await entered.promise
        g.lose()
        g.context.current = () => true
        const retiring = f.family.quiesce({ context: g.context, reason: 'authority-loss' })
        query.resolve()
        await retiring
        await f.family.drain(g.context)
        expect(writes).toBe(0)
      } finally {
        query.resolve()
        await f.runtime.close({ reason: 'daemon-shutdown' })
      }
    })

    test('selected callbacks retain original identities, receiver and grant references', async () => {
      const beforeEntered = deferred()
      const beforeAck = deferred()
      const runEntered = deferred()
      const runAck = deferred()
      const error = new Error('original-run-error')
      const g = grant()
      const received: AuthorityPollingDaemonRuntimeRunInput[] = []
      let fallbackCalls = 0
      const original = {
        ...input(),
        async beforeStart(actual: AuthorityPollingDaemonRuntimeRunInput) {
          expect(this).toBe(original)
          received.push(actual)
          beforeEntered.resolve()
          await beforeAck.promise
        },
        async run(actual: AuthorityPollingDaemonRuntimeRunInput) {
          expect(this).toBe(original)
          received.push(actual)
          runEntered.resolve()
          await runAck.promise
          throw error
        },
        onError(actualError: unknown, actual: AuthorityPollingDaemonRuntimeRunInput) {
          expect(this).toBe(original)
          expect(actualError).toBe(error)
          received.push(actual)
        },
      }
      const binding = createAuthorityPollingDaemonRuntimeHandleBinding(original)
      const starting = Promise.resolve(binding.start({ scope, context: g.context }))
      try {
        await beforeEntered.promise
        original.beforeStart = async () => {
          fallbackCalls += 1
        }
        original.run = async () => {
          fallbackCalls += 1
        }
        original.onError = () => {
          fallbackCalls += 1
        }
        beforeAck.resolve()
        const handle = await starting
        await runEntered.promise
        await handle.stop()
        runAck.resolve()
        await handle.drain()
        expect(fallbackCalls).toBe(0)
        expect(received).toHaveLength(3)
        expect(
          received.every(
            (actual) =>
              actual === received[0] && actual.context === g.context && actual.scope === scope,
          ),
        ).toBe(true)
        expect(Object.isFrozen(received[0])).toBe(true)
      } finally {
        beforeAck.resolve()
        runAck.resolve()
      }
    })

    test('normal stop waits the actual onError ACK and never changes owner work into cancel', async () => {
      const errorEntered = deferred()
      const errorAck = deferred()
      const g = grant()
      const originalError = new Error('owner-query-failed')
      let drained = false
      let errors = 0
      const binding = createAuthorityPollingDaemonRuntimeHandleBinding(
        input({
          run: async () => {
            throw originalError
          },
          async onError(error, actual) {
            expect(error).toBe(originalError)
            expect(actual.context).toBe(g.context)
            errors += 1
            errorEntered.resolve()
            await errorAck.promise
          },
        }),
      )
      const handle = await binding.start({ scope, context: g.context })
      try {
        await errorEntered.promise
        await handle.stop()
        const draining = Promise.resolve(handle.drain())
        void draining.then(() => {
          drained = true
        })
        await yieldPromises()
        expect(drained).toBe(false)
        errorAck.resolve()
        await draining
        await handle.stop()
        await handle.drain()
        expect(errors).toBe(1)
      } finally {
        errorAck.resolve()
        await handle.stop()
        await handle.drain()
      }
    })

    test('a rejected error ACK remains the exact drain error instead of a successful receipt', async () => {
      const errorEntered = deferred()
      const errorAck = deferred()
      const fatal = new Error('error-ack-failed')
      const g = grant()
      const binding = createAuthorityPollingDaemonRuntimeHandleBinding(
        input({
          run: async () => {
            throw new Error('run-failed')
          },
          async onError() {
            errorEntered.resolve()
            await errorAck.promise
          },
        }),
      )
      const handle = await binding.start({ scope, context: g.context })
      await errorEntered.promise
      await handle.stop()
      const draining = Promise.resolve(handle.drain())
      const expected = expect(draining).rejects.toBe(fatal)
      errorAck.reject(fatal)
      await expected
      await expect(
        Promise.resolve(binding.quiesceAuthorityLoss({ handle, context: g.context })),
      ).rejects.toBe(fatal)
      await expect(
        Promise.resolve(binding.drainAuthorityLoss({ handle, context: g.context })),
      ).rejects.toBe(fatal)
    })

    test('beforeStart failure preserves the actual error and never creates a loop', async () => {
      const failure = new Error('before-start-failed')
      const g = grant()
      let runs = 0
      const timer = spyOn(globalThis, 'setTimeout')
      try {
        const binding = createAuthorityPollingDaemonRuntimeHandleBinding(
          input({
            beforeStart: () => {
              throw failure
            },
            run: async () => {
              runs += 1
            },
          }),
        )
        await expect(Promise.resolve(binding.start({ scope, context: g.context }))).rejects.toBe(
          failure,
        )
        expect(runs).toBe(0)
        expect(timer).not.toHaveBeenCalled()
      } finally {
        timer.mockRestore()
      }
    })

    test('old loss receipts and repeated retirement cannot stop a newer loop', async () => {
      const firstAck = deferred()
      const secondAck = deferred()
      const firstEntered = deferred()
      const secondEntered = deferred()
      const old = grant()
      const fresh = grant()
      let runs = 0
      const binding = createAuthorityPollingDaemonRuntimeHandleBinding(
        input({
          async run(actual) {
            runs += 1
            if (actual.context === old.context) {
              firstEntered.resolve()
              await firstAck.promise
            } else {
              expect(actual.context).toBe(fresh.context)
              secondEntered.resolve()
              await secondAck.promise
            }
          },
        }),
      )
      const oldHandle = await binding.start({ scope, context: old.context })
      await firstEntered.promise
      old.lose()
      const oldRetirement = binding.quiesceAuthorityLoss({
        handle: oldHandle,
        context: old.context,
      })
      firstAck.resolve()
      await oldRetirement
      await binding.drainAuthorityLoss({ handle: oldHandle, context: old.context })
      const freshHandle = await binding.start({ scope, context: fresh.context })
      try {
        await secondEntered.promise
        await binding.quiesceAuthorityLoss({ handle: oldHandle, context: old.context })
        await binding.drainAuthorityLoss({ handle: oldHandle, context: old.context })
        await oldHandle.stop()
        await oldHandle.drain()
        await expect(Promise.resolve(freshHandle.drain())).rejects.toThrow(
          'cannot drain before stop',
        )
        expect(runs).toBe(2)
      } finally {
        secondAck.resolve()
        await freshHandle.stop()
        await freshHandle.drain()
      }
    })

    test('mismatched handle or context rejects before stopping any lifetime', async () => {
      const work = deferred()
      const entered = deferred()
      const g = grant()
      const other = grant()
      let foreignStops = 0
      const foreign: DaemonProviderRuntimeHandle = {
        stop: () => {
          foreignStops += 1
        },
        drain: () => undefined,
      }
      const binding = createAuthorityPollingDaemonRuntimeHandleBinding(
        input({
          async run() {
            entered.resolve()
            await work.promise
          },
        }),
      )
      const handle = await binding.start({ scope, context: g.context })
      try {
        await entered.promise
        expect(() => binding.quiesceAuthorityLoss({ handle, context: other.context })).toThrow(
          'context-mismatch',
        )
        expect(() => binding.drainAuthorityLoss({ handle: foreign, context: g.context })).toThrow(
          'context-mismatch',
        )
        await expect(
          Promise.resolve(binding.drainAuthorityLoss({ handle, context: g.context })),
        ).rejects.toThrow('drain-before-quiesce')
        await expect(Promise.resolve(handle.drain())).rejects.toThrow('cannot drain before stop')
        expect(foreignStops).toBe(0)
      } finally {
        work.resolve()
        await handle.stop()
        await handle.drain()
      }
    })

    test('a non-immediate loop owns one interval that normal stop drains without a tick', async () => {
      const g = grant()
      let runs = 0
      const timer = spyOn(globalThis, 'setTimeout')
      const binding = createAuthorityPollingDaemonRuntimeHandleBinding(
        input({
          runImmediately: false,
          run: async () => {
            runs += 1
          },
        }),
      )
      try {
        const handle = await binding.start({ scope, context: g.context })
        expect(timer.mock.calls.filter(([, interval]) => interval === 60_000)).toHaveLength(1)
        expect(runs).toBe(0)
        await handle.stop()
        await handle.drain()
        expect(runs).toBe(0)
      } finally {
        timer.mockRestore()
      }
    })
  })
}
