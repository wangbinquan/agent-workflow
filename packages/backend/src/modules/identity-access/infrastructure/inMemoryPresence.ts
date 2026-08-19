// RFC-312 —— presence 的进程内适配器。状态易失：daemon 重启即空，由客户端重连自然重建。

import { stateOf, type PresenceEntry } from '../domain/userPresence'
import type {
  MonotonicClock,
  PresenceTimer,
  UserPresenceStore,
} from '../application/ports/presence'

export class InMemoryUserPresenceStore implements UserPresenceStore {
  private readonly entries = new Map<string, PresenceEntry>()
  /** 宽限中的用户子集，避免为找"最早到期"去扫全表（规模与用户总数无关）。 */
  private readonly pendingIds = new Set<string>()
  private gen = 0

  get(userId: string): PresenceEntry | undefined {
    return this.entries.get(userId)
  }

  set(userId: string, entry: PresenceEntry): void {
    this.entries.set(userId, entry)
    if (entry.connections === 0 && entry.graceUntil !== null) this.pendingIds.add(userId)
    else this.pendingIds.delete(userId)
    this.gen += 1
  }

  delete(userId: string): void {
    this.entries.delete(userId)
    this.pendingIds.delete(userId)
    this.gen += 1
  }

  pending(): ReadonlyArray<readonly [string, PresenceEntry]> {
    const out: Array<readonly [string, PresenceEntry]> = []
    for (const id of this.pendingIds) {
      const entry = this.entries.get(id)
      if (entry !== undefined) out.push([id, entry])
    }
    return out
  }

  onlineIds(now: number): string[] {
    const out: string[] = []
    for (const [id, entry] of this.entries) if (stateOf(entry, now) === 'online') out.push(id)
    return out
  }

  generation(): number {
    return this.gen
  }
}

/** setTimeout + unref()。arm 会替换上一次安排（本 RFC 只需要"最早到期"一枚）。 */
export class TimeoutPresenceTimer implements PresenceTimer {
  private handle: ReturnType<typeof setTimeout> | null = null

  arm(delayMs: number, fn: () => void): void {
    this.clear()
    const h = setTimeout(
      () => {
        this.handle = null
        fn()
      },
      Math.max(0, delayMs),
    )
    // Bun/Node 的 unref 在部分测试替身上不存在，故防御性调用。
    ;(h as unknown as { unref?: () => void }).unref?.()
    this.handle = h
  }

  clear(): void {
    if (this.handle !== null) {
      clearTimeout(this.handle)
      this.handle = null
    }
  }

  armed(): boolean {
    return this.handle !== null
  }
}

export class PerformanceMonotonicClock implements MonotonicClock {
  nowMs(): number {
    return performance.now()
  }
}
