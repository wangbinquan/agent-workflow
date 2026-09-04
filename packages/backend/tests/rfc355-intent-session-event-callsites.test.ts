// RFC-355 T4b（实现门 r2 findings）—— **确实有人在调 port**。
//
// 为什么这条测试存在：`rfc355-intent-session-events-port.test.ts` 只锁了
// port → broadcaster 那一跳（投影实现把事件原样播出去）。实现门第二路做了变异实验，
// 把 intent 的**六个** `events.publish(...)` 调用点逐个删成 `void`——
// `dispatcher.ts` 四处、`inbound/intentSessionRoutes.ts` 两处——**1122 条测试全绿**。
//
// 也就是说「前端从此再也收不到任何会话推送」这个最大号的用户可见回归，当时没有任何
// 东西挡得住；端口化在立项时写的理由（「广播第一次成为可断言的数据」）只兑现了一半。
//
// **覆盖到哪一步（如实记，别让下一个人以为全锁住了）**：本文件的三条驱动的是
// 「创建会话 → 一轮跑完 → archive/reopen」这条主路径，实测把 dispatcher 的
// `turn.started/finished` 或 inbound 的 `emitSessionUpdated` 删空**会红**。
// 仍未覆盖的两处发布点：
//   - `dispatcher.ts` catch 分支里那次 `turn.finished`（一轮 fire 失败时的收尾）；
//   - `dispatcher.ts` 的 `emitSessionUpdated` 在**排队工作集恢复**路径上的调用
//     —— 这一处由 `rfc349-intent-boot-resume-authority.test.ts` 补上了（同批加的）。
// 也就是说四组发布点里三组已有预言力，剩 fire 失败那一组仍是空的。
//
// 这里补上另一半，且**故意走真实生产接线**而不是注入 spy：订阅真实的
// `intentSessionsBroadcaster`、跑真实的 HTTP 路由，于是这条同时证明
// `server.ts` 里那次 `createIntentSessionWsPublisher()` 装配也是真的接上的
// （注入 spy 的写法证明不了这一点——bootstrap 忘了注入照样绿）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { seedBuiltinRuntimes, updateRuntime } from '../src/services/runtimeRegistry'
import { runtimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'
import { INTENT_SESSIONS_CHANNEL, intentSessionsBroadcaster } from '../src/ws/broadcaster'
import {
  emptySystemAgentOutputEvidence,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '../src/services/systemAgentRun'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'rfc355-callsites-daemon-token'

let db: DbClient
let root: string
let app: ReturnType<typeof createApp>
let ownerToken: string
let seen: { type: string; sessionId?: string }[]
let unsubscribe: () => void

/** 最小可用的 agent 轮次：只回一个 summary 端口，够让一轮跑完。 */
function stubRun(): (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult> {
  return async (opts) => {
    const nonce = /nonce="([^"]+)"/.exec(opts.prompt)?.[1] ?? ''
    return {
      status: 'ok',
      exitCode: 0,
      eventText: `<workflow-output nonce="${nonce}"><port name="summary">ok</port></workflow-output>`,
      stderrTail: '',
      durationMs: 1,
      scratchDir: '/tmp/x',
      scratchRetained: false,
      outputEvidence: emptySystemAgentOutputEvidence(),
    }
  }
}

async function waitFor(until: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (until()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`condition timed out; seen=${JSON.stringify(seen)}`)
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(runtimeRegistryPersistence(db))
  await updateRuntime(runtimeRegistryPersistence(db), 'opencode', { model: 'openai/gpt-5' })
  root = mkdtempSync(join(tmpdir(), 'rfc355-callsites-'))
  process.env.AGENT_WORKFLOW_HOME = root
  app = createApp({
    token: DAEMON_TOKEN,
    configPath: join(root, 'config.json'),
    opencodeVersion: null,
    dbVersion: 1,
    db,
    intentTestDependencies: { runFn: stubRun() },
  })
  const owner = await createUser(db, {
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    password: 'longEnoughPassword',
  })
  ownerToken = (await createSession({ db, userId: owner.id })).token
  seen = []
  unsubscribe = intentSessionsBroadcaster.subscribe(INTENT_SESSIONS_CHANNEL, (message) => {
    seen.push(message as { type: string; sessionId?: string })
  })
})

afterEach(() => {
  unsubscribe()
  delete process.env.AGENT_WORKFLOW_HOME
  rmSync(root, { recursive: true, force: true })
})

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${ownerToken}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

async function createIntentSession(): Promise<string> {
  const response = await req('/api/intent-sessions', {
    method: 'POST',
    body: JSON.stringify({ message: '给我一个会话，用来观测广播' }),
  })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { id: string }
  return body.id
}

describe('RFC-355 T4b —— 生产接线确实在播（删掉调用点必须红）', () => {
  test('dispatcher 的轮次事件真的到达广播器（turn.started / turn.finished）', async () => {
    const sessionId = await createIntentSession()
    await waitFor(() => seen.some((event) => event.type === 'intent.turn.finished'))
    const types = seen.filter((event) => event.sessionId === sessionId).map((e) => e.type)
    // 删掉 dispatcher.ts 的 `turn.started` / `turn.finished` 两处 publish ⇒ 这条超时。
    expect(types).toContain('intent.turn.started')
    expect(types).toContain('intent.turn.finished')
  })

  test('路由的 archive / reopen 真的播 intent.session.updated', async () => {
    const sessionId = await createIntentSession()
    await waitFor(() => seen.some((event) => event.type === 'intent.turn.finished'))
    seen.length = 0

    for (const action of ['archive', 'reopen'] as const) {
      const response = await req(`/api/intent-sessions/${sessionId}/${action}`, {
        method: 'POST',
      })
      expect(response.status).toBe(200)
    }
    // 删掉 inbound 的 `emitSessionUpdated` ⇒ 这条红。
    expect(
      seen.filter(
        (event) => event.type === 'intent.session.updated' && event.sessionId === sessionId,
      ).length,
    ).toBeGreaterThanOrEqual(2)
  })

  test('广播的 ownerUserId 是会话归属人——前端按它过滤，错了等于推给别人', async () => {
    const sessionId = await createIntentSession()
    await waitFor(() => seen.some((event) => event.type === 'intent.turn.finished'))
    const owners = new Set(
      seen
        .filter((event) => event.sessionId === sessionId)
        .map((event) => (event as { ownerUserId?: string }).ownerUserId),
    )
    expect(owners.size).toBe(1)
    expect([...owners][0]).toBeTruthy()
  })
})
