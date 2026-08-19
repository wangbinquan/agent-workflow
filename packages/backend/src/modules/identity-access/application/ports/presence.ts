// RFC-312 —— presence 的 application-owned ports。
//
// 四个口放同一文件：它们是一组内聚的小接口（存储 / 两枚定时器 / 单调时钟 / 变更出口），
// 拆成四个文件只会增加导航成本而不增加清晰度。

import type { PresenceEntry } from '../../domain/userPresence'

export interface UserPresenceStore {
  get(userId: string): PresenceEntry | undefined
  set(userId: string, entry: PresenceEntry): void
  delete(userId: string): void
  /** 处于宽限期（connections === 0 且 graceUntil !== null）的用户集合。规模 = 刚下线的人数。 */
  pending(): ReadonlyArray<readonly [string, PresenceEntry]>
  /** 当前派生为 online 的用户；由调用方传入单调刻度。 */
  onlineIds(now: number): string[]
  /** 单调递增，每次写入 +1。快照序列化缓存以它为键的一部分。 */
  generation(): number
}

/** 可注入的一次性定时器。生产实现必须 unref()——presence 绝不能拖住进程退出。 */
export interface PresenceTimer {
  /** 安排在 delayMs 后回调；重复调用会**替换**上一次安排。 */
  arm(delayMs: number, fn: () => void): void
  clear(): void
  /** 仅测试用：是否有已安排未触发的回调。 */
  armed(): boolean
}

export interface MonotonicClock {
  /** 单调递增的毫秒刻度，不受系统时钟调整影响。 */
  nowMs(): number
}

export interface PresenceChange {
  readonly userId: string
  readonly online: boolean
}

export interface UserPresenceObserver {
  /** 合并窗口出口。changes 非空，且同一 userId 在一批里只出现一次（末态）。 */
  presenceChanged(changes: ReadonlyArray<PresenceChange>): void
}
