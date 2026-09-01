import { describe, expect, test } from 'bun:test'

import type { DaemonProviderSessionLifecycleInput } from '../src/cli/daemonProviderSession'
import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderCloseParticipant,
  type DaemonProviderRuntimeAdmission,
  type DaemonProviderRuntimeHandleFactory,
} from '../src/cli/daemonProviderRuntimeSession'

const lifecycle: DaemonProviderSessionLifecycleInput = {
  operationId: 'operation-1',
  provider: 'sqlite',
  generationId: 'sqlite-1',
}

function append(events: string[], event: string): () => void {
  return () => {
    events.push(event)
  }
}

function admission(events: string[]): DaemonProviderRuntimeAdmission {
  return {
    closeWriterAdmission() {
      events.push('admission:writer:close')
    },
    openWriterAdmission() {
      events.push('admission:writer:open')
    },
    closeWebSocketAdmission() {
      events.push('admission:ws:close')
    },
    openWebSocketAdmission() {
      events.push('admission:ws:open')
    },
  }
}

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

function runtimePayload() {
  const tryUpgrade = (): false => false
  return {
    db: Object.freeze({ deliberatelyNotPublic: true }),
    fetch: () => new Response('ok'),
    tryUpgrade,
    websocketHandlers: Object.freeze({ open: () => undefined }),
  }
}

