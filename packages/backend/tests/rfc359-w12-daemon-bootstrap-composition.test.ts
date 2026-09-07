import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  composeDaemonProviderBootstrap,
  type ComposeDaemonProviderBootstrapInput,
  type DaemonProviderBootstrapBindings,
} from '../src/cli/daemonProviderBootstrap'
import {
  createDaemonProviderMigrationAdmission,
  type DaemonProviderMigrationLifecycle,
} from '../src/cli/daemonProviderMigrationAdmission'
import type { DaemonProviderListenerRuntimeSession } from '../src/cli/daemonProviderRuntimeRouter'
import type { DaemonProviderRuntimeSessionPhase } from '../src/cli/daemonProviderRuntimeSession'
import type {
  DaemonProviderSessionLifecycleInput,
  ManagedDaemonProviderSession,
} from '../src/cli/daemonProviderSession'
import { createDatabaseMigrationDaemonAdmission } from '../src/modules/system-operations/composition'

type TestSession = DaemonProviderListenerRuntimeSession

function session(
  provider: ManagedDaemonProviderSession['provider'],
  generationId: string,
  events: string[],
  close?: () => void | Promise<void>,
): TestSession {
  let phase: DaemonProviderRuntimeSessionPhase = 'frozen'
  const result = Object.freeze<TestSession>({
    provider,
    generationId,
    state: () => ({ phase, activeHandleIds: [] }),
    runtime: Object.freeze({
      fetch: async () => new Response(`${provider}:${generationId}`),
      tryUpgrade: async () => false as const,
      websocketHandlers: Object.freeze({ open() {}, message() {}, close() {} }),
    }),
    async pause(input: DaemonProviderSessionLifecycleInput) {
      expect(this).toBe(result)
      events.push(`pause:${provider}:${input.operationId}`)
      phase = 'frozen'
    },
    async resume(input: DaemonProviderSessionLifecycleInput) {
      expect(this).toBe(result)
      events.push(`resume:${provider}:${input.operationId}`)
      phase = 'running'
    },
    async close(input: { readonly reason: 'provider-switch' | 'daemon-shutdown' }) {
      expect(this).toBe(result)
      events.push(`close:${provider}:${input.reason}`)
      phase = 'closing'
      await close?.()
      phase = 'closed'
    },
  })
  return result
}

