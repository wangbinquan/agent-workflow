import { describe, expect, test } from 'bun:test'

import { createDaemonProviderMigrationAdmission } from '../src/cli/daemonProviderMigrationAdmission'
import {
  createDaemonProviderSessionController,
  type DaemonProviderSessionLifecycleInput,
  type ManagedDaemonProviderSession,
} from '../src/cli/daemonProviderSession'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type TestSession = ManagedDaemonProviderSession

function session(
  provider: 'sqlite' | 'postgresql',
  generationId: string,
  events: string[],
  input: {
    readonly failCloseOnce?: boolean
    readonly onPause?: () => void
    readonly onClose?: () => void
  } = {},
): TestSession {
  let closeFailures = input.failCloseOnce === true ? 1 : 0
  return Object.freeze({
    provider,
    generationId,
    async pause(lifecycleInput: DaemonProviderSessionLifecycleInput) {
      events.push(`pause:${provider}:${lifecycleInput.operationId}`)
      input.onPause?.()
    },
    async resume(lifecycleInput: DaemonProviderSessionLifecycleInput) {
      events.push(`resume:${provider}:${lifecycleInput.operationId}`)
    },
    async close({ reason }: { readonly reason: 'provider-switch' | 'daemon-shutdown' }) {
      events.push(`close:${provider}:${reason}`)
      input.onClose?.()
      if (closeFailures > 0) {
        closeFailures -= 1
        throw new Error(`close-${provider}-failed`)
      }
    },
  })
}

