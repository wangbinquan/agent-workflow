// RFC-312 —— 用户在线状态的前端 store 与订阅。
//
// store 有**两维**而不是一个 Map：`hydrated` 与 `onlineIds`。少了 hydrated 就无法同时表达
// "确定离线"与"我不知道"——收到 `online: []` 后查某人，缺键返回 undefined 会让离线点根本不显示，
// 返回 false 又会在断线 / 无权限 / 快照未到时**谎报离线**。
//
// reset 的归属：认证代次变化与**物理连接生命周期**。刻意不挂在任一组件的 cleanup 上——
// `useWebSocket` 是多订阅者共享同一条物理连接的，按组件卸载去 reset 会清掉别人还在用的 store。

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { WS_PATHS } from '@agent-workflow/shared'
import { useAuthSessionRevision, usePermission } from '@/hooks/useActor'
import { useWebSocket } from '@/hooks/useWebSocket'

/** 这些 id 不是真实用户（历史行 / 系统行 / 未解析），一律返回"未知"而不是"离线"。 */
const SENTINELS = new Set(['local', '__system__', ''])

interface PresenceState {
  /** 是否收到过权威快照。false ⇒ 一切查询返回 undefined（未知）。 */
  readonly hydrated: boolean
  readonly onlineIds: ReadonlySet<string>
  /**
   * RFC-312 实现门 P1 —— **水化这份数据的认证代次**。
   *
   * 为什么必须入 state：store 是模块级的，而清空原先只发生在 `useEffect`（passive、在
   * commit 之后）。切账号时 `useAuthSessionRevision()` 是**同步**翻新的，于是"账号 B 的
   * 首次已提交渲染"会先读到账号 A 的在线名单，effect 之后才清——presence 在权限点后面，
   * 这就是一次跨账号泄漏。把代次记进 state 后，代次不匹配的数据**结构上读不出来**，
   * 不再依赖 effect 的时序。
   */
  readonly revision: number
}

const EMPTY: PresenceState = { hydrated: false, onlineIds: new Set(), revision: -1 }

let state: PresenceState = EMPTY
const listeners = new Set<() => void>()

function emit(next: PresenceState): void {
  state = next
  for (const l of listeners) l()
}

/** 收到全量快照：整体替换并置为已水化，同时钉住当前认证代次。 */
export function applyPresenceSnapshot(online: readonly string[], revision: number): void {
  emit({ hydrated: true, onlineIds: new Set(online), revision })
}

/** 收到增量：快照到达前的增量**丢弃**，避免半截状态被当成真值。 */
export function applyPresenceChanges(
  changes: ReadonlyArray<{ userId: string; online: boolean }>,
  revision: number,
): void {
  // 代次不符 ⇒ 这批增量属于上一个凭据，丢弃（否则会把旧账号的状态叠进新账号的视图）。
  if (!state.hydrated || state.revision !== revision) return
  const next = new Set(state.onlineIds)
  for (const c of changes) {
    if (c.online) next.add(c.userId)
    else next.delete(c.userId)
  }
  emit({ hydrated: true, onlineIds: next, revision })
}

/** 连接断开 / 登出 / 失权：回到"未知"，而不是把所有人显示成离线。 */
export function resetPresence(): void {
  if (state === EMPTY) return
  emit(EMPTY)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): PresenceState {
  return state
}

/**
 * `true` = 确定在线；`false` = 确定离线；`undefined` = 未知（未水化 / 无权限 / 非真实用户）。
 * 组件在 undefined 时**不渲染任何东西**，于是无权限用户看到的界面与今天逐字节一致。
 */
export function usePresenceOf(userId: string | null | undefined): boolean | undefined {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const revision = useAuthSessionRevision()
  // 代次不符 = 上一个账号留下的数据，一律"未知"。这一步在 render 期间生效，
  // 因此不存在"effect 清空之前先渲染一帧陈旧数据"的窗口。
  if (!snap.hydrated || snap.revision !== revision) return undefined
  if (userId === null || userId === undefined || SENTINELS.has(userId)) return undefined
  return snap.onlineIds.has(userId)
}

/**
 * 全站唯一的 presence 订阅点，挂在 AppShell 上。无 `users:presence` 时**根本不建立连接**
 * （服务端也会拒绝升级），store 恒空。
 */
export function usePresenceSubscription(): void {
  const canSeePresence = usePermission('users:presence')
  // 帧到达时**当前**的认证代次。写进 deps，凭据一换 onMessage 就重建，
  // 于是旧连接迟到的帧会带着旧代次被 applyPresenceChanges 丢掉。
  const revision = useAuthSessionRevision()
  const onMessage = useCallback(
    (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return
      const frame = msg as { type?: unknown; online?: unknown; changes?: unknown }
      // 按 discriminant 分流：hello 等控制帧直接忽略，不做无脑 parse。
      if (frame.type === 'presence.snapshot' && Array.isArray(frame.online)) {
        applyPresenceSnapshot(frame.online as string[], revision)
      } else if (frame.type === 'presence.changed' && Array.isArray(frame.changes)) {
        applyPresenceChanges(frame.changes as Array<{ userId: string; online: boolean }>, revision)
      }
    },
    [revision],
  )
  const connection = useWebSocket({
    path: WS_PATHS.presence,
    onMessage,
    enabled: canSeePresence,
  })
  // 物理连接断开 ⇒ 立刻回到"未知"。重连后由新的快照重新水化。
  useEffect(() => {
    if (!connection.connected) resetPresence()
  }, [connection.connected])
  // 失去权限（或从未有过）⇒ 不订阅且清空。
  useEffect(() => {
    if (!canSeePresence) resetPresence()
  }, [canSeePresence])
}