describe('RFC-359 complete asynchronous daemon bootstrap', () => {
  test('production awaits complete initialization before resuming the initial session and serving', () => {
    const start = readFileSync(resolve(import.meta.dir, '..', 'src/cli/start.ts'), 'utf8')
    const composeAt = start.indexOf('await composeDaemonProviderBootstrap({')
    const resumeAt = start.indexOf('await initial.session.resume(lifecycle)', composeAt)
    const serveAt = start.indexOf('await serveDaemon({', resumeAt)
    expect(composeAt).toBeGreaterThan(-1)
    expect(resumeAt).toBeGreaterThan(composeAt)
    expect(serveAt).toBeGreaterThan(resumeAt)
    const initialization = start.slice(composeAt, resumeAt)
    expect(initialization).toContain('composeInitial: (bindings) =>')
    expect(initialization).toContain('async create(lifecycleInput, bindings)')
    expect(initialization.match(/\.\.\.bindings,/g)).toHaveLength(2)
    expect(initialization).toContain(
      'createMigrationAdmission: createDatabaseMigrationDaemonAdmission',
    )
    expect(start).not.toContain('DeferredDatabaseMigrationAdmission')
    expect(start).not.toContain('BoundDatabaseMigrationBootstrap')
    expect(start).not.toContain('deferredDatabaseMigrationAdmission')
  })

  for (const provider of ['sqlite', 'postgresql'] as const) {
    test(`${provider}: initial composition reads the real open window before any lifecycle starts`, async () => {
      const events: string[] = []
      const initialGeneration = { provider, generationId: `${provider}-initial` }
      const application = { marker: 'exact-initial-application' }
      const composed = await composeDaemonProviderBootstrap({
        initial: initialGeneration,
        async composeInitial(bindings) {
          expect(bindings.sourceWriteWindow.writable()).toBe(true)
          expect(Object.isFrozen(bindings)).toBe(true)
          expect(Object.isFrozen(bindings.migrationAdmission)).toBe(true)
          expect(Object.isFrozen(bindings.sourceWriteWindow)).toBe(true)
          await Promise.resolve()
          expect(bindings.sourceWriteWindow.writable()).toBe(true)
          expect(events).toEqual([])
          return {
            application,
            session: session(provider, initialGeneration.generationId, events),
            bindings,
          }
        },
        sessionFactory: {
          async create() {
            throw new Error('initial construction must not invoke the target factory')
          },
        },
      })

      expect(composed.initial.application).toBe(application)
      expect(composed.bootstrap.live()).toMatchObject({ phase: 'open', ...initialGeneration })
      expect(events).toEqual([])
      expect(Object.isFrozen(composed)).toBe(true)
      expect(Object.isFrozen(composed.bootstrap)).toBe(true)
      expect(Object.hasOwn(composed.bootstrap, 'controller')).toBe(false)
      expect(Object.hasOwn(composed.bootstrap, 'bind')).toBe(false)
      await composed.initial.session.resume({ operationId: 'daemon-start', ...initialGeneration })
      expect(events).toEqual([`resume:${provider}:daemon-start`])
      await composed.bootstrap.stop()
    })
  }

  test('awaiting a migration during initial composition rejects immediately and leaves the window open', async () => {
    const events: string[] = []
    const composed = await composeDaemonProviderBootstrap({
      initial: { provider: 'sqlite', generationId: 'source' },
      async composeInitial(bindings) {
        for (const operation of [
          () =>
            bindings.migrationAdmission.freezeAndDrain({
              operationId: 'too-early',
              sourceGenerationId: 'source',
              timeoutMs: 1_000,
            }),
          () =>
            bindings.migrationAdmission.reopenSqlite({
              operationId: 'too-early',
              sourceGenerationId: 'source',
            }),
          () =>
            bindings.migrationAdmission.activatePostgresql({
              operationId: 'too-early',
              generationId: 'target',
            }),
          () =>
            bindings.migrationAdmission.openPostgresqlAdmission({
              operationId: 'too-early',
              generationId: 'target',
            }),
        ]) {
          const attempted = operation()
          const writableDuringAttempt = bindings.sourceWriteWindow.writable()
          await expect(attempted).rejects.toThrow('daemon provider bootstrap is still composing')
          expect(writableDuringAttempt).toBe(true)
          expect(bindings.sourceWriteWindow.writable()).toBe(true)
          expect(events).toEqual([])
        }
        return { application: {}, session: session('sqlite', 'source', events) }
      },
      sessionFactory: { create: async () => session('postgresql', 'target', events) },
    })
    expect(composed.bootstrap.live()).toMatchObject({ phase: 'open', operationId: null })
    await composed.bootstrap.stop()
  })

  test('an admission factory cannot reach a controller temporal dead zone before initial composition', async () => {
    const events: string[] = []
    const attempted: Promise<void>[] = []
    let admissionConstructions = 0
    const composed = await composeDaemonProviderBootstrap({
      initial: { provider: 'sqlite', generationId: 'source' },
      createMigrationAdmission(input) {
        admissionConstructions += 1
        const lifecycle = {
          operationId: 'constructor',
          provider: 'sqlite' as const,
          generationId: 'source',
        }
        attempted.push(
          input.pauseBackgroundWriters(lifecycle),
          input.switchProviderComposition(lifecycle),
          input.resumeBackgroundWriters(lifecycle),
        )
        return createDatabaseMigrationDaemonAdmission(input)
      },
      async composeInitial(bindings) {
        for (const attempt of attempted) {
          await expect(attempt).rejects.toThrow('daemon provider bootstrap is still composing')
        }
        expect(bindings.sourceWriteWindow.writable()).toBe(true)
        expect(events).toEqual([])
        return { application: {}, session: session('sqlite', 'source', events) }
      },
      sessionFactory: { create: async () => session('postgresql', 'target', events) },
    })
    expect(admissionConstructions).toBe(1)
    await composed.bootstrap.stop()
  })

  test('initialization failure rejects with the original error and retained ports never wait for readiness', async () => {
    const failure = new Error('initial application failed')
    const captured: DaemonProviderBootstrapBindings[] = []
    await expect(
      composeDaemonProviderBootstrap({
        initial: { provider: 'sqlite', generationId: 'source' },
        async composeInitial(bindings) {
          captured.push(bindings)
          throw failure
        },
        sessionFactory: {
          async create() {
            throw new Error('failed initial composition must not construct a target')
          },
        },
      }),
    ).rejects.toBe(failure)
    const binding = captured[0]
    if (binding === undefined) throw new Error('initial binding was not supplied')
    await expect(
      binding.migrationAdmission.freezeAndDrain({
        operationId: 'after-failure',
        sourceGenerationId: 'source',
        timeoutMs: 1_000,
      }),
    ).rejects.toBe(failure)
  })

  test('a synchronous initial factory failure also leaves every captured lifecycle request rejected', async () => {
    const failure = new Error('synchronous initial application failed')
    const captured: DaemonProviderBootstrapBindings[] = []
    await expect(
      composeDaemonProviderBootstrap({
        initial: { provider: 'sqlite', generationId: 'source' },
        composeInitial(bindings) {
          captured.push(bindings)
          throw failure
        },
        sessionFactory: {
          async create() {
            throw new Error('unexpected target composition')
          },
        },
      }),
    ).rejects.toBe(failure)
    const binding = captured[0]
    if (binding === undefined) throw new Error('initial binding was not supplied')
    await expect(
      binding.migrationAdmission.reopenSqlite({
        operationId: 'after-failure',
        sourceGenerationId: 'source',
      }),
    ).rejects.toBe(failure)
  })

  test('a mismatching initial session is closed before the composition rejects', async () => {
    const events: string[] = []
    const wrongGeneration = session('postgresql', 'wrong-generation', events)
    await expect(
      composeDaemonProviderBootstrap({
        initial: { provider: 'sqlite', generationId: 'source' },
        composeInitial: async () => ({ application: {}, session: wrongGeneration }),
        sessionFactory: {
          async create() {
            throw new Error('mismatching initial composition must not construct a target')
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'daemon-provider-session-mismatch' })
    expect(events).toEqual(['close:postgresql:daemon-shutdown'])
    expect(wrongGeneration.state().phase).toBe('closed')
  })

  test('the same admission and exact source session survive a target rollback', async () => {
    const events: string[] = []
    const bindings: DaemonProviderBootstrapBindings[] = []
    const selected: TestSession[] = []
    const source = session('sqlite', 'source', events)
    const target = session('postgresql', 'target', events)
    const targetFactory: ComposeDaemonProviderBootstrapInput<object>['sessionFactory'] = {
      async create(input, binding) {
        expect(this).toBe(targetFactory)
        expect(input).toEqual({
          operationId: 'rollback',
          provider: 'postgresql',
          generationId: 'target',
        })
        bindings.push(binding)
        return target
      },
    }
    const composed = await composeDaemonProviderBootstrap({
      initial: { provider: 'sqlite', generationId: 'source' },
      async composeInitial(binding) {
        bindings.push(binding)
        return { application: {}, session: source }
      },
      sessionFactory: targetFactory,
      onCurrentSelected: (current) => selected.push(current),
    })
    const initialBinding = bindings[0]
    if (initialBinding === undefined) throw new Error('initial binding was not supplied')
    expect(composed.bootstrap.databaseMigration).toBe(initialBinding.migrationAdmission)
    await composed.bootstrap.databaseMigration.freezeAndDrain({
      operationId: 'rollback',
      sourceGenerationId: 'source',
      timeoutMs: 1_000,
    })
    expect(initialBinding.sourceWriteWindow.writable()).toBe(false)
    await composed.bootstrap.databaseMigration.activatePostgresql({
      operationId: 'rollback',
      generationId: 'target',
    })
    expect(bindings).toHaveLength(2)
    expect(bindings[1]).toBe(initialBinding)
    await composed.bootstrap.databaseMigration.reopenSqlite({
      operationId: 'rollback',
      sourceGenerationId: 'source',
    })
    expect(initialBinding.sourceWriteWindow.writable()).toBe(true)
    expect(composed.initial.session).toBe(source)
    expect(selected).toEqual([target, source])
    expect(events).toEqual([
      'pause:sqlite:rollback',
      'close:postgresql:provider-switch',
      'resume:sqlite:rollback',
    ])
    expect(
      await (await composed.bootstrap.fetch(new Request('http://localhost/after'))).text(),
    ).toBe('sqlite:source')
    await composed.bootstrap.stop()
  })

  test('successful activation and repeated shutdown keep one controller and retry the original target close', async () => {
    const events: string[] = []
    const bindings: DaemonProviderBootstrapBindings[] = []
    let closeFailures = 1
    const source = session('sqlite', 'source', events)
    const target = session('postgresql', 'target', events, () => {
      expect(composed.bootstrap.live().phase).toBe('stopped')
      if (closeFailures > 0) {
        closeFailures -= 1
        throw new Error('target close failed')
      }
    })
    const composed = await composeDaemonProviderBootstrap({
      initial: { provider: 'sqlite', generationId: 'source' },
      async composeInitial(binding) {
        bindings.push(binding)
        return { application: {}, session: source }
      },
      sessionFactory: { create: async () => target },
    })
    const fetch = composed.bootstrap.fetch
    await composed.bootstrap.databaseMigration.freezeAndDrain({
      operationId: 'activate',
      sourceGenerationId: 'source',
      timeoutMs: 1_000,
    })
    await composed.bootstrap.databaseMigration.activatePostgresql({
      operationId: 'activate',
      generationId: 'target',
    })
    await composed.bootstrap.databaseMigration.openPostgresqlAdmission({
      operationId: 'activate',
      generationId: 'target',
    })
    expect(composed.bootstrap.fetch).toBe(fetch)
    expect(await (await fetch(new Request('http://localhost/after'))).text()).toBe(
      'postgresql:target',
    )
    expect(bindings[0]?.sourceWriteWindow.writable()).toBe(true)
    await expect(composed.bootstrap.stop()).rejects.toThrow(
      'failed to close daemon provider sessions',
    )
    await Promise.all([composed.bootstrap.stop(), composed.bootstrap.stop()])
    expect(bindings[0]?.sourceWriteWindow.writable()).toBe(false)
    expect(events).toEqual([
      'pause:sqlite:activate',
      'resume:postgresql:activate',
      'close:sqlite:provider-switch',
      'close:postgresql:daemon-shutdown',
      'close:postgresql:daemon-shutdown',
    ])
  })

  test('composition requires an initial composer and a complete lifecycle port at the type boundary', () => {
    const initial = { provider: 'sqlite' as const, generationId: 'source' }
    const sessionFactory = {
      async create(): Promise<TestSession> {
        throw new Error('type-only fixture')
      },
    }
    // @ts-expect-error Complete async construction cannot omit its initial application composer.
    const incomplete: ComposeDaemonProviderBootstrapInput<object> = { initial, sessionFactory }
    void incomplete
    const partialLifecycle = {
      async pauseBackgroundWriters() {},
      async switchProviderComposition() {},
      async resumeBackgroundWriters() {},
    }
    // @ts-expect-error Shutdown is part of the full controller lifecycle port.
    const missingStop: DaemonProviderMigrationLifecycle = partialLifecycle
    void missingStop
    const completeLifecycle: DaemonProviderMigrationLifecycle = {
      ...partialLifecycle,
      async stop() {},
    }
    const complete = createDaemonProviderMigrationAdmission({
      initial,
      controller: completeLifecycle,
    })
    expect(complete.live()).toMatchObject({ phase: 'open', ...initial })
    // @ts-expect-error A full lifecycle port has no current session; its generation is mandatory.
    const missingInitial: Parameters<typeof createDaemonProviderMigrationAdmission>[0] = {
      controller: completeLifecycle,
    }
    void missingInitial
  })
})
