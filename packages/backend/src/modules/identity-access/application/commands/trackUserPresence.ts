// RFC-312 —— presence 的写侧用例：连接开/关 → 派生态翻转 → 合并窗口 → 广播。
//
// 两个不变量（设计门反复确认）：
//   1. **只有派生态真的翻转才进合并窗口**——宽限期内的断开重连不产生任何帧，
//      这是"刷新 / 切路由不闪烁"的根据。
//   2. **两枚定时器不共用回调**：grace 到期与 batch 刷出是两件事，共用一个 flush 会让
//      grace 到期把不足一个窗口的 batch 提前冲掉。
// 空闲时（无宽限项且缓冲为空）进程内不存在 presence 定时器。

import {
  PRESENCE_GRACE_MS,
  connectionClosed,
  connectionOpened,
  isReapable,
  stateOf,
} from '../../domain/userPresence'
import type {
  MonotonicClock,
  PresenceChange,
  PresenceTimer,
  UserPresenceObserver,
  UserPresenceStore,
} from '../ports/presence'

/** 合并窗口。窗口内同一用户多次翻转只发末态；净零变化不发。 */
export const PRESENCE_BATCH_MS = 500

interface BufferedFlip {
  /** 进入缓冲前的派生态——净零判定靠它，只存末态判不出 offline→online→offline。 */
  readonly initial: boolean
  final: boolean
}

export interface TrackUserPresenceDeps {
  readonly store: UserPresenceStore
  readonly graceTimer: PresenceTimer
  readonly batchTimer: PresenceTimer
  readonly clock: MonotonicClock
  readonly observer: UserPresenceObserver
  readonly graceMs?: number
  readonly batchMs?: number
}

export class TrackUserPresence {
  private readonly buffer = new Map<string, BufferedFlip>()

  constructor(private readonly deps: TrackUserPresenceDeps) {}

  private get graceMs(): number {
    return this.deps.graceMs ?? PRESENCE_GRACE_MS
  }

  private get batchMs(): number {
    return this.deps.batchMs ?? PRESENCE_BATCH_MS
  }

  opened(userId: string): void {
    const now = this.deps.clock.nowMs()
    const before = stateOf(this.deps.store.get(userId), now) === 'online'
    this.deps.store.set(userId, connectionOpened(this.deps.store.get(userId)))
    const after = stateOf(this.deps.store.get(userId), now) === 'online'
    if (before !== after) this.record(userId, before, after)
    this.armGrace()
  }

  closed(userId: string): void {
    const now = this.deps.clock.nowMs()
    const before = stateOf(this.deps.store.get(userId), now) === 'online'
    this.deps.store.set(userId, connectionClosed(this.deps.store.get(userId), now, this.graceMs))
    const after = stateOf(this.deps.store.get(userId), now) === 'online'
    if (before !== after) this.record(userId, before, after)
    this.armGrace()
  }

  /** grace 定时器回调：回收到期项并把 online→offline 的翻转投进窗口。 */
  reapExpired(): void {
    const now = this.deps.clock.nowMs()
    for (const [userId, entry] of this.deps.store.pending()) {
      if (!isReapable(entry, now)) continue
      this.deps.store.delete(userId)
      this.record(userId, true, false)
    }
    this.armGrace()
  }

  /** batch 定时器回调：把窗口内的净变化一次发出。 */
  flushBatch(): void {
    const changes: PresenceChange[] = []
    for (const [userId, flip] of this.buffer) {
      if (flip.initial === flip.final) continue // 净零变化不发
      changes.push({ userId, online: flip.final })
    }
    // 先清缓冲再通知：observer 抛错时同一批不得被重复发出。
    this.buffer.clear()
    if (changes.length > 0) this.deps.observer.presenceChanged(changes)
  }

  private record(userId: string, before: boolean, after: boolean): void {
    const existing = this.buffer.get(userId)
    if (existing === undefined) this.buffer.set(userId, { initial: before, final: after })
    else existing.final = after
    if (!this.deps.batchTimer.armed()) {
      this.deps.batchTimer.arm(this.batchMs, () => this.flushBatch())
    }
  }

  /** 只保留一枚 grace 定时器，指向所有宽限项里最早到期的那个；无宽限项则清掉。 */
  private armGrace(): void {
    const pending = this.deps.store.pending()
    let earliest: number | null = null
    for (const [, entry] of pending) {
      if (entry.graceUntil === null) continue
      if (earliest === null || entry.graceUntil < earliest) earliest = entry.graceUntil
    }
    if (earliest === null) {
      this.deps.graceTimer.clear()
      return
    }
    this.deps.graceTimer.arm(earliest - this.deps.clock.nowMs(), () => this.reapExpired())
  }
}
