import { describe, expect, test } from 'bun:test'

import type { DaemonProviderSessionLifecycleInput } from '../src/cli/daemonProviderSession'
import {
  createDaemonProviderRuntimeSession,
  DaemonProviderRuntimeSessionError,
  type DaemonProviderRuntimeHandleFactory,
} from '../src/cli/daemonProviderRuntimeSession'
import type { DatabaseProvider } from '../src/platform/persistence/databaseProviders'

function recordingFactory(id: string, events: string[]): DaemonProviderRuntimeHandleFactory {
  let starts = 0
  return {
    id,
    start() {
      starts += 1
      const handleId = `${id}-${starts}`
      events.push(`start:${handleId}`)
      return {
        stop() {
          events.push(`stop:${handleId}`)
        },
        drain() {
          events.push(`drain:${handleId}`)
        },
      }
    },
  }
}

async function harness(
  provider: DatabaseProvider,
  options: {
    readonly events?: string[]
    readonly factories?: readonly DaemonProviderRuntimeHandleFactory[]
    readonly openWriter?: () => void
    readonly closeParticipant?: () => void
  } = {},
) {
  const events = options.events ?? []
  const scope: DaemonProviderSessionLifecycleInput = {
    operationId: 'execution-1',
    provider,
    generationId: `${provider}-1`,
  }
  let writerOpen = false
  let socketOpen = false
  let saved = 'original'
  const websocketHandlers = Object.freeze({ message: () => saved })
  const session = await createDaemonProviderRuntimeSession({
    provider,
    generationId: scope.generationId,
    runtime: {
      async fetch(request) {
        if (!writerOpen) return new Response('provider frozen', { status: 503 })
        if (request.method === 'POST') saved = await request.text()
        return new Response(saved)
      },
      tryUpgrade: () => socketOpen,
      websocketHandlers,
    },
    admission: {
      closeWriterAdmission() {
        events.push('admission:writer:close')
        writerOpen = false
      },
      openWriterAdmission() {
        events.push('admission:writer:open')
        options.openWriter?.()
        writerOpen = true
      },
      closeWebSocketAdmission() {
        events.push('admission:ws:close')
        socketOpen = false
      },
      openWebSocketAdmission() {
        events.push('admission:ws:open')
        socketOpen = true
      },
    },
    runtimeFactories: options.factories ?? [recordingFactory('runtime', events)],
    backgroundWriterFactories:
      options.factories === undefined ? [recordingFactory('background', events)] : [],
    providerCloseParticipants: [
      {
        id: 'participant',
        close() {
          events.push('close:participant')
          options.closeParticipant?.()
        },
      },
    ],
    shutdownIdentity() {
      events.push('identity:shutdown')
    },
    closeProvider() {
      events.push('provider:close')
    },
  })
  return { session, scope, events, websocketHandlers }
}

function rejected(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected lifecycle rejection')
    },
    (error: unknown) => error,
  )
}

const read = () => new Request('http://daemon.test/resources')
const edit = () => new Request('http://daemon.test/resources', { method: 'POST', body: 'edited' })

