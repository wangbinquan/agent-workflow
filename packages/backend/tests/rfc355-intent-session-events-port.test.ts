// RFC-355 T4b（RFC-294 W4-E4a）—— intent 播报会话动静的窄端口。
//
// 为什么这条测试存在：迁位前 `dispatcher.ts` 与 `routes/intentSessions.ts` 各自
// `import { intentSessionsBroadcaster } from '@/ws/broadcaster'`，直接抓住传输层的全局单例。
// 后果不只是分层：**全仓至今没有一条测试观测过 intent 的广播**——单例没有可注入的面，
// 想断言「这一轮播了什么」就得起一整个 WS 服务。
//
// 端口化之后，五种事件是可断言的数据。这里锁三件事：
//   1. 投影实现把事件**原样**播到 `intent-sessions` 频道（wire 面逐字不变，前端一行不用改）；
//   2. intent 下**只有投影这一个文件**认识传输层——不是只查两个文件（实现门 r2 实测：
//      原来那版只 `test.each` 了 dispatcher 与 inbound 两个文件，新建第三个
//      `rogueProjector.ts` 直接抓单例照样全绿，而标题写的是「多一个就说明有人绕过了端口」）；
//   3. **确实有人在调 port**——见 `rfc355-intent-session-event-callsites.test.ts`。
//      本文件只锁 port→broadcaster 那一跳；只有它的话，把六个 `events.publish` 调用点
//      全删成 `void` 仍然全绿（实现门 r2 实测 B1–B6），而那是「前端再也收不到任何推送」。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
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
  test('五种事件逐字播到 intent-sessions 频道（字段一个不增不减）', () => {
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

/**
 * 去掉行注释与块注释后的源码。
 *
 * 不剥注释会把「解释历史的那句话」也算成依赖：`ports/intentSessionEvents.ts` 的注释里
 * 写着当初 `import { intentSessionsBroadcaster } from '@/ws/broadcaster'` 的形态，
 * 而那正是这条守卫要防的字符串。守卫读注释 = 谁把原因写清楚谁先红。
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** `modules/intent/**` 下所有 .ts，相对 SRC 的路径。 */
function intentSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) out.push(relative(SRC, full))
    }
  }
  walk(SRC)
  return out.sort()
}

describe('RFC-355 T4b —— intent 下只有投影一个文件认识传输层', () => {
  test('语料非空（扫空即假绿）', () => {
    expect(intentSources().length).toBeGreaterThan(30)
  })

  test('触碰 @/ws/ 的文件与清单**逐条相等**（多一个、少一个都红）', () => {
    const touching = intentSources().filter((relativePath) => {
      const source = withoutComments(readFileSync(resolve(SRC, relativePath), 'utf8'))
      return /@\/ws\//.test(source) || source.includes('intentSessionsBroadcaster')
    })
    expect(
      touching,
      'intent 里除投影文件之外不得有第二处认识传输层。新增一处就要么改走 ' +
        '`ports/intentSessionEvents`，要么说明为什么这个 context 需要第二条投递路径。',
    ).toEqual(['infrastructure/intentSessionWsProjector.ts'])
  })

  test('投影文件确实连着广播器（清单空掉也算「只有一个」，所以要正向钉住）', () => {
    const projector = readFileSync(
      resolve(SRC, 'infrastructure', 'intentSessionWsProjector.ts'),
      'utf8',
    )
    expect(projector).toContain("from '@/ws/broadcaster'")
  })
})