describe('RFC-349 daemon provider migration admission bridge', () => {
  test('uses the controller current provider instead of a bootstrap default', async () => {
    const events: string[] = []
    const postgresql = session('postgresql', 'pg-live', events)
    const controller = createDaemonProviderSessionController({
      initial: postgresql,
      factory: { create: async () => postgresql },
    })
    const bridge = createDaemonProviderMigrationAdmission({ controller })

    expect(bridge.live()).toMatchObject({
      phase: 'open',
      provider: 'postgresql',
      generationId: 'pg-live',
    })
    await bridge.stop()
  })

  test('derives its initial generation from current and delegates freeze, switch, then open', async () => {
    const events: string[] = []
    const sqlite = session('sqlite', 'sqlite-1', events)
    const postgresql = session('postgresql', 'pg-1', events)
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: {
        async create(input) {
          events.push(`compose:${input.provider}:${input.generationId}`)
          return postgresql
        },
      },
    })
    const bridge = createDaemonProviderMigrationAdmission({ controller })

    expect(bridge.live()).toMatchObject({
      phase: 'open',
      provider: 'sqlite',
      generationId: 'sqlite-1',
    })
    await bridge.migration.freezeAndDrain({
      operationId: 'op-1',
      sourceGenerationId: 'sqlite-1',
      timeoutMs: 1_000,
    })
    await bridge.migration.activatePostgresql({
      operationId: 'op-1',
      generationId: 'pg-1',
    })
    expect(controller.current()).toBe(postgresql)
    expect(bridge.live()).toMatchObject({ phase: 'switching', provider: 'postgresql' })

    await bridge.migration.openPostgresqlAdmission({
      operationId: 'op-1',
      generationId: 'pg-1',
    })

    expect(bridge.live()).toMatchObject({
      phase: 'open',
      provider: 'postgresql',
      generationId: 'pg-1',
    })
    expect(events).toEqual([
      'pause:sqlite:op-1',
      'compose:postgresql:pg-1',
      'resume:postgresql:op-1',
      'close:sqlite:provider-switch',
    ])
  })

  test('rolls a frozen cutover back to the exact SQLite session', async () => {
    const events: string[] = []
    const sqlite = session('sqlite', 'sqlite-1', events)
    const postgresql = session('postgresql', 'pg-1', events)
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: {
        async create(input) {
          events.push(`compose:${input.provider}:${input.generationId}`)
          return postgresql
        },
      },
    })
    const bridge = createDaemonProviderMigrationAdmission({ controller })

    await bridge.migration.freezeAndDrain({
      operationId: 'op-1',
      sourceGenerationId: 'sqlite-1',
      timeoutMs: 1_000,
    })
    await bridge.migration.activatePostgresql({
      operationId: 'op-1',
      generationId: 'pg-1',
    })
    await bridge.migration.reopenSqlite({
      operationId: 'op-1',
      sourceGenerationId: 'sqlite-1',
    })

    expect(controller.current()).toBe(sqlite)
    expect(bridge.live()).toMatchObject({
      phase: 'open',
      provider: 'sqlite',
      generationId: 'sqlite-1',
    })
    expect(events).toEqual([
      'pause:sqlite:op-1',
      'compose:postgresql:pg-1',
      'close:postgresql:provider-switch',
      'resume:sqlite:op-1',
    ])
  })

  test('drains admitted business work and returns 503 to new work while frozen', async () => {
    const events: string[] = []
    const pauseObserved = deferred<void>()
    const active = deferred<Response>()
    const sqlite = session('sqlite', 'sqlite-1', events, {
      onPause: () => pauseObserved.resolve(),
    })
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: { create: async (input) => session(input.provider, input.generationId, events) },
    })
    const bridge = createDaemonProviderMigrationAdmission({ controller })
    const activeRequest = bridge.runBusinessRequest(
      new Request('http://localhost/api/tasks'),
      async () => await active.promise,
    )

    const freezing = bridge.migration.freezeAndDrain({
      operationId: 'op-1',
      sourceGenerationId: 'sqlite-1',
      timeoutMs: 1_000,
    })
    await pauseObserved.promise
    expect(bridge.live()).toMatchObject({ phase: 'draining', activeBusinessRequests: 1 })

    const rejected = await bridge.runBusinessRequest(
      new Request('http://localhost/api/tasks/new', { method: 'POST' }),
      async () => new Response('unexpected'),
    )
    expect(rejected.status).toBe(503)
    expect(await rejected.text()).toContain('"code":"database-maintenance"')
    expect(
      await bridge
        .runBusinessRequest(new Request('http://localhost/api/database/status'), async () => {
          return new Response('migration-control')
        })
        .then((response) => response.text()),
    ).toBe('migration-control')

    active.resolve(new Response('complete'))
    expect((await activeRequest).status).toBe(200)
    await freezing
    expect(bridge.live()).toMatchObject({ phase: 'frozen', activeBusinessRequests: 0 })

    await bridge.migration.reopenSqlite({
      operationId: 'op-1',
      sourceGenerationId: 'sqlite-1',
    })
    expect(bridge.live().phase).toBe('open')
  })

  test('stops admission before controller close and retries a retained close failure', async () => {
    const events: string[] = []
    const sqlite = session('sqlite', 'sqlite-1', events, {
      failCloseOnce: true,
      onClose: () => {
        events.push(`close-observed-admission:${bridge.live().phase}`)
      },
    })
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: { create: async () => session('postgresql', 'pg-1', events) },
    })
    const bridge = createDaemonProviderMigrationAdmission({ controller })

    await expect(bridge.stop()).rejects.toThrow('failed to close daemon provider sessions')
    expect(bridge.live().phase).toBe('stopped')
    await bridge.stop()
    await bridge.stop()

    expect(events).toEqual([
      'close:sqlite:daemon-shutdown',
      'close-observed-admission:stopped',
      'close:sqlite:daemon-shutdown',
      'close-observed-admission:stopped',
    ])
    await expect(
      bridge.migration.freezeAndDrain({
        operationId: 'op-after-stop',
        sourceGenerationId: 'sqlite-1',
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'database-admission-stopped' })
  })

  test('serializes overlapping shutdown retries without double-closing a live session', async () => {
    const events: string[] = []
    const closeStarted = deferred<void>()
    const releaseClose = deferred<void>()
    let closeCalls = 0
    const sqlite: TestSession = Object.freeze({
      provider: 'sqlite',
      generationId: 'sqlite-1',
      async pause() {},
      async resume() {},
      async close() {
        closeCalls += 1
        events.push(`close:${closeCalls}`)
        closeStarted.resolve()
        await releaseClose.promise
      },
    })
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: { create: async () => sqlite },
    })
    const bridge = createDaemonProviderMigrationAdmission({ controller })

    const first = bridge.stop()
    await closeStarted.promise
    const second = bridge.stop()
    expect(closeCalls).toBe(1)
    releaseClose.resolve()
    await Promise.all([first, second])

    expect(events).toEqual(['close:1'])
  })
})
