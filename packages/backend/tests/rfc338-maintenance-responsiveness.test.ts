// RFC-338 AC-1 — a synchronous SQLite/FS maintenance body may occupy its
// Worker for seconds, while real socket HTTP, WebSocket echo, and the daemon
// event-loop heartbeat must keep moving on the main thread.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function maxGap(values: readonly number[]): number {
  let max = 0
  for (let index = 1; index < values.length; index += 1) {
    max = Math.max(max, values[index]! - values[index - 1]!)
  }
  return max
}

describe('RFC-338 maintenance responsiveness', () => {
  test('2s synchronous Worker maintenance does not stall HTTP, WS, or main-loop ticks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc338-responsive-'))
    roots.push(root)
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request, bunServer) {
        const url = new URL(request.url)
        if (url.pathname === '/ws' && bunServer.upgrade(request)) return undefined
        return Response.json({ ok: true, at: Date.now() })
      },
      websocket: {
        message(socket, message) {
          socket.send(message)
        },
      },
    })
    const baseUrl = `http://${server.hostname}:${server.port}`
    const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws`)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('websocket-open-failed'))
    })

    const loopTicks: number[] = [performance.now()]
    const wsReceipts: number[] = []
    const httpLatencies: number[] = []
    const pendingHttp = new Set<Promise<void>>()
    socket.onmessage = () => wsReceipts.push(performance.now())
    const loopTimer = setInterval(() => loopTicks.push(performance.now()), 25)
    const wsTimer = setInterval(() => socket.send(String(Date.now())), 50)
    const httpTimer = setInterval(() => {
      const started = performance.now()
      const request = fetch(`${baseUrl}/health`)
        .then((response) => {
          expect(response.ok).toBe(true)
          httpLatencies.push(performance.now() - started)
        })
        .finally(() => pendingHttp.delete(request))
      pendingHttp.add(request)
    }, 50)

    const worker = new Worker(
      new URL('./fixtures/rfc338-blocking-maintenance-worker.ts', import.meta.url).href,
    )
    const finished = new Promise<{ slices: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('blocking-worker-timeout')), 10_000)
      worker.onerror = (event) => {
        clearTimeout(timeout)
        reject(new Error(event.message))
      }
      worker.onmessage = (event: MessageEvent<{ type: string; slices?: number }>) => {
        if (event.data.type !== 'done') return
        clearTimeout(timeout)
        resolve({ slices: event.data.slices ?? 0 })
      }
    })
    worker.postMessage({ root, durationMs: 2_000 })

    try {
      const result = await finished
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      clearInterval(loopTimer)
      clearInterval(wsTimer)
      clearInterval(httpTimer)
      await Promise.all([...pendingHttp])

      // A real stall shows as ONE gap the size of the maintenance body
      // (~2 000 ms: the main thread was blocked for the whole run). The budgets
      // below are half of that — wide enough for scheduler noise on a loaded
      // 3-core CI runner (main run 33808640685, macOS shard 4/4: a 551 ms tick
      // gap with the Worker demonstrably off-thread — 80+ ticks, all HTTP and
      // WS traffic answered), narrow enough that a blocked loop still fails by
      // a factor of two. The tick / receipt COUNT floors are what prove the
      // loop kept moving throughout; the gap budgets only bound the worst
      // single hiccup.
      const STALL_BUDGET_MS = 1_000
      expect(result.slices).toBeGreaterThan(20)
      expect(loopTicks.length).toBeGreaterThan(40)
      expect(maxGap(loopTicks)).toBeLessThan(STALL_BUDGET_MS)
      expect(httpLatencies.length).toBeGreaterThan(20)
      expect(Math.max(...httpLatencies)).toBeLessThan(STALL_BUDGET_MS)
      expect(wsReceipts.length).toBeGreaterThan(20)
      expect(maxGap(wsReceipts)).toBeLessThan(STALL_BUDGET_MS)
    } finally {
      clearInterval(loopTimer)
      clearInterval(wsTimer)
      clearInterval(httpTimer)
      worker.terminate()
      socket.close()
      server.stop(true)
    }
  }, 15_000)
})
