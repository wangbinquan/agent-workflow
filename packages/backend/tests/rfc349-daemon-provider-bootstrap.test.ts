import { describe, expect, test } from 'bun:test'

import { createDaemonProviderBootstrap } from '../src/cli/daemonProviderBootstrap'
import {
  type DaemonProviderListenerRuntimeSession,
  type DaemonProviderRuntimeWebSocketHandlers,
  type DaemonProviderUpgradeServer,
  type DaemonProviderWebSocketMessage,
} from '../src/cli/daemonProviderRuntimeRouter'
import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderRuntimeAdmission,
} from '../src/cli/daemonProviderRuntimeSession'

interface TestWebSocket {
  readonly id: string
}

type TestSession = DaemonProviderListenerRuntimeSession<TestWebSocket>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function requestPath(request: Request): string {
  return new URL(request.url).pathname
}

async function session(input: {
  readonly provider: 'sqlite' | 'postgresql'
  readonly generationId: string
  readonly runtimeId: string
  readonly runtimeEvents: string[]
  readonly lifecycleEvents: string[]
  readonly closeProvider?: () => void | Promise<void>
}): Promise<TestSession> {
  const handlers: DaemonProviderRuntimeWebSocketHandlers<TestWebSocket> = Object.freeze({
    open(webSocket: TestWebSocket) {
      input.runtimeEvents.push(`${input.runtimeId}:open:${webSocket.id}`)
    },
    message(webSocket: TestWebSocket, message: DaemonProviderWebSocketMessage) {
      input.runtimeEvents.push(`${input.runtimeId}:message:${webSocket.id}:${message.toString()}`)
    },
    close(webSocket: TestWebSocket) {
      input.runtimeEvents.push(`${input.runtimeId}:close:${webSocket.id}`)
    },
  })
  const admission: DaemonProviderRuntimeAdmission = Object.freeze({
    closeWriterAdmission() {
      input.lifecycleEvents.push(`${input.runtimeId}:writer:close`)
    },
    openWriterAdmission() {
      input.lifecycleEvents.push(`${input.runtimeId}:writer:open`)
    },
    closeWebSocketAdmission() {
      input.lifecycleEvents.push(`${input.runtimeId}:ws:close`)
    },
    openWebSocketAdmission() {
      input.lifecycleEvents.push(`${input.runtimeId}:ws:open`)
    },
  })
  const runtime = {
    client: Object.freeze({ provider: input.provider, generationId: input.generationId }),
    fetch(request: Request) {
      input.runtimeEvents.push(`${input.runtimeId}:fetch:${requestPath(request)}`)
      return new Response(`${input.runtimeId}:fetch`)
    },
    tryUpgrade(request: Request, _server: DaemonProviderUpgradeServer) {
      input.runtimeEvents.push(`${input.runtimeId}:upgrade:${requestPath(request)}`)
      return new Response(`${input.runtimeId}:upgrade`)
    },
    websocketHandlers: handlers,
  }

  return await createDaemonProviderRuntimeSession({
    provider: input.provider,
    generationId: input.generationId,
    runtime,
    admission,
    shutdownIdentity() {
      input.lifecycleEvents.push(`${input.runtimeId}:identity:shutdown`)
    },
    async closeProvider() {
      input.lifecycleEvents.push(`${input.runtimeId}:provider:close`)
      if (input.closeProvider !== undefined) await input.closeProvider()
    },
  })
}

function upgradeServer(): DaemonProviderUpgradeServer {
  return {
    upgrade() {
      return true
    },
  }
}

async function responseText(result: true | false | Response): Promise<string> {
  if (!(result instanceof Response)) throw new Error('expected an upgrade response')
  return await result.text()
}

