// WebSocket server adapter for Bun.serve().
//
// Bun's WebSocket API splits work between `fetch` (does `server.upgrade()`)
// and `websocket` handlers (open/message/close). This module exposes
// `buildWebSocketAdapter(deps)` which returns both, so the daemon entry point
// stays a thin shim around `Bun.serve({ fetch, websocket })`.
//
// RFC-152 — everything channel-specific (path regex + param parsing, hello
// frame, broadcaster key, upgrade-time gates, per-frame gates, `?since`
// replay) lives in ws/registry.ts as data. This file only owns the
// channel-agnostic transport skeleton:
//
//   tryUpgrade:  parse (registry iteration) → token → registry upgradeGate
//                → server.upgrade
//   open:        registry openWsChannel (gatedSubscribe + hello + onOpenExtra)
//   close:       unsubscribe
//   message:     ignored (v1 channels are server→client only)
//
// There must be NO per-channel `kind === '…'` branch in this file — adding a
// channel means adding a registry spec, nothing here. A source-level ratchet
// test (tests/rfc152-ws-task-channel.test.ts) locks that in.
//
// Token auth: `?token=` accepts session tokens (aws_s_…), PATs (aws_pat_…)
// and the legacy daemon token — the same set the HTTP `multiAuth` middleware
// recognises (RFC-036).

import type { ServerWebSocket } from 'bun'
import type { Actor } from '@/auth/actor'
import { buildWsCredential, resolveActor } from '@/auth/session'
import type { DbClient } from '@/db/client'
import { createLogger } from '@/util/log'
import { checkUpgradeGate, openWsChannel, parseWsChannel, type WsConnectionData } from './registry'
import { trackConnection, untrackConnection } from './connections'

const log = createLogger('ws.server')

/**
 * Per-connection data — derived from the registry's channel-params union
 * (RFC-152: the previously hand-written kind union now comes from
 * ChannelParamsByKind).
 */
type ConnectionData = WsConnectionData

export interface WebSocketAdapterDeps {
  /**
   * Legacy daemon-token value used to bootstrap a daemon before any user
   * exists. Continues to upgrade WS connections as the `__system__` admin
   * actor (via auth/session.ts:resolveActor) so the single-user / scripted
   * daemon mode keeps working alongside the OIDC/PAT paths introduced by
   * RFC-036.
   */
  daemonToken: string
  db: DbClient
}

export interface WebSocketAdapter {
  /**
   * Try to upgrade a WebSocket request. Returns true if handled (caller
   * should return without producing a Response), false if the request isn't
   * a WS endpoint at all, or a Response to send back when the upgrade is
   * refused (bad token, unknown channel, etc.).
   *
   * Async because token resolution (RFC-036) may hit the DB to validate a
   * session token or PAT before the upgrade is allowed.
   */
  tryUpgrade(req: Request, server: { upgrade: BunUpgradeFn }): Promise<true | false | Response>

  /**
   * Bun.serve `websocket` handler tree. Pass directly to Bun.serve().
   */
  handlers: {
    open(ws: ServerWebSocket<ConnectionData>): void | Promise<void>
    close(ws: ServerWebSocket<ConnectionData>): void
    message(ws: ServerWebSocket<ConnectionData>, msg: string | Buffer): void
  }
}

type BunUpgradeFn = (req: Request, opts: { data: ConnectionData }) => boolean

