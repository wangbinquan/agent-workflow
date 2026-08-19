// RFC-312 —— presence 写侧用例的行为锁。
//
// 用可手动驱动的假时钟/假定时器，所以"宽限到期"和"合并窗口"都不依赖真实等待。
// 锁的四件事：
//   1. 只有派生态翻转才广播（宽限内断开重连一帧不发）；
//   2. 合并窗口：同用户取末态、净零不发、一批只发一次；
//   3. 空闲时零定时器（有待到期项才 arm grace，有缓冲才 arm batch）；
//   4. observer 抛错不得让同一批被重复发出。

import { beforeEach, describe, expect, test } from 'bun:test'

import { TrackUserPresence } from '../src/modules/identity-access/application/commands/trackUserPresence'
import { GetUserPresence } from '../src/modules/identity-access/application/queries/getUserPresence'
import { InMemoryUserPresenceStore } from '../src/modules/identity-access/infrastructure/inMemoryPresence'
import type {
  PresenceChange,
  PresenceTimer,
} from '../src/modules/identity-access/application/ports/presence'

class FakeTimer implements PresenceTimer {
  private fn: (() => void) | null = null
  delay = 0
  arm(delayMs: number, fn: () => void): void {
    this.delay = delayMs
    this.fn = fn
  }
  clear(): void {
    this.fn = null
  }
  armed(): boolean {
    return this.fn !== null
  }
  fire(): void {
    const f = this.fn
    this.fn = null
    f?.()
  }
}

const GRACE = 60_000
const BATCH = 500