describe('RFC-349 concrete daemon provider runtime session', () => {
  test('disposes the rejected composition in order when the initial freeze fails', async () => {
    const events: string[] = []
    await expect(
      createDaemonProviderRuntimeSession({
        provider: 'sqlite',
        generationId: 'sqlite-1',
        runtime: runtimePayload(),
        admission: {
          closeWriterAdmission() {
            events.push('admission:writer:close')
            throw new Error('writer-freeze-failed')
          },
          openWriterAdmission: () => undefined,
          closeWebSocketAdmission: append(events, 'admission:ws:close'),
          openWebSocketAdmission: () => undefined,
        },
        providerCloseParticipants: [
          {
            id: 'runtime-close',
            close: append(events, 'close:runtime'),
          },
        ],
        shutdownIdentity: append(events, 'identity:shutdown'),
        closeProvider: append(events, 'provider:close'),
      }),
    ).rejects.toThrow('writer-freeze-failed')
    expect(events).toEqual([
      'admission:writer:close',
      'admission:ws:close',
      'close:runtime',
      'identity:shutdown',
      'provider:close',
    ])
  })

  test('starts frozen, exposes only delegates, and rebuilds terminal handles after pause', async () => {
    const events: string[] = []
    const session = await createDaemonProviderRuntimeSession({
      provider: 'sqlite',
      generationId: 'sqlite-1',
      runtime: runtimePayload(),
      admission: admission(events),
      runtimeFactories: [recordingFactory('runtime', events)],
      backgroundWriterFactories: [recordingFactory('background', events)],
      shutdownIdentity: append(events, 'identity:shutdown'),
      closeProvider: append(events, 'provider:close'),
    })

    expect(session.state()).toEqual({ phase: 'frozen', activeHandleIds: [] })
    expect('db' in session.runtime).toBe(false)
    expect(events).toEqual(['admission:writer:close', 'admission:ws:close'])

    events.length = 0
    await session.resume(lifecycle)
    await session.resume(lifecycle)
    expect(session.state()).toEqual({
      phase: 'running',
      activeHandleIds: ['runtime', 'background'],
    })
    expect(events).toEqual([
      'start:runtime-1',
      'start:background-1',
      'admission:ws:open',
      'admission:writer:open',
    ])

    events.length = 0
    await session.pause(lifecycle)
    await session.pause(lifecycle)
    expect(session.state()).toEqual({ phase: 'frozen', activeHandleIds: [] })
    expect(events).toEqual([
      'admission:writer:close',
      'admission:ws:close',
      'stop:background-1',
      'stop:runtime-1',
      'drain:background-1',
      'drain:runtime-1',
    ])

    events.length = 0
    await session.resume(lifecycle)
    expect(events.slice(0, 2)).toEqual(['start:runtime-2', 'start:background-2'])
  })

  test('rolls back a partial resume in reverse order and remains retryable while frozen', async () => {
    const events: string[] = []
    let failSecondFactory = true
    const second: DaemonProviderRuntimeHandleFactory = {
      id: 'background',
      start() {
        events.push('start:background')
        if (failSecondFactory) {
          failSecondFactory = false
          throw new Error('background-start-failed')
        }
        return {
          stop: append(events, 'stop:background'),
          drain: append(events, 'drain:background'),
        }
      },
    }
    const session = await createDaemonProviderRuntimeSession({
      provider: 'sqlite',
      generationId: 'sqlite-1',
      runtime: runtimePayload(),
      admission: admission(events),
      runtimeFactories: [recordingFactory('runtime', events)],
      backgroundWriterFactories: [second],
      shutdownIdentity: () => undefined,
      closeProvider: () => undefined,
    })
    events.length = 0

    await expect(session.resume(lifecycle)).rejects.toThrow('background-start-failed')
    expect(session.state()).toEqual({ phase: 'frozen', activeHandleIds: [] })
    expect(events).toEqual([
      'start:runtime-1',
      'start:background',
      'stop:runtime-1',
      'drain:runtime-1',
    ])

    events.length = 0
    await session.resume(lifecycle)
    expect(session.state()).toEqual({
      phase: 'running',
      activeHandleIds: ['runtime', 'background'],
    })
    expect(events).toEqual([
      'start:runtime-2',
      'start:background',
      'admission:ws:open',
      'admission:writer:open',
    ])
  })

  test('retries close from the first incomplete stage without repeating completed stages', async () => {
    const events: string[] = []
    let closeParticipantFailures = 1
    let providerCloseFailures = 1
    const closeParticipants: DaemonProviderCloseParticipant[] = [
      {
        id: 'runtime-close',
        close() {
          events.push('close:runtime')
        },
      },
      {
        id: 'persistence-close',
        close() {
          events.push('close:persistence')
          if (closeParticipantFailures > 0) {
            closeParticipantFailures -= 1
            throw new Error('persistence-close-failed')
          }
        },
      },
    ]
    const session = await createDaemonProviderRuntimeSession({
      provider: 'sqlite',
      generationId: 'sqlite-1',
      runtime: runtimePayload(),
      admission: admission(events),
      runtimeFactories: [recordingFactory('runtime', events)],
      providerCloseParticipants: closeParticipants,
      shutdownIdentity: append(events, 'identity:shutdown'),
      closeProvider() {
        events.push('provider:close')
        if (providerCloseFailures > 0) {
          providerCloseFailures -= 1
          throw new Error('provider-close-failed')
        }
      },
    })
    await session.resume(lifecycle)
    events.length = 0

    await expect(session.close({ reason: 'provider-switch' })).rejects.toThrow(
      'persistence-close-failed',
    )
    expect(session.state().phase).toBe('closing')
    expect(events).toEqual([
      'admission:writer:close',
      'admission:ws:close',
      'stop:runtime-1',
      'drain:runtime-1',
      'close:runtime',
      'close:persistence',
    ])

    events.length = 0
    await expect(session.close({ reason: 'daemon-shutdown' })).rejects.toThrow(
      'provider-close-failed',
    )
    expect(events).toEqual(['close:persistence', 'identity:shutdown', 'provider:close'])

    events.length = 0
    await session.close({ reason: 'daemon-shutdown' })
    await session.close({ reason: 'daemon-shutdown' })
    expect(session.state()).toEqual({ phase: 'closed', activeHandleIds: [] })
    expect(events).toEqual(['provider:close'])
    await expect(session.resume(lifecycle)).rejects.toMatchObject({
      code: 'daemon-provider-runtime-session-closing',
    })
  })

  test('serializes concurrent resume and shutdown without double-starting or double-stopping', async () => {
    const events: string[] = []
    let releaseStart: (() => void) | undefined
    let announceStart: (() => void) | undefined
    const startAnnounced = new Promise<void>((resolve) => {
      announceStart = resolve
    })
    const startReleased = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const factory: DaemonProviderRuntimeHandleFactory = {
      id: 'runtime',
      async start() {
        events.push('start:begin')
        announceStart?.()
        await startReleased
        events.push('start:end')
        return {
          stop: append(events, 'stop:runtime'),
          drain: append(events, 'drain:runtime'),
        }
      },
    }
    const session = await createDaemonProviderRuntimeSession({
      provider: 'sqlite',
      generationId: 'sqlite-1',
      runtime: runtimePayload(),
      admission: admission(events),
      runtimeFactories: [factory],
      shutdownIdentity: append(events, 'identity:shutdown'),
      closeProvider: append(events, 'provider:close'),
    })
    events.length = 0

    const firstResume = session.resume(lifecycle)
    await startAnnounced
    const duplicateResume = session.resume(lifecycle)
    const shutdown = session.close({ reason: 'daemon-shutdown' })
    releaseStart?.()
    await Promise.all([firstResume, duplicateResume, shutdown])

    expect(events).toEqual([
      'start:begin',
      'start:end',
      'admission:ws:open',
      'admission:writer:open',
      'admission:writer:close',
      'admission:ws:close',
      'stop:runtime',
      'drain:runtime',
      'identity:shutdown',
      'provider:close',
    ])
  })

  test('rejects lifecycle calls for a different provider generation', async () => {
    const session = await createDaemonProviderRuntimeSession({
      provider: 'sqlite',
      generationId: 'sqlite-1',
      runtime: runtimePayload(),
      admission: admission([]),
      shutdownIdentity: () => undefined,
      closeProvider: () => undefined,
    })

    await expect(
      session.resume({ ...lifecycle, provider: 'postgresql', generationId: 'pg-1' }),
    ).rejects.toMatchObject({
      code: 'daemon-provider-runtime-session-mismatch',
    })
  })
})
