// RFC-312 —— 用户在线状态的纯函数状态机。
//
// 判据：在线 ⟺ 该用户名下存在至少一条活的、由 session 凭据建立且已通过完整通道授权的
// `/ws/presence` 连接；或最后一条断开还不足 PRESENCE_GRACE_MS。
//
// 本文件零 I/O、零时钟：`now` 一律入参，且**必须是单调时钟刻度**（见下）。

/** 最后一条连接断开后仍视为在线的宽限期。抵消刷新 / 路由跳转 / 短暂断网重连造成的抖动。 */
export const PRESENCE_GRACE_MS = 60_000

export interface PresenceEntry {
  /** 活连接数，永不为负。 */
  readonly connections: number
  /**
   * connections 归零的时刻 + 宽限期；connections > 0 时为 null。
   *
   * **单调时钟刻度，不是墙钟**（设计门 F11）：用 Date.now() 的话，NTP / 管理员把系统时钟
   * 回拨 5 分钟就会让 `now < graceUntil` 持续成立、条目反复重新 arm，用户被显示在线约 6 分钟。
   * 宽限期是进程内、不持久化的状态，用单调源没有任何副作用。
   */
  readonly graceUntil: number | null
}

export type UserOnlineState = 'online' | 'offline'

/** 新建一条连接。宽限期中的用户重新建连 ⇒ 直接回到 online，且**不产生状态翻转**。 */
export function connectionOpened(entry: PresenceEntry | undefined): PresenceEntry {
  return { connections: (entry?.connections ?? 0) + 1, graceUntil: null }
}

/**
 * 关闭一条连接。归零时进入宽限期。
 *
 * 对 connections === 0 的 entry 是**幂等 no-op**：连接的释放路径今天就会被调用两次
 * （`ws/connections.ts` 的 closeConnection 同步 untrack + Bun close 回调里的 handleClose），
 * 调用侧用单次释放句柄保证只扣一次，这里再兜一层，绝不把计数扣成负数。
 */
export function connectionClosed(
  entry: PresenceEntry | undefined,
  now: number,
  graceMs: number = PRESENCE_GRACE_MS,
): PresenceEntry {
  const current = entry?.connections ?? 0
  if (current <= 0) return { connections: 0, graceUntil: entry?.graceUntil ?? null }
  const next = current - 1
  return next === 0
    ? { connections: 0, graceUntil: now + graceMs }
    : { connections: next, graceUntil: null }
}

/** 派生态。边界取闭区间：now >= graceUntil 即离线。 */
export function stateOf(entry: PresenceEntry | undefined, now: number): UserOnlineState {
  if (entry === undefined) return 'offline'
  if (entry.connections > 0) return 'online'
  if (entry.graceUntil === null) return 'offline'
  return now < entry.graceUntil ? 'online' : 'offline'
}

/** 可回收 = 无活连接且宽限已到期。回收后条目应从 store 删除。 */
export function isReapable(entry: PresenceEntry, now: number): boolean {
  return entry.connections === 0 && entry.graceUntil !== null && now >= entry.graceUntil
}