function setup() {
  const store = new InMemoryUserPresenceStore()
  const graceTimer = new FakeTimer()
  const batchTimer = new FakeTimer()
  let now = 1_000
  const clock = { nowMs: () => now }
  const batches: PresenceChange[][] = []
  const tracker = new TrackUserPresence({
    store,
    graceTimer,
    batchTimer,
    clock,
    observer: { presenceChanged: (c) => batches.push([...c]) },
    graceMs: GRACE,
    batchMs: BATCH,
  })
  const query = new GetUserPresence(store, clock)
  return {
    store,
    graceTimer,
    batchTimer,
    tracker,
    query,
    batches,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('rfc312 presence tracker', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => {
    s = setup()
  })

  test('上线：翻转入窗口，窗口刷出后广播一次', () => {
    s.tracker.opened('u1')
    expect(s.batches).toHaveLength(0) // 还在窗口里
    expect(s.batchTimer.armed()).toBe(true)
    expect(s.batchTimer.delay).toBe(BATCH)
    s.batchTimer.fire()
    expect(s.batches).toEqual([[{ userId: 'u1', online: true }]])
    expect(s.query.snapshot()).toEqual(['u1'])
  })

  test('第二条连接不产生翻转，一帧不发', () => {
    s.tracker.opened('u1')
    s.batchTimer.fire()
    s.batches.length = 0

    s.tracker.opened('u1')
    expect(s.batchTimer.armed()).toBe(false)
    expect(s.batches).toHaveLength(0)
  })

  test('宽限内断开重连：净零变化，一帧不发（刷新/切路由不闪烁）', () => {
    s.tracker.opened('u1')
    s.batchTimer.fire()
    s.batches.length = 0

    s.tracker.closed('u1') // 进宽限，派生态仍 online ⇒ 不算翻转
    expect(s.batchTimer.armed()).toBe(false)
    s.advance(1_000)
    s.tracker.opened('u1') // 宽限内重连
    s.advance(1_000)
    expect(s.batches).toHaveLength(0)
    expect(s.query.stateOf('u1')).toBe('online')
  })

  test('宽限到期：grace 定时器回收并广播离线', () => {
    s.tracker.opened('u1')
    s.batchTimer.fire()
    s.batches.length = 0

    s.tracker.closed('u1')
    expect(s.graceTimer.armed()).toBe(true)
    expect(s.graceTimer.delay).toBe(GRACE)

    s.advance(GRACE)
    s.graceTimer.fire()
    expect(s.batchTimer.armed()).toBe(true)
    s.batchTimer.fire()
    expect(s.batches).toEqual([[{ userId: 'u1', online: false }]])
    expect(s.query.snapshot()).toEqual([])
    expect(s.graceTimer.armed()).toBe(false) // 无待到期项 ⇒ 不再 arm
  })

  test('合并窗口：多人同窗口上线只发一帧，且 changes 完整', () => {
    for (let i = 0; i < 200; i += 1) s.tracker.opened(`u${i}`)
    expect(s.batches).toHaveLength(0)
    s.batchTimer.fire()
    expect(s.batches).toHaveLength(1)
    expect(s.batches[0]).toHaveLength(200)
    expect(new Set(s.batches[0]!.map((c) => c.userId)).size).toBe(200)
    expect(s.batches[0]!.every((c) => c.online)).toBe(true)
  })

  test('合并窗口：同一用户取末态', () => {
    s.tracker.opened('u1')
    s.tracker.closed('u1')
    s.advance(GRACE)
    s.tracker.reapExpired() // online → offline
    s.tracker.opened('u1') // offline → online
    s.batchTimer.fire()
    expect(s.batches).toEqual([[{ userId: 'u1', online: true }]])
  })

  test('合并窗口：净零变化不发帧', () => {
    s.tracker.opened('u1')
    s.batchTimer.fire()
    s.batches.length = 0

    s.tracker.closed('u1')
    s.advance(GRACE)
    s.tracker.reapExpired() // true → false
    s.tracker.opened('u1') // false → true，回到初态
    s.batchTimer.fire()
    expect(s.batches).toHaveLength(0)
  })

  test('空闲时零定时器；有待到期项才 arm grace', () => {
    expect(s.graceTimer.armed()).toBe(false)
    expect(s.batchTimer.armed()).toBe(false)

    s.tracker.opened('u1')
    s.batchTimer.fire()
    expect(s.batchTimer.armed()).toBe(false) // 缓冲已空
    expect(s.graceTimer.armed()).toBe(false) // 无人在宽限

    s.tracker.closed('u1')
    expect(s.graceTimer.armed()).toBe(true)
    s.advance(GRACE)
    s.graceTimer.fire()
    s.batchTimer.fire()
    expect(s.graceTimer.armed()).toBe(false)
    expect(s.batchTimer.armed()).toBe(false)
  })

  test('多人先后下线：grace 只保留一枚，指向最早到期', () => {
    s.tracker.opened('a')
    s.tracker.opened('b')
    s.batchTimer.fire()

    s.tracker.closed('a') // a 的 deadline = now + GRACE
    s.advance(10_000)
    s.tracker.closed('b') // b 更晚
    expect(s.graceTimer.delay).toBe(GRACE - 10_000) // 指向 a

    s.advance(GRACE - 10_000)
    s.graceTimer.fire()
    s.batchTimer.fire()
    expect(s.batches.at(-1)).toEqual([{ userId: 'a', online: false }])
    expect(s.graceTimer.armed()).toBe(true) // b 仍在宽限 ⇒ 重新 arm
  })

  test('observer 抛错：缓冲已先清空，同一批不会被重复发出', () => {
    const store = new InMemoryUserPresenceStore()
    const batchTimer = new FakeTimer()
    let calls = 0
    const tracker = new TrackUserPresence({
      store,
      graceTimer: new FakeTimer(),
      batchTimer,
      clock: { nowMs: () => 1_000 },
      observer: {
        presenceChanged: () => {
          calls += 1
          throw new Error('boom')
        },
      },
      graceMs: GRACE,
      batchMs: BATCH,
    })
    tracker.opened('u1')
    expect(() => batchTimer.fire()).toThrow('boom')
    expect(calls).toBe(1)
    // 再刷一次：缓冲已空 ⇒ 不再触发 observer
    tracker.flushBatch()
    expect(calls).toBe(1)
  })
})
