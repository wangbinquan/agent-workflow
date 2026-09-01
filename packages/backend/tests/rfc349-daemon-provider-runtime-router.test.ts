import { describe, expect, test } from 'bun:test'

import {
  createDaemonProviderRuntimeRouter,
  type DaemonProviderListenerRuntimeSession,
  type DaemonProviderRuntimeWebSocketHandlers,
  type DaemonProviderUpgradeServer,
  type DaemonProviderWebSocketMessage,
} from '../src/cli/daemonProviderRuntimeRouter'
import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderRuntimeAdmission,
} from '../src/cli/daemonProviderRuntimeSession'
import { createDaemonProviderSessionController } from '../src/cli/daemonProviderSession'

interface TestWebSocket {
  readonly id: string
}

type TestSession = DaemonProviderListenerRuntimeSession<TestWebSocket>

const noOpAdmission: DaemonProviderRuntimeAdmission = Object.freeze({
  closeWriterAdmission() {},
  openWriterAdmission() {},
  closeWebSocketAdmission() {},
  openWebSocketAdmission() {},
})

function requestPath(request: Request): string {
  return new URL(request.url).pathname
}

async function testSession(
  provider: 'sqlite' | 'postgresql',
  generationId: string,
  events: string[],
): Promise<TestSession> {
  const websocketHandlers: DaemonProviderRuntimeWebSocketHandlers<TestWebSocket> = Object.freeze({
    open(webSocket: TestWebSocket) {
      events.push(`${provider}:open:${webSocket.id}`)
    },
    message(webSocket: TestWebSocket, message: DaemonProviderWebSocketMessage) {
      events.push(`${provider}:message:${webSocket.id}:${message.toString()}`)
    },
    close(webSocket: TestWebSocket) {
      events.push(`${provider}:close:${webSocket.id}`)
    },
  })
  const runtime = {
    client: Object.freeze({ provider, generationId }),
    fetch(request: Request) {
      events.push(`${provider}:fetch:${requestPath(request)}`)
      return new Response(`${provider}:fetch`)
    },
    tryUpgrade(request: Request, _server: DaemonProviderUpgradeServer) {
      events.push(`${provider}:upgrade:${requestPath(request)}`)
      return new Response(`${provider}:upgrade`)
    },
    websocketHandlers,
  }

  return await createDaemonProviderRuntimeSession({
    provider,
    generationId,
    runtime,
    admission: noOpAdmission,
    shutdownIdentity() {},
    closeProvider() {},
  })
}

async function responseText(result: true | false | Response): Promise<string> {
  if (!(result instanceof Response)) throw new Error('expected an upgrade response')
  return await result.text()
}

describe('RFC-349 daemon provider runtime router', () => {
  test('stable HTTP, upgrade and WebSocket delegates resolve the current session per call', async () => {
    const sqliteEvents: string[] = []
    const postgresqlEvents: string[] = []
    const sqlite = await testSession('sqlite', 'sqlite-1', sqliteEvents)
    const postgresql = await testSession('postgresql', 'pg-1', postgresqlEvents)
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: { create: async () => postgresql },
    })
    const router = createDaemonProviderRuntimeRouter<TestWebSocket>(controller)
    const stableFetch = router.fetch
    const stableTryUpgrade = router.tryUpgrade
    const stableWebSocketHandlers = router.websocketHandlers
    const upgradeServer: DaemonProviderUpgradeServer = {
      upgrade() {
        return true
      },
    }
    const beforeSocket: TestWebSocket = { id: 'before' }

    expect(await (await stableFetch(new Request('http://localhost/before'))).text()).toBe(
      'sqlite:fetch',
    )
    expect(
      await responseText(
        await stableTryUpgrade(new Request('http://localhost/ws/before'), upgradeServer),
      ),
    ).toBe('sqlite:upgrade')
    await stableWebSocketHandlers.open(beforeSocket)
    stableWebSocketHandlers.message(beforeSocket, 'before-message')
    stableWebSocketHandlers.close(beforeSocket)

    await controller.pauseBackgroundWriters({
      operationId: 'op-1',
      provider: 'sqlite',
      generationId: 'sqlite-1',
    })
    await controller.switchProviderComposition({
      operationId: 'op-1',
      provider: 'postgresql',
      generationId: 'pg-1',
    })
    const sqliteEventsAfterSwitch = [...sqliteEvents]
    const afterSocket: TestWebSocket = { id: 'after' }

    expect(router.fetch).toBe(stableFetch)
    expect(router.tryUpgrade).toBe(stableTryUpgrade)
    expect(router.websocketHandlers).toBe(stableWebSocketHandlers)
    expect(await (await stableFetch(new Request('http://localhost/after'))).text()).toBe(
      'postgresql:fetch',
    )
    expect(
      await responseText(
        await stableTryUpgrade(new Request('http://localhost/ws/after'), upgradeServer),
      ),
    ).toBe('postgresql:upgrade')
    await stableWebSocketHandlers.open(afterSocket)
    stableWebSocketHandlers.message(afterSocket, Buffer.from('after-message'))
    stableWebSocketHandlers.close(afterSocket)

    expect(sqliteEvents).toEqual(sqliteEventsAfterSwitch)
    expect(sqliteEvents).toEqual([
      'sqlite:fetch:/before',
      'sqlite:upgrade:/ws/before',
      'sqlite:open:before',
      'sqlite:message:before:before-message',
      'sqlite:close:before',
    ])
    expect(postgresqlEvents).toEqual([
      'postgresql:fetch:/after',
      'postgresql:upgrade:/ws/after',
      'postgresql:open:after',
      'postgresql:message:after:after-message',
      'postgresql:close:after',
    ])

    await controller.resumeBackgroundWriters({
      operationId: 'op-1',
      provider: 'postgresql',
      generationId: 'pg-1',
    })
    await controller.stop()
  })

  test('frozen sessions and the listener router expose delegates without provider clients', async () => {
    const sqlite = await testSession('sqlite', 'sqlite-frozen', [])
    const controller = createDaemonProviderSessionController({
      initial: sqlite,
      factory: { create: async () => sqlite },
    })
    const router = createDaemonProviderRuntimeRouter<TestWebSocket>(controller)

    expect(sqlite.state()).toEqual({ phase: 'frozen', activeHandleIds: [] })
    expect(Object.isFrozen(sqlite.runtime)).toBe(true)
    expect(Object.hasOwn(sqlite.runtime, 'client')).toBe(false)
    expect(Object.keys(sqlite.runtime).sort()).toEqual(['fetch', 'tryUpgrade', 'websocketHandlers'])
    expect(Object.isFrozen(router)).toBe(true)
    expect(Object.isFrozen(router.websocketHandlers)).toBe(true)
    expect(Object.hasOwn(router, 'client')).toBe(false)
    expect(Object.keys(router).sort()).toEqual(['fetch', 'tryUpgrade', 'websocketHandlers'])

    await controller.stop()
  })
})
