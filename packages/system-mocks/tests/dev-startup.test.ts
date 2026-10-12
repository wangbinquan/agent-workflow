// Regression coverage for the 2026-10-12 slow bun dev startup: dependent
// services must follow actual backend readiness, and shutdown must collect them.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runDev, type DevService } from '../../../scripts/dev'
import { waitForDaemon, type DaemonInfo, type WaitForDaemonOptions } from '../src/dev-auth/daemon'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'aw-dev-startup-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

async function healthServer(handler: RequestListener): Promise<string> {
  const server: Server = createServer(handler)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('missing test server address')
  return `http://127.0.0.1:${address.port}`
}

function publish(homeDir: string, url: string, startedAt = new Date().toISOString()) {
  writeFileSync(join(homeDir, '.daemon.info'), JSON.stringify({ pid: process.pid, url, startedAt }))
}

const daemon: DaemonInfo = {
  pid: process.pid,
  host: '127.0.0.1',
  port: 7456,
  baseUrl: 'http://test',
}

function child(service: DevService, ignoreTerm = false) {
  const exit = deferred<number>()
  const signals: NodeJS.Signals[] = []
  return {
    service,
    exited: exit.promise,
    finish: exit.resolve,
    signals,
    signal(value: NodeJS.Signals) {
      signals.push(value)
      if (!ignoreTerm || value === 'SIGKILL') exit.resolve(0)
    },
  }
}

describe('daemon readiness', () => {
  test('waits past the old 120-second deadline without a fixed timeout', async () => {
    const path = home()
    const url = await healthServer((_req, res) => res.end(JSON.stringify({ ok: true })))
    const originalNow = Date.now
    let now = originalNow()
    let attempts = 0
    Date.now = () => now
    try {
      const result = await waitForDaemon(path, {
        timeoutMs: null,
        intervalMs: 1,
        onWait(attempt) {
          attempts = attempt
          now += 121_000
          if (attempt === 2) publish(path, url)
        },
      })
      expect(attempts).toBe(2)
      expect(result.baseUrl).toBe(url)
    } finally {
      Date.now = originalNow
    }
  })

  test('ignores old live metadata and accepts a record published by the new launch', async () => {
    const path = home()
    let requests = 0
    const url = await healthServer((_req, res) => {
      requests += 1
      res.end(JSON.stringify({ ok: true }))
    })
    publish(path, url, '2000-01-01T00:00:00.000Z')
    const result = await waitForDaemon(path, {
      notBefore: Date.now(),
      intervalMs: 1,
      onWait() {
        expect(requests).toBe(0)
        publish(path, url)
      },
    })
    expect(result.baseUrl).toBe(url)
    expect(requests).toBe(1)
  })

  test('requires healthy JSON instead of only an existing info file or HTTP 200', async () => {
    const path = home()
    const responses = [
      { status: 503, body: '{"ok":true}' },
      { status: 200, body: 'not json' },
      { status: 200, body: '{"ok":false}' },
      { status: 200, body: '{"ok":true}' },
    ]
    let requests = 0
    const url = await healthServer((_req, res) => {
      const response = responses[requests++]
      if (response === undefined) throw new Error('extra health request')
      res.writeHead(response.status)
      res.end(response.body)
    })
    publish(path, url)
    expect((await waitForDaemon(path, { intervalMs: 1 })).baseUrl).toBe(url)
    expect(requests).toBe(4)
  })

  test('cancellation interrupts an in-flight health request', async () => {
    const path = home()
    const requested = deferred<void>()
    const url = await healthServer(() => requested.resolve())
    publish(path, url)
    const controller = new AbortController()
    const waiting = waitForDaemon(path, { timeoutMs: null, signal: controller.signal })
    const rejected = waiting.then(
      () => false,
      () => true,
    )
    await requested.promise
    controller.abort()
    expect(await rejected).toBe(true)
  })

  test('standalone callers can still request a bounded wait', async () => {
    await expect(waitForDaemon(home(), { timeoutMs: 0 })).rejects.toThrow('within 0ms')
  })
})

