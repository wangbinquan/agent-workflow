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
      for (const key of keys) {
        void qc.invalidateQueries({ queryKey: key })
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
