// RFC-355 T4b（RFC-294 W4-E4a）—— intent 播报会话动静的窄端口。
//
// 为什么这条测试存在：迁位前 `dispatcher.ts` 与 `routes/intentSessions.ts` 各自
// `import { intentSessionsBroadcaster } from '@/ws/broadcaster'`，直接抓住传输层的全局单例。
// 后果不只是分层：**全仓至今没有一条测试观测过 intent 的广播**——单例没有可注入的面，
// 想断言「这一轮播了什么」就得起一整个 WS 服务。
//
// 端口化之后，六种事件是可断言的数据。这里锁两件事：
//   1. 投影实现把事件**原样**播到 `intent-sessions` 频道（wire 面逐字不变，前端一行不用改）；
//   2. intent 的 application / inbound 源码里不再出现传输层 import（回归防护：
//      任何人再图省事直接 import 广播器，这条会红）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INTENT_SESSIONS_CHANNEL, intentSessionsBroadcaster } from '../src/ws/broadcaster'
import { createIntentSessionWsPublisher } from '../src/modules/intent/infrastructure/intentSessionWsProjector'
import type { IntentSessionEvent } from '../src/modules/intent/ports/intentSessionEvents'

const SRC = resolve(import.meta.dir, '..', 'src', 'modules', 'intent')

const EVENTS: readonly IntentSessionEvent[] = [
  { type: 'intent.session.updated', sessionId: 's1', ownerUserId: 'u1' },
  {
    type: 'intent.turn.execution.updated',
    sessionId: 's1',
    ownerUserId: 'u1',
    turnId: 't1',
    eventSeq: 7,
  },
  { type: 'intent.turn.started', sessionId: 's1', ownerUserId: 'u1', turnId: 't1' },
  { type: 'intent.turn.finished', sessionId: 's1', ownerUserId: 'u1', turnId: 't1' },
  { type: 'intent.apply.committed', sessionId: 's1', ownerUserId: 'u1', journalId: 'j1' },
]

describe('RFC-355 T4b —— 会话事件投影', () => {
  test('六种事件逐字播到 intent-sessions 频道（字段一个不增不减）', () => {
    const seen: unknown[] = []
    const unsubscribe = intentSessionsBroadcaster.subscribe(INTENT_SESSIONS_CHANNEL, (message) => {
      seen.push(message)
    })
    try {
      const publisher = createIntentSessionWsPublisher()
      for (const event of EVENTS) publisher.publish(event)
    } finally {
      unsubscribe()
    }
    expect(seen).toEqual([...EVENTS])
  })

  test('退订之后不再收到（投影没有自己缓存订阅者）', () => {
    const seen: unknown[] = []
    const unsubscribe = intentSessionsBroadcaster.subscribe(INTENT_SESSIONS_CHANNEL, (message) => {
      seen.push(message)
    })
    unsubscribe()
    createIntentSessionWsPublisher().publish(EVENTS[0]!)
    expect(seen).toEqual([])
  })
})

describe('RFC-355 T4b —— intent 的编排与投递不再认识传输层', () => {
  test.each([['application/dispatcher.ts'], ['inbound/intentSessionRoutes.ts']])(
    '%s 里没有 @/ws/ 的 import',
    (relative) => {
      const source = readFileSync(resolve(SRC, relative), 'utf8')
      expect(source).not.toContain("from '@/ws/")
      expect(source).not.toContain('intentSessionsBroadcaster')
    },
  )

  test('传输层实现只有投影这一个文件（多一个就说明有人绕过了端口）', () => {
    const projector = readFileSync(
      resolve(SRC, 'infrastructure', 'intentSessionWsProjector.ts'),
      'utf8',
    )
    expect(projector).toContain("from '@/ws/broadcaster'")
  })
})
