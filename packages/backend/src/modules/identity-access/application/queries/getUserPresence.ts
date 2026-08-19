// RFC-312 —— presence 读侧。**零参**：时钟由 query 自己持有，杜绝调用方随手传 Date.now()
// 造成与 graceUntil（单调刻度）不同域——那会让宽限中的用户在快照里立刻变离线。

import { stateOf, type UserOnlineState } from '../../domain/userPresence'
import type { MonotonicClock, UserPresenceStore } from '../ports/presence'

export class GetUserPresence {
  constructor(
    private readonly store: UserPresenceStore,
    private readonly clock: MonotonicClock,
  ) {}

  /** 当前在线的 userId 全集。规模 = 在线人数，与用户表规模无关。 */
  snapshot(): string[] {
    return this.store.onlineIds(this.clock.nowMs())
  }

  stateOf(userId: string): UserOnlineState {
    return stateOf(this.store.get(userId), this.clock.nowMs())
  }

  /** 快照序列化缓存的键的一半（另一半是最早到期时刻，防止缓存跨过宽限截止）。 */
  generation(): number {
    return this.store.generation()
  }
}
