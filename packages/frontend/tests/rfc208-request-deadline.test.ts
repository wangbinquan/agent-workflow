// RFC-208 PR-2 —— 传输层截止时间。
//
// 第一层（networkMode，已修）挡的是「请求根本没发出去」；这一层挡的是「请求发出去
// 了但永不返回」。浏览器不会替应用施加响应超时，而 `api/client.ts` 的四个入口
// （apiRequest / apiPostMultipart / apiGetBlob / fetchOrNetworkError）此前
// 全仓 `AbortSignal.timeout` 零命中、99 个 mutation 只有 1 个传 signal。
//
// 后果不是失败而是**停顿**：mutation 停在 pending，而 `beginBusy` 的令牌喂给
// `useBlocker`（路由器全局），busy 时守卫还隐藏 Discard、只剩「留下」——单个请求
// 挂住就升级成全站锁死，只能刷新。
//
// 设计门两轮的关键修正都锁在这里：
//   · idleTimeout 量的是「空闲」、AbortSignal.timeout 量的是「总时长」，二者不可比，
//     所以「300s > 255s ⇒ 构造上不可能误杀」的论证被撤销（§6-1）；
//   · 档 B 公式必须以档 A 为下限，否则零文件的 upload-kind 启动只剩 60s，而那条
//     路径（tasks.new.tsx:846「即使零个文件也走 multipart」）在服务端还要解析仓库、
//     建 worktree（§6-8）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApiError,
  CLIENT_HARD_DEADLINE_MS,
  apiGetBlob,
  apiPostMultipart,
  apiRequest,
  payloadDeadlineMs,
} from '../src/api/client'
import { setBaseUrl, setToken } from '../src/stores/auth'

setBaseUrl('http://daemon.test')
setToken('tok')

afterEach(() => {
  vi.restoreAllMocks()
})

/** A fetch that never settles — the half-open socket / black-holed proxy shape. */
function installNeverSettlingFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        // Honour abort the way a real fetch does, so the deadline can land.
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'))
        })
      }),
  )
}

/** Headers arrive, body never ends — `res.json()` alone would hang forever. */
function installHeadersOnlyFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue, never close */
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

describe('RFC-208 · every request is bounded', () => {
  test('a never-settling request rejects as request-timeout, not forever-pending', async () => {
    installNeverSettlingFetch()
    const started = Date.now()
    await expect(apiRequest('/api/agents', { deadlineMs: 60 })).rejects.toMatchObject({
      code: 'request-timeout',
    })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('the deadline also covers the response body, not just the headers', async () => {
    // The subtle half: a proxy can send headers and then stall. Bounding only
    // `fetch` leaves `res.json()` awaiting EOF that never comes.
    installHeadersOnlyFetch()
    const started = Date.now()
    await expect(apiRequest('/api/agents', { deadlineMs: 60 })).rejects.toMatchObject({
      code: 'request-timeout',
    })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("a caller's own abort stays an AbortError and is not relabelled a timeout", async () => {
    installNeverSettlingFetch()
    const ctl = new AbortController()
    const pending = apiRequest('/api/agents', { signal: ctl.signal, deadlineMs: 60_000 })
    ctl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('multipart and blob entry points are bounded too', async () => {
    installNeverSettlingFetch()
    await expect(
      apiPostMultipart('/api/tasks', new FormData(), { deadlineMs: 60 }),
    ).rejects.toBeInstanceOf(ApiError)
    await expect(apiGetBlob('/api/x', undefined, { deadlineMs: 60 })).rejects.toBeInstanceOf(
      ApiError,
    )
  })
})

describe('RFC-208 · deadline budgets', () => {
  // §6-8: the floor is the whole point. A 0-byte multipart still does real
  // server-side work (repo resolution, worktree creation) on POST /api/tasks.
  test('the payload budget never dips below the fixed budget', () => {
    expect(payloadDeadlineMs(0)).toBeGreaterThanOrEqual(CLIENT_HARD_DEADLINE_MS)
    expect(payloadDeadlineMs(1024)).toBeGreaterThanOrEqual(CLIENT_HARD_DEADLINE_MS)
  })

  test('a 200 MiB upload gets far more than the fixed budget', () => {
    // 200 MiB is services/upload.ts's default `perRequest` cap.
    const budget = payloadDeadlineMs(200 * 1024 * 1024)
    expect(budget).toBeGreaterThan(CLIENT_HARD_DEADLINE_MS * 3)
  })

  test('the budget grows monotonically with payload size', () => {
    expect(payloadDeadlineMs(50 * 1024 * 1024)).toBeLessThan(payloadDeadlineMs(150 * 1024 * 1024))
  })

  // Cross-package lock. The fixed budget must clear the daemon's own idle
  // ceiling, so a request the daemon would still answer is never cut short by
  // the client. NOT a proof of "cannot misfire" — that claim was withdrawn
  // (§6-1); idleTimeout measures inactivity, this measures elapsed time.
  test('the fixed budget clears the daemon idleTimeout', () => {
    const startSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'backend',
        'src',
        'cli',
        'start.ts',
      ),
      'utf8',
    )
    const m = /idleTimeout:\s*(\d+)/.exec(startSource)
    expect(m).not.toBeNull()
    const daemonIdleMs = Number(m?.[1]) * 1000
    expect(daemonIdleMs).toBeGreaterThan(0)
    expect(CLIENT_HARD_DEADLINE_MS).toBeGreaterThan(daemonIdleMs)
  })
})