export function buildWebSocketAdapter(deps: WebSocketAdapterDeps): WebSocketAdapter {
  // Pre-allocate the daemon-token Buffer once — `resolveActor` does a
  // length-check + timing-safe equality, so we avoid Buffer.from() per
  // upgrade attempt.
  const daemonTokenBuf = Buffer.from(deps.daemonToken, 'utf-8')

  async function tryUpgrade(
    req: Request,
    server: { upgrade: BunUpgradeFn },
  ): Promise<true | false | Response> {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/ws/')) return false
    // RFC-203 T6: WS upgrade rejections use the SAME flat uniform error body
    // as every HTTP route ({ok:false, code, message}) — the old nested
    // {error:{...}} shape needed a defensive branch in the frontend decoder.
    const wsError = (code: string, message: string, status: number): Response =>
      new Response(JSON.stringify({ ok: false, code, message }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    const channel = parseWsChannel(url)
    if (channel === null) {
      return wsError('ws-unknown-channel', 'unknown ws channel', 404)
    }
    const queryToken = url.searchParams.get('token')
    if (queryToken === null || queryToken === '') {
      return wsError('auth-required', 'invalid or missing token', 401)
    }
    // RFC-036 — accept session tokens (aws_s_…), PATs (aws_pat_…) and the
    // legacy daemon token, the same set the HTTP `multiAuth` middleware
    // recognises. Previously this branch only ran `timingSafeEquals` against
    // the static daemon token, so any client that logged in via OIDC and
    // received a session token failed every WS upgrade with 401 — the
    // SessionTab fell back to remount-on-tab-switch refetches and looked
    // "not live" even though the runner was broadcasting correctly.
    let actor: Actor | null = null
    try {
      actor = await resolveActor(deps.db, queryToken, daemonTokenBuf)
    } catch (err) {
      log.warn('upgrade-token-resolve-threw', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    if (actor === null) {
      return wsError('auth-required', 'invalid or missing token', 401)
    }
    // RFC-152 — upgrade-time whole-connection gates come from the registry:
    //   task               → canViewTask (RFC-054 W2-4; the tasks-list channel
    //                        does per-frame filtering instead because it
    //                        enumerates all tasks system-wide),
    //   memory-distill-jobs → admin-only (P0 fix 682de313),
    //   everything else     → gate-less, passes through.
    const verdict = await checkUpgradeGate(deps.db, actor, channel)
    if (verdict !== true) {
      return wsError(verdict.code, verdict.message, 403)
    }
    const data: ConnectionData = {
      channel,
      actor,
      // RFC-212 — fingerprint (never the raw token) so a live socket can be
      // re-checked when a credential is revoked; also carries the credential's
      // expiry for the zero-DB frame-path expiry check. Computed from the same
      // token resolveActor just consumed.
      credential: await buildWsCredential(deps.db, queryToken),
      closing: false,
      unsubscribe: () => {
        /* set on open */
      },
      visibilityCache: new Map<string, boolean>(),
    }
    const ok = server.upgrade(req, { data })
    if (!ok) {
      return wsError('upgrade-failed', 'websocket upgrade failed', 426)
    }
    return true
  }

  async function handleOpen(ws: ServerWebSocket<ConnectionData>): Promise<void> {
    const ch = ws.data.channel
    log.debug('open', { channel: ch })
    // RFC-212 — join the live set BEFORE subscribing, so a revocation racing
    // this upgrade cannot slip past: either the rescan sees this connection (and
    // re-checks the actor it just resolved), or it completed earlier and the
    // actor resolved above is already newer than that revocation.
    trackConnection(ws)
    // RFC-152 — gatedSubscribe (admin short-circuit → frameGate → error ⇒
    // drop) + hello frame + onOpenExtra (task `?since` replay), all driven
    // by the channel's registry spec.
    await openWsChannel(ws, ch, deps.db)
  }

  function handleClose(ws: ServerWebSocket<ConnectionData>): void {
    untrackConnection(ws)
    try {
      ws.data.unsubscribe()
    } catch (err) {
      log.warn('unsubscribe threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function handleMessage(_ws: ServerWebSocket<ConnectionData>, _msg: string | Buffer): void {
    // v1: clients are read-only on these channels. Ignore inbound frames.
  }

  return {
    tryUpgrade,
    handlers: {
      open: handleOpen,
      close: handleClose,
      message: handleMessage,
    },
  }
}
