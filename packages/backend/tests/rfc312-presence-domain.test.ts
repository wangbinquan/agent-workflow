// RFC-312 —— presence 纯函数状态机的表测。
//
// 这些用例锁的是设计门反复确认的三条：
//   1. 宽限期语义（刷新 / 跳转 / 短暂断网重连不得产生状态翻转）；
//   2. `now >= graceUntil` 即离线的闭区间边界；
//   3. 对零计数重复 close 的幂等——连接释放路径今天就会被调用两次
//      （closeConnection 同步 untrack + Bun close 回调的 handleClose），
//      调用侧用单次句柄挡一层，这里必须再兜一层，绝不能扣成负数。
//
// `now` 一律是单调刻度：另有 wall-clock 回拨的用例锁"墙钟不参与判定"。

import { describe, expect, test } from 'bun:test'

import {
  PRESENCE_GRACE_MS,
  connectionClosed,
  connectionOpened,
  isReapable,
  stateOf,
  type PresenceEntry,
} from '../src/modules/identity-access/domain/userPresence'

const T0 = 1_000_000

describe('rfc312 presence domain', () => {
  test('状态表逐行（design §1）', () => {
    // 未知用户
    expect(stateOf(undefined, T0)).toBe('offline')

    // 第 1 条连接
    const one = connectionOpened(undefined)
    expect(one).toEqual({ connections: 1, graceUntil: null })
    expect(stateOf(one, T0)).toBe('online')

    // 第 2 条
    const two = connectionOpened(one)
    expect(two).toEqual({ connections: 2, graceUntil: null })
    expect(stateOf(two, T0)).toBe('online')

    // 关掉 1 条（还剩 1）——仍在线，且不进宽限
    const backToOne = connectionClosed(two, T0)
    expect(backToOne).toEqual({ connections: 1, graceUntil: null })
    expect(stateOf(backToOne, T0)).toBe('online')

    // 关掉最后 1 条 ⇒ 进入宽限
    const grace = connectionClosed(backToOne, T0)
    expect(grace).toEqual({ connections: 0, graceUntil: T0 + PRESENCE_GRACE_MS })
    expect(stateOf(grace, T0)).toBe('online')
    expect(stateOf(grace, T0 + PRESENCE_GRACE_MS - 1)).toBe('online')
  })

  test('边界取闭区间：now === graceUntil 即离线', () => {
    const grace = connectionClosed(connectionOpened(undefined), T0)
    expect(stateOf(grace, T0 + PRESENCE_GRACE_MS - 1)).toBe('online')
    expect(stateOf(grace, T0 + PRESENCE_GRACE_MS)).toBe('offline')
    expect(stateOf(grace, T0 + PRESENCE_GRACE_MS + 1)).toBe('offline')
  })

  test('宽限期内重新建连：回到 online 且 graceUntil 清空（这是"刷新不闪烁"的根据）', () => {
    const grace = connectionClosed(connectionOpened(undefined), T0)
    const reopened = connectionOpened(grace)
    expect(reopened).toEqual({ connections: 1, graceUntil: null })
    // 关键：翻转前后派生态都是 online ⇒ 调用侧不会产生任何广播帧
    expect(stateOf(grace, T0 + 1)).toBe('online')
    expect(stateOf(reopened, T0 + 1)).toBe('online')
  })

  test('零计数重复 close 幂等，绝不扣成负数', () => {
    const grace = connectionClosed(connectionOpened(undefined), T0)
    const again = connectionClosed(grace, T0 + 5)
    expect(again.connections).toBe(0)
    // 重复 close 不得刷新宽限期终点（否则反复关闭能把用户永久钉在 online）
    expect(again.graceUntil).toBe(T0 + PRESENCE_GRACE_MS)

    const fromUndefined = connectionClosed(undefined, T0)
    expect(fromUndefined).toEqual({ connections: 0, graceUntil: null })
    expect(stateOf(fromUndefined, T0)).toBe('offline')
  })

  test('多连接：关到最后一条才进入宽限（多标签页语义）', () => {
    let e: PresenceEntry | undefined
    for (let i = 0; i < 5; i += 1) e = connectionOpened(e)
    expect(e).toEqual({ connections: 5, graceUntil: null })
    for (let i = 0; i < 4; i += 1) {
      e = connectionClosed(e, T0)
      expect(e.graceUntil).toBeNull()
      expect(stateOf(e, T0)).toBe('online')
    }
    e = connectionClosed(e, T0)
    expect(e).toEqual({ connections: 0, graceUntil: T0 + PRESENCE_GRACE_MS })
  })

  test('isReapable：仅在无活连接且宽限到期后为真', () => {
    const live = connectionOpened(undefined)
    expect(isReapable(live, T0 + PRESENCE_GRACE_MS * 10)).toBe(false)

    const grace = connectionClosed(live, T0)
    expect(isReapable(grace, T0 + PRESENCE_GRACE_MS - 1)).toBe(false)
    expect(isReapable(grace, T0 + PRESENCE_GRACE_MS)).toBe(true)

    expect(isReapable({ connections: 0, graceUntil: null }, T0)).toBe(false)
  })

  test('墙钟回拨不参与判定：判据只看传入的单调刻度', () => {
    const grace = connectionClosed(connectionOpened(undefined), T0)
    // 模拟墙钟被回拨 5 分钟——单调刻度照常前进 ⇒ 照常到期
    const monotonicAtExpiry = T0 + PRESENCE_GRACE_MS
    expect(stateOf(grace, monotonicAtExpiry)).toBe('offline')
    expect(isReapable(grace, monotonicAtExpiry)).toBe(true)
    // 反向：单调刻度未到 ⇒ 无论墙钟怎么跳都仍在线
    expect(stateOf(grace, T0 + 1)).toBe('online')
  })

  test('自定义 graceMs 生效（供测试与将来调参）', () => {
    const grace = connectionClosed(connectionOpened(undefined), T0, 5_000)
    expect(grace.graceUntil).toBe(T0 + 5_000)
    expect(stateOf(grace, T0 + 4_999)).toBe('online')
    expect(stateOf(grace, T0 + 5_000)).toBe('offline')
  })
})