describe('development service lifecycle', () => {
  test('starts dependents only after readiness, then closes every child on cancellation', async () => {
    const controller = new AbortController()
    const backendReady = deferred<DaemonInfo>()
    const dependentsStarted = deferred<void>()
    const children: ReturnType<typeof child>[] = []
    let waitOptions: WaitForDaemonOptions | undefined
    const running = runDev({
      signal: controller.signal,
      authEnabled: true,
      log: () => undefined,
      launch(service) {
        const launched = child(service)
        children.push(launched)
        if (service === 'system-mocks') dependentsStarted.resolve()
        return launched
      },
      waitUntilReady(_home, options) {
        waitOptions = options
        return backendReady.promise
      },
    })
    expect(children.map((entry) => entry.service)).toEqual(['backend'])
    expect(waitOptions?.timeoutMs).toBeNull()
    backendReady.resolve(daemon)
    await dependentsStarted.promise
    controller.abort()
    expect(await running).toBe(0)
    expect(children.map((entry) => entry.service)).toEqual(['backend', 'frontend', 'system-mocks'])
    for (const entry of children) expect(entry.signals).toContain('SIGTERM')
  })

  test('backend failure cancels readiness and starts no dependent service', async () => {
    const backend = child('backend')
    const names: DevService[] = []
    const running = runDev({
      log: () => undefined,
      launch(service) {
        names.push(service)
        return backend
      },
      waitUntilReady(_home, options) {
        return new Promise<DaemonInfo>((_done, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('stopped')), {
            once: true,
          })
        })
      },
    })
    backend.finish(7)
    expect(await running).toBe(7)
    expect(names).toEqual(['backend'])
  })

  test('dependent failure shuts down its siblings and preserves its exit code', async () => {
    const children: ReturnType<typeof child>[] = []
    const result = await runDev({
      log: () => undefined,
      waitUntilReady: async () => daemon,
      launch(service) {
        const launched = child(service)
        children.push(launched)
        if (service === 'frontend') launched.finish(9)
        return launched
      },
    })
    expect(result).toBe(9)
    for (const entry of children) expect(entry.signals).toContain('SIGTERM')
  })

  test('disabled login is skipped and an unresponsive child is collected at shutdown', async () => {
    const controller = new AbortController()
    const frontendStarted = deferred<void>()
    const children: ReturnType<typeof child>[] = []
    const running = runDev({
      signal: controller.signal,
      authEnabled: false,
      shutdownGraceMs: 10,
      log: () => undefined,
      waitUntilReady: async () => daemon,
      launch(service) {
        const launched = child(service, service === 'backend')
        children.push(launched)
        if (service === 'frontend') frontendStarted.resolve()
        return launched
      },
    })
    await frontendStarted.promise
    controller.abort()
    expect(await running).toBe(0)
    expect(children.map((entry) => entry.service)).toEqual(['backend', 'frontend'])
    expect(children[0]?.signals).toContain('SIGKILL')
  })

  test('a failed dependent spawn closes the backend and a pre-canceled launch starts nothing', async () => {
    const backend = child('backend')
    expect(
      await runDev({
        log: () => undefined,
        waitUntilReady: async () => daemon,
        launch(service) {
          if (service !== 'backend') throw new Error('spawn failed')
          return backend
        },
      }),
    ).toBe(1)
    expect(backend.signals).toContain('SIGTERM')
    const controller = new AbortController()
    controller.abort()
    const started: DevService[] = []
    expect(
      await runDev({
        signal: controller.signal,
        log: () => undefined,
        launch(service) {
          started.push(service)
          return child(service)
        },
      }),
    ).toBe(0)
    expect(started).toEqual([])
  })

  test('real package processes follow HTTP readiness and all exit with the launcher', async () => {
    const root = home()
    const appHome = join(root, 'app')
    mkdirSync(appHome)
    const backendFile = join(root, 'backend.json')
    const frontendFile = join(root, 'frontend.json')
    const loginFile = join(root, 'system-mocks.json')
    const readyFile = join(root, 'allow-ready')
    for (const service of ['backend', 'frontend', 'system-mocks'] as const) {
      const directory = join(root, 'packages', service)
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ scripts: { dev: 'bun service.ts' } }),
      )
      writeFileSync(
        join(directory, 'service.ts'),
        `import {writeFileSync, existsSync} from 'node:fs';
const service = ${JSON.stringify(service)};
const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch() {
  const ok = service !== 'backend' || existsSync(${JSON.stringify(readyFile)});
  if (service === 'backend') writeFileSync(${JSON.stringify(join(root, 'probed'))}, 'yes');
  return Response.json({ok}, {status: ok ? 200 : 503});
}});
const info = {pid: process.pid, url: server.url.toString(), startedAt: new Date().toISOString()};
writeFileSync(${JSON.stringify(join(root, service + '.json'))}, JSON.stringify(info));
if (service === 'backend') writeFileSync(${JSON.stringify(join(appHome, '.daemon.info'))}, JSON.stringify(info));
`,
      )
    }
    const controller = new AbortController()
    const running = runDev({
      root,
      home: appHome,
      signal: controller.signal,
      authEnabled: true,
      log: () => undefined,
    })
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 10_000
      while (!condition()) {
        if (Date.now() >= deadline) throw new Error('fixture startup deadline')
        await delay(10)
      }
    }
    try {
      await until(() => existsSync(join(root, 'probed')))
      expect(existsSync(frontendFile)).toBe(false)
      expect(existsSync(loginFile)).toBe(false)
      writeFileSync(readyFile, 'yes')
      await until(() => existsSync(frontendFile) && existsSync(loginFile))
      const records = [backendFile, frontendFile, loginFile].map(
        (path) => JSON.parse(readFileSync(path, 'utf8')) as { pid: number; url: string },
      )
      controller.abort()
      expect(await running).toBe(0)
      for (const record of records) {
        expect(() => process.kill(record.pid, 0)).toThrow()
        // A configured HTTP proxy can return a status page for a closed port. Check
        // the actual TCP listener rather than interpreting that HTTP response.
        const address = new URL(record.url)
        const closedPort = new Promise<void>((done, reject) => {
          const socket = createConnection({ host: address.hostname, port: Number(address.port) })
          socket.once('connect', () => {
            socket.destroy()
            done()
          })
          socket.once('error', reject)
        })
        await expect(closedPort).rejects.toThrow()
      }
    } finally {
      controller.abort()
      await running
    }
  }, 20_000)
})
