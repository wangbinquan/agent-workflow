// RFC-152 — table-driven WS → react-query invalidation.
//
// Every WS sync hook used to hand-roll the same shape: useWebSocket +
// if-chains over msg.type + qc.invalidateQueries calls. This hook turns
// that into data: a rules table keyed by the message's `type` discriminant.
//
//   rules[type] = (msg, ctx) => readonly QueryKey[] | void
//
//   - Returning query keys invalidates each of them (one invalidateQueries
//     call per key, same as the hand-written hooks did).
//   - Returning void makes the rule side-effect-only — the slot that carries
//     useWorkflowSync's version gating and useClarifyWs's onDraftUpdated
//     callback (rules may ALSO fire side effects before returning keys).
//   - Messages without a matching rule are ignored.
//
// `path === null` disables the subscription (no socket). Socket sharing is
// inherited from useWebSocket (RFC-152 D5): all rule sets subscribed to the
// same path ride ONE physical connection with refcounted teardown, so e.g.
// useTaskSync + useClarifyWs on the same task never double-connect.
//
// `rules` and `ctx` are read through latest-refs — callers may pass inline
// tables/objects without causing resubscribes.

import type { QueryKey } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useWebSocket, type WebSocketConnectionState } from './useWebSocket'

export type WsInvalidationRules<M extends { type: string }, Ctx = void> = {
  [K in M['type']]?: (msg: Extract<M, { type: K }>, ctx: Ctx) => readonly QueryKey[] | void
}

type ErasedRule = (msg: unknown, ctx: unknown) => readonly QueryKey[] | void

export interface WsInvalidationOptions<Ctx> {
  /**
   * WS frames are notifications, not a replay log. Return the query surfaces
   * that must be reconciled after every physical open (initial, reconnect, or
   * auth rotation) so events missed while disconnected cannot leave stale UI.
   */
  reconcileOnOpen?: (ctx: Ctx | undefined) => readonly QueryKey[]
}

/** RFC-311（audit L5/P1-5）：leading + trailing 合并——同一 queryKey 的首次
 *  失效立即执行（低频面零延迟、既有语义不变），窗口内的后续失效合并为一次
 *  尾沿 invalidate。高频事件面（蒸馏批量产出、intent turn 流、scheduled
 *  fired）此前每条消息都立即 refetch 整张列表——每秒可达多次全量重拉。
 *  reconcileOnOpen 不经合并（重连须立即补齐）。 */
const INVALIDATE_COALESCE_MS = 1_000

export function useWsInvalidation<M extends { type: string }, Ctx = void>(
  path: string | null,
  rules: WsInvalidationRules<M, Ctx>,
  ctx?: Ctx,
  options?: WsInvalidationOptions<Ctx>,
): WebSocketConnectionState {
  const qc = useQueryClient()
  const rulesRef = useRef(rules)
  const ctxRef = useRef(ctx)
  const reconcileOnOpenRef = useRef(options?.reconcileOnOpen)
  useEffect(() => {
    rulesRef.current = rules
    ctxRef.current = ctx
    reconcileOnOpenRef.current = options?.reconcileOnOpen
  })
  const pendingKeysRef = useRef(new Map<string, QueryKey>())
  const lastSentAtRef = useRef(new Map<string, number>())
  const flushTimerRef = useRef<number | null>(null)
  const flushPending = () => {
    flushTimerRef.current = null
    const keys = [...pendingKeysRef.current.entries()]
    pendingKeysRef.current.clear()
    const now = Date.now()
    for (const [hash, key] of keys) {
      lastSentAtRef.current.set(hash, now)
      void qc.invalidateQueries({ queryKey: key })
    }
  }
  useEffect(
    () => () => {
      // Unmount: fire what's queued so a navigation right after a WS frame
      // cannot strand a stale list for the next visit.
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
        flushPending()
      }
    },
    [],
  )
  const connectionState = useWebSocket({
    path: path ?? '',
    enabled: path !== null && path !== '',
    onMessage: (raw) => {
      if (raw === null || typeof raw !== 'object') return
      const type = (raw as { type?: unknown }).type
      if (typeof type !== 'string') return
      const rule = (rulesRef.current as Record<string, ErasedRule | undefined>)[type]
      if (rule === undefined) return
      const keys = rule(raw, ctxRef.current)
      if (keys === undefined) return
      const now = Date.now()
      for (const key of keys) {
        const hash = JSON.stringify(key)
        const lastSentAt = lastSentAtRef.current.get(hash)
        if (lastSentAt === undefined || now - lastSentAt >= INVALIDATE_COALESCE_MS) {
          lastSentAtRef.current.set(hash, now)
          void qc.invalidateQueries({ queryKey: key })
        } else {
          pendingKeysRef.current.set(hash, key)
        }
      }
      if (pendingKeysRef.current.size > 0 && flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flushPending, INVALIDATE_COALESCE_MS)
      }
    },
  })
  useEffect(() => {
    if (connectionState.connectionEpoch === 0) return
    const keys = reconcileOnOpenRef.current?.(ctxRef.current)
    if (keys === undefined) return
    for (const key of keys) {
      void qc.invalidateQueries({ queryKey: key })
    }
  }, [connectionState.connectionEpoch, path, qc])
  return connectionState
}