for (const provider of ['sqlite', 'postgresql'] as const) {
  describe(`RFC-370 independent execution lifecycle (${provider})`, () => {
    test('pauses execution while HTTP edits and WS delegates remain usable', async () => {
      const { session, scope, events, websocketHandlers } = await harness(provider)
      expect(session.execution.state()).toEqual({
        enabled: true,
        running: false,
        activeHandleIds: [],
      })
      await session.resume(scope)
      const running = session.execution.state()
      expect(running).toEqual({
        enabled: true,
        running: true,
        activeHandleIds: ['runtime', 'background'],
      })
      expect(Object.isFrozen(session.execution)).toBe(true)
      expect(Object.isFrozen(running)).toBe(true)
      expect(Object.isFrozen(running.activeHandleIds)).toBe(true)
      expect(session.execution.state()).not.toBe(running)
      events.length = 0

      await session.execution.pause(scope)
      await session.execution.pause(scope)
      expect(events).toEqual([
        'stop:background-1',
        'stop:runtime-1',
        'drain:background-1',
        'drain:runtime-1',
      ])
      expect(session.state()).toEqual({ phase: 'running', activeHandleIds: [] })
      expect(session.execution.state()).toEqual({
        enabled: false,
        running: false,
        activeHandleIds: [],
      })
      expect(await (await session.runtime.fetch(edit())).text()).toBe('edited')
      expect(await (await session.runtime.fetch(read())).text()).toBe('edited')
      expect(await session.runtime.tryUpgrade(read(), undefined)).toBe(true)
      expect(session.runtime.websocketHandlers).toBe(websocketHandlers)
      expect(session.runtime.websocketHandlers.message()).toBe('edited')
      expect(running.activeHandleIds).toEqual(['runtime', 'background'])

      events.length = 0
      await session.execution.resume(scope)
      await session.execution.resume(scope)
      expect(events).toEqual(['start:runtime-2', 'start:background-2'])
      expect(session.execution.state().running).toBe(true)
      await session.pause(scope)
      expect((await session.runtime.fetch(read())).status).toBe(503)
      expect(await session.runtime.tryUpgrade(read(), undefined)).toBe(false)
    })

    test('opens the control plane with no workers, and frozen execution resume never starts early', async () => {
      const { session, scope, events } = await harness(provider)
      events.length = 0
      await session.execution.pause(scope)
      await session.execution.resume(scope)
      expect(events).toEqual([])
      expect(session.execution.state()).toEqual({
        enabled: true,
        running: false,
        activeHandleIds: [],
      })
      await session.execution.pause(scope)
      await session.resume(scope)
      expect(events).toEqual(['admission:ws:open', 'admission:writer:open'])
      expect(session.state()).toEqual({ phase: 'running', activeHandleIds: [] })
      expect(await (await session.runtime.fetch(edit())).text()).toBe('edited')
      expect(await session.runtime.tryUpgrade(read(), undefined)).toBe(true)

      events.length = 0
      await session.execution.resume(scope)
      await session.execution.resume(scope)
      expect(events).toEqual(['start:runtime-1', 'start:background-1'])
      expect(session.execution.state().running).toBe(true)
    })

    test('keeps explicit execution pause through provider pause, failed resume and rollback resume', async () => {
      const failure = new Error('control writer open failed')
      let failOpen = false
      const { session, scope, events } = await harness(provider, {
        openWriter() {
          if (failOpen) {
            failOpen = false
            throw failure
          }
        },
      })
      await session.resume(scope)
      await session.execution.pause(scope)
      await session.pause(scope)
      events.length = 0
      failOpen = true
      expect(await rejected(session.resume(scope))).toBe(failure)
      expect(events).toEqual([
        'admission:ws:open',
        'admission:writer:open',
        'admission:writer:close',
        'admission:ws:close',
      ])
      expect(session.state()).toEqual({ phase: 'frozen', activeHandleIds: [] })
      expect(session.execution.state()).toEqual({
        enabled: false,
        running: false,
        activeHandleIds: [],
      })

      events.length = 0
      await session.resume(scope)
      expect(events).toEqual(['admission:ws:open', 'admission:writer:open'])
      expect(session.execution.state().enabled).toBe(false)
      expect(await (await session.runtime.fetch(read())).text()).toBe('original')
    })

    test('rolls back a partial execution start without closing control delegates and preserves the original error', async () => {
      const events: string[] = []
      const failure = new Error('background start failed')
      let fails = true
      const { session, scope } = await harness(provider, {
        events,
        factories: [
          recordingFactory('runtime', events),
          {
            id: 'background',
            start() {
              events.push('start:background')
              if (fails) {
                fails = false
                throw failure
              }
              return {
                stop() {
                  events.push('stop:background')
                },
                drain() {
                  events.push('drain:background')
                },
              }
            },
          },
        ],
      })
      await session.execution.pause(scope)
      await session.resume(scope)
      events.length = 0
      expect(await rejected(session.execution.resume(scope))).toBe(failure)
      expect(events).toEqual([
        'start:runtime-1',
        'start:background',
        'stop:runtime-1',
        'drain:runtime-1',
      ])
      expect(session.state()).toEqual({ phase: 'running', activeHandleIds: [] })
      expect(session.execution.state()).toEqual({
        enabled: false,
        running: false,
        activeHandleIds: [],
      })
      expect(await (await session.runtime.fetch(edit())).text()).toBe('edited')
      expect(await session.runtime.tryUpgrade(read(), undefined)).toBe(true)
      events.length = 0
      await session.execution.resume(scope)
      expect(events).toEqual(['start:runtime-2', 'start:background'])
      expect(session.execution.state().running).toBe(true)
    })

    test('retains successful stop and drain ACKs, then settles only failed stages before restarting', async () => {
      const events: string[] = []
      const stopFailure = new Error('first stop failed')
      const drainFailure = new Error('second drain failed')
      let failStop = true
      let failDrain = true
      const { session, scope } = await harness(provider, {
        events,
        factories: [
          {
            id: 'first',
            start() {
              events.push('start:first')
              return {
                stop() {
                  events.push('stop:first')
                  if (failStop) {
                    failStop = false
                    throw stopFailure
                  }
                },
                drain() {
                  events.push('drain:first')
                },
              }
            },
          },
          {
            id: 'second',
            start() {
              events.push('start:second')
              return {
                stop() {
                  events.push('stop:second')
                },
                drain() {
                  events.push('drain:second')
                  if (failDrain) {
                    failDrain = false
                    throw drainFailure
                  }
                },
              }
            },
          },
        ],
      })
      await session.resume(scope)
      events.length = 0
      const failure = await rejected(session.execution.pause(scope))
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([stopFailure, drainFailure])
      expect(events).toEqual(['stop:second', 'stop:first', 'drain:second'])
      expect(session.execution.state()).toEqual({
        enabled: false,
        running: false,
        activeHandleIds: ['first', 'second'],
      })
      expect((await session.runtime.fetch(read())).status).toBe(200)

      events.length = 0
      await session.execution.resume(scope)
      expect(events).toEqual([
        'stop:first',
        'drain:second',
        'drain:first',
        'start:first',
        'start:second',
      ])
      expect(session.execution.state().running).toBe(true)
    })

    test('preserves failed start and rollback errors and does not retry stale failure in the same resume', async () => {
      const events: string[] = []
      const startFailure = new Error('second start failed')
      const stopFailure = new Error('first stop failed')
      let startsFail = true
      let stopsFail = true
      const { session, scope } = await harness(provider, {
        events,
        factories: [
          {
            id: 'first',
            start() {
              events.push('start:first')
              return {
                stop() {
                  events.push('stop:first')
                  if (stopsFail) throw stopFailure
                },
                drain() {
                  events.push('drain:first')
                },
              }
            },
          },
          {
            id: 'second',
            start() {
              events.push('start:second')
              if (startsFail) throw startFailure
              return { stop: () => undefined, drain: () => undefined }
            },
          },
        ],
      })
      await session.execution.pause(scope)
      await session.resume(scope)
      events.length = 0
      const failure = await rejected(session.execution.resume(scope))
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([startFailure, stopFailure])
      expect(events).toEqual(['start:first', 'start:second', 'stop:first'])
      expect(session.execution.state()).toEqual({
        enabled: false,
        running: false,
        activeHandleIds: ['first'],
      })

      events.length = 0
      expect(await rejected(session.execution.resume(scope))).toBe(stopFailure)
      expect(events).toEqual(['stop:first'])
      expect(session.execution.state().enabled).toBe(false)
      expect(await session.runtime.tryUpgrade(read(), undefined)).toBe(true)
      stopsFail = false
      startsFail = false
      events.length = 0
      await session.execution.resume(scope)
      expect(events).toEqual(['stop:first', 'drain:first', 'start:first', 'start:second'])
      expect(session.execution.state().running).toBe(true)
    })

    test('shares the provider queue across concurrent execution resume, pause and close', async () => {
      const events: string[] = []
      let announceStart!: () => void
      let releaseStart!: () => void
      const announced = new Promise<void>((resolve) => {
        announceStart = resolve
      })
      const released = new Promise<void>((resolve) => {
        releaseStart = resolve
      })
      const { session, scope } = await harness(provider, {
        events,
        factories: [
          {
            id: 'runtime',
            async start() {
              events.push('start:begin')
              announceStart()
              await released
              events.push('start:end')
              return {
                stop() {
                  events.push('stop:runtime')
                },
                drain() {
                  events.push('drain:runtime')
                },
              }
            },
          },
        ],
      })
      await session.execution.pause(scope)
      await session.resume(scope)
      events.length = 0
      const resume = session.execution.resume(scope)
      await announced
      expect(session.execution.state()).toEqual({
        enabled: true,
        running: false,
        activeHandleIds: [],
      })
      const duplicateResume = session.execution.resume(scope)
      const pause = session.execution.pause(scope)
      const duplicatePause = session.execution.pause(scope)
      const close = session.close({ reason: 'daemon-shutdown' })
      releaseStart()
      await Promise.all([resume, duplicateResume, pause, duplicatePause, close])
      expect(events).toEqual([
        'start:begin',
        'start:end',
        'stop:runtime',
        'drain:runtime',
        'admission:writer:close',
        'admission:ws:close',
        'close:participant',
        'identity:shutdown',
        'provider:close',
      ])
      expect(session.state()).toEqual({ phase: 'closed', activeHandleIds: [] })
      expect(session.execution.state()).toEqual({
        enabled: false,
        running: false,
        activeHandleIds: [],
      })
      await expect(session.execution.resume(scope)).rejects.toMatchObject({
        code: 'daemon-provider-runtime-session-closing',
      })
    })

    test('rejects mismatched or closing calls before changing execution intent and keeps close progress', async () => {
      const closeFailure = new Error('participant close failed')
      let closeFails = true
      const { session, scope, events } = await harness(provider, {
        closeParticipant() {
          if (closeFails) {
            closeFails = false
            throw closeFailure
          }
        },
      })
      await session.resume(scope)
      events.length = 0
      const mismatch = { ...scope, generationId: 'other' }
      for (const operation of [session.execution.pause, session.execution.resume]) {
        const failure = await rejected(operation(mismatch))
        expect(failure).toBeInstanceOf(DaemonProviderRuntimeSessionError)
        expect(failure).toMatchObject({ code: 'daemon-provider-runtime-session-mismatch' })
      }
      expect(session.execution.state().enabled).toBe(true)
      expect(events).toEqual([])
      expect(await rejected(session.close({ reason: 'provider-switch' }))).toBe(closeFailure)
      expect(session.state().phase).toBe('closing')
      expect(session.execution.state().running).toBe(false)
      events.length = 0
      for (const operation of [session.execution.pause, session.execution.resume]) {
        const failure = await rejected(operation(scope))
        expect(failure).toBeInstanceOf(DaemonProviderRuntimeSessionError)
        expect(failure).toMatchObject({ code: 'daemon-provider-runtime-session-closing' })
      }
      expect(session.execution.state().enabled).toBe(true)
      expect(events).toEqual([])
      await session.close({ reason: 'daemon-shutdown' })
      await session.close({ reason: 'daemon-shutdown' })
      expect(events).toEqual(['close:participant', 'identity:shutdown', 'provider:close'])
      expect(session.state().phase).toBe('closed')
    })

    test('reports an empty factory set running only after provider readiness', async () => {
      const { session, scope, events } = await harness(provider, { factories: [] })
      await session.execution.resume(scope)
      expect(session.execution.state()).toEqual({
        enabled: true,
        running: false,
        activeHandleIds: [],
      })
      await session.execution.pause(scope)
      await session.resume(scope)
      expect(session.execution.state().running).toBe(false)
      events.length = 0
      await session.execution.resume(scope)
      await session.execution.resume(scope)
      expect(events).toEqual([])
      expect(session.execution.state()).toEqual({
        enabled: true,
        running: true,
        activeHandleIds: [],
      })
    })
  })
}