describe('RFC-349 root-owned daemon provider bootstrap', () => {
  test('keeps listener delegates stable while migration switches every request path', async () => {
    const sqliteRuntime: string[] = []
    const postgresqlRuntime: string[] = []
    const lifecycleEvents: string[] = []
    const sqlite = await session({
      provider: 'sqlite',
      generationId: 'sqlite-1',
      runtimeId: 'sqlite-source',
      runtimeEvents: sqliteRuntime,
      lifecycleEvents,
    })
    const postgresql = await session({
      provider: 'postgresql',
      generationId: 'pg-1',
      runtimeId: 'postgresql-target',
      runtimeEvents: postgresqlRuntime,
      lifecycleEvents,
    })
    const bootstrap = createDaemonProviderBootstrap<TestWebSocket>({
      initialSession: sqlite,
      sessionFactory: { create: async () => postgresql },
    })
    const stableFetch = bootstrap.fetch
    const stableTryUpgrade = bootstrap.tryUpgrade
    const stableHandlers = bootstrap.websocketHandlers
    const server = upgradeServer()
    const before: TestWebSocket = { id: 'before' }

    expect(await (await stableFetch(new Request('http://localhost/before'))).text()).toBe(
      'sqlite-source:fetch',
    )
    expect(
      await responseText(await stableTryUpgrade(new Request('http://localhost/ws/before'), server)),
    ).toBe('sqlite-source:upgrade')
    await stableHandlers.open(before)
    stableHandlers.message(before, 'before-message')
    stableHandlers.close(before)

    await bootstrap.databaseMigration.freezeAndDrain({
      operationId: 'op-switch',
      sourceGenerationId: 'sqlite-1',
      timeoutMs: 1_000,
    })
    await bootstrap.databaseMigration.activatePostgresql({
      operationId: 'op-switch',
      generationId: 'pg-1',
    })
    await bootstrap.databaseMigration.openPostgresqlAdmission({
      operationId: 'op-switch',
      generationId: 'pg-1',
    })
    const sqliteAfterSwitch = [...sqliteRuntime]
    const after: TestWebSocket = { id: 'after' }

    expect(bootstrap.fetch).toBe(stableFetch)
    expect(bootstrap.tryUpgrade).toBe(stableTryUpgrade)
    expect(bootstrap.websocketHandlers).toBe(stableHandlers)
    expect(await (await stableFetch(new Request('http://localhost/after'))).text()).toBe(
      'postgresql-target:fetch',
    )
    expect(
      await responseText(await stableTryUpgrade(new Request('http://localhost/ws/after'), server)),
    ).toBe('postgresql-target:upgrade')
    await stableHandlers.open(after)
    stableHandlers.message(after, Buffer.from('after-message'))
    stableHandlers.close(after)

    expect(sqliteRuntime).toEqual(sqliteAfterSwitch)
    expect(postgresqlRuntime).toEqual([
      'postgresql-target:fetch:/after',
      'postgresql-target:upgrade:/ws/after',
      'postgresql-target:open:after',
      'postgresql-target:message:after:after-message',
      'postgresql-target:close:after',
    ])
    expect(Object.keys(bootstrap).sort()).toEqual([
      'databaseMigration',
      'fetch',
      'live',
      'runBusinessRequest',
      'stop',
      'tryUpgrade',
      'websocketHandlers',
    ])
    expect(Object.hasOwn(bootstrap, 'client')).toBe(false)
    expect(Object.hasOwn(bootstrap, 'controller')).toBe(false)

    await bootstrap.stop()
  })

  test('fences and drains business requests while admitting migration control and health', async () => {
    const runtimeEvents: string[] = []
    const lifecycleEvents: string[] = []
    const sqlite = await session({
      provider: 'sqlite',
      generationId: 'sqlite-drain',
      runtimeId: 'sqlite-drain',
      runtimeEvents,
      lifecycleEvents,
    })
    const bootstrap = createDaemonProviderBootstrap<TestWebSocket>({
      initialSession: sqlite,
      sessionFactory: { create: async () => sqlite },
    })
    const active = deferred<Response>()
    const activeRequest = bootstrap.runBusinessRequest(
      new Request('http://localhost/api/tasks'),
      async () => await active.promise,
    )
    const freezing = bootstrap.databaseMigration.freezeAndDrain({
      operationId: 'op-drain',
      sourceGenerationId: 'sqlite-drain',
      timeoutMs: 1_000,
    })

    expect(bootstrap.live()).toMatchObject({
      phase: 'draining',
      provider: 'sqlite',
      activeBusinessRequests: 1,
    })
    const rejected = await bootstrap.runBusinessRequest(
      new Request('http://localhost/api/tasks/new', { method: 'POST' }),
      async () => new Response('unexpected'),
    )
    expect(rejected.status).toBe(503)
    expect(await rejected.text()).toContain('"code":"database-maintenance"')
    for (const path of ['/api/database/status', '/api/health']) {
      expect(
        await bootstrap
          .runBusinessRequest(new Request(`http://localhost${path}`), async () => {
            return await bootstrap.fetch(new Request(`http://localhost${path}`))
          })
          .then((response) => response.text()),
      ).toBe('sqlite-drain:fetch')
    }

    active.resolve(new Response('complete'))
    expect((await activeRequest).status).toBe(200)
    await freezing
    expect(bootstrap.live()).toMatchObject({ phase: 'frozen', activeBusinessRequests: 0 })
    await bootstrap.databaseMigration.reopenSqlite({
      operationId: 'op-drain',
      sourceGenerationId: 'sqlite-drain',
    })
    expect(bootstrap.live().phase).toBe('open')

    await bootstrap.stop()
  })

  test('rolls back to the exact frozen source session without composing another SQLite', async () => {
    const sqliteRuntime: string[] = []
    const postgresqlRuntime: string[] = []
    const lifecycleEvents: string[] = []
    const factoryCalls: string[] = []
    const sqlite = await session({
      provider: 'sqlite',
      generationId: 'sqlite-source-generation',
      runtimeId: 'sqlite-exact-source',
      runtimeEvents: sqliteRuntime,
      lifecycleEvents,
    })
    const postgresql = await session({
      provider: 'postgresql',
      generationId: 'pg-candidate-generation',
      runtimeId: 'postgresql-candidate',
      runtimeEvents: postgresqlRuntime,
      lifecycleEvents,
    })
    const bootstrap = createDaemonProviderBootstrap<TestWebSocket>({
      initialSession: sqlite,
      sessionFactory: {
        async create(input) {
          factoryCalls.push(`${input.provider}:${input.generationId}`)
          return postgresql
        },
      },
    })

    await bootstrap.databaseMigration.freezeAndDrain({
      operationId: 'op-rollback',
      sourceGenerationId: 'sqlite-source-generation',
      timeoutMs: 1_000,
    })
    await bootstrap.databaseMigration.activatePostgresql({
      operationId: 'op-rollback',
      generationId: 'pg-candidate-generation',
    })
    await bootstrap.databaseMigration.reopenSqlite({
      operationId: 'op-rollback',
      sourceGenerationId: 'sqlite-source-generation',
    })

    expect(await (await bootstrap.fetch(new Request('http://localhost/rolled-back'))).text()).toBe(
      'sqlite-exact-source:fetch',
    )
    expect(factoryCalls).toEqual(['postgresql:pg-candidate-generation'])
    expect(postgresqlRuntime).toEqual([])
    expect(lifecycleEvents).toContain('postgresql-candidate:provider:close')
    expect(bootstrap.live()).toMatchObject({
      phase: 'open',
      provider: 'sqlite',
      generationId: 'sqlite-source-generation',
    })

    await bootstrap.stop()
  })

  test('stops admission before provider close and retains a failed close for retry', async () => {
    const runtimeEvents: string[] = []
    const lifecycleEvents: string[] = []
    let closeFailures = 1
    const sqlite = await session({
      provider: 'sqlite',
      generationId: 'sqlite-stop',
      runtimeId: 'sqlite-stop',
      runtimeEvents,
      lifecycleEvents,
      closeProvider() {
        lifecycleEvents.push(`close-observed-admission:${bootstrap.live().phase}`)
        if (closeFailures > 0) {
          closeFailures -= 1
          throw new Error('provider-close-failed')
        }
      },
    })
    const bootstrap = createDaemonProviderBootstrap<TestWebSocket>({
      initialSession: sqlite,
      sessionFactory: { create: async () => sqlite },
    })

    await expect(bootstrap.stop()).rejects.toThrow('failed to close daemon provider sessions')
    expect(bootstrap.live().phase).toBe('stopped')
    const rejected = await bootstrap.runBusinessRequest(
      new Request('http://localhost/api/tasks'),
      async () => new Response('unexpected'),
    )
    expect(rejected.status).toBe(503)
    await bootstrap.stop()
    await bootstrap.stop()

    expect(lifecycleEvents.filter((event) => event === 'sqlite-stop:provider:close')).toHaveLength(
      2,
    )
    expect(
      lifecycleEvents.filter((event) => event === 'close-observed-admission:stopped'),
    ).toHaveLength(2)
  })
})
