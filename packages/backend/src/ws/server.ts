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
import {
  buildWsCredential,
  extractUpgradeToken,
  reresolveActor,
  resolveActor,
} from '@/auth/session'
import { allowsLegacyDaemonTestAccess, type DbClient } from '@/db/client'
import { createLogger } from '@/util/log'
import { checkUpgradeGate, openWsChannel, parseWsChannel, type WsConnectionData } from './registry'
import {
  closeConnection,
  currentRevalidationEpoch,
  trackConnection,
  untrackConnection,
  WS_CLOSE_AUTH_REVOKED,
} from './connections'

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
    // RFC-285 B4：WS 升级是 query token 的唯一保留面（浏览器 WebSocket 发不了
    // 自定义头），入口收编为 auth/session 的 extractUpgradeToken 显式函数。
    const queryToken = extractUpgradeToken(url)
    if (queryToken === null) {
      return wsError('auth-required', 'invalid or missing token', 401)
    }
    // RFC-036 — accept session tokens (aws_s_…), PATs (aws_pat_…) and the
    // legacy daemon token, the same set the HTTP `multiAuth` middleware
    // recognises. Previously this branch only ran `timingSafeEquals` against
    // the static daemon token, so any client that logged in via OIDC and
    // received a session token failed every WS upgrade with 401 — the
    // SessionTab fell back to remount-on-tab-switch refetches and looked
    // "not live" even though the runner was broadcasting correctly.
    // RFC-212 impl-gate finding 2: capture the revocation epoch BEFORE resolving
    // the actor, so a revocation that commits during this upgrade (any of the
    // awaits below) is detectable at open time.
    const upgradeEpoch = currentRevalidationEpoch()
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
    if (actor.source === 'daemon' && !allowsLegacyDaemonTestAccess(deps.db)) {
      return wsError(
        'bootstrap-admin-required',
        'complete first-administrator setup before opening application channels',
        403,
      )
    }
    // RFC-247 D2 / §3.5 — the token gates for WebSocket.
    //
    // `/ws/*` is upgraded here in Bun.serve's fetch handler, entirely OUTSIDE
    // `multiAuth` (which is mounted on `/api/*`), and `resolveActor` above
    // accepts PATs. So none of the three gates the route-metadata layer applies
    // to HTTP reach this path — they have to be restated.
    //
    //   · purpose: an `mcp_only` token is for `/api/mcp` and nothing else. Left
    //     unhandled, a token that cannot call `GET /api/tasks` could simply
    //     subscribe to `/ws/tasks/:id` for the same data.
    //   · channel allowlist: DEFAULT DENY. `repo-import` has no gate of any kind
    //     (its own spec says so — RFC-152 D4 leftover), and `intent-sessions`
    //     carries a domain RFC-247 D7 puts permanently out of a token's reach.
    //     Denying by default means a channel added later is closed to tokens
    //     until someone decides otherwise, rather than open until someone
    //     notices.
    if (actor.source === 'pat') {
      if (actor.purpose === 'mcp_only') {
        return wsError(
          'token-mcp-only',
          'this token was issued for MCP use only and cannot open a WebSocket',
          403,
        )
      }
      if (!TOKEN_ALLOWED_WS_CHANNELS.has(channel.kind)) {
        return wsError(
          'token-forbidden-channel',
          `personal access tokens cannot open the '${channel.kind}' channel`,
          403,
        )
      }
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
      revalidating: false,
      upgradeEpoch,
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
    // RFC-212 impl-gate finding 2: if a revocation committed DURING this upgrade
    // (epoch changed), this connection was resolved with a possibly-stale actor
    // and was invisible to that rescan's live snapshot. It's tracked now, so
    // re-resolve it once against the post-revocation DB before it can receive any
    // frame — close it if the credential was revoked, refresh the actor otherwise
    // (a role demotion). The subscribe below then runs under the fresh actor.
    if (currentRevalidationEpoch() !== ws.data.upgradeEpoch) {
      const fresh = await reresolveActor(deps.db, ws.data.credential, Date.now()).catch(() => null)
      if (fresh === null) {
        closeConnection(ws, WS_CLOSE_AUTH_REVOKED, 'auth-revoked-mid-upgrade')
        return
      }
      ws.data.actor = fresh
    }
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

/**
 * RFC-247 §3.5 — the channels a `general` token may open. DEFAULT DENY: a
 * channel absent from this set is closed to tokens.
 *
 * Two are deliberately excluded:
 *   · `repo-import`     — its spec states it has "no gate of any kind"
 *     (RFC-152 D4 leftover); anyone who guesses a batchId sees another user's
 *     import. That is an existing defect, but leaving it open to tokens would
 *     downgrade it from "needs an interactive login" to "one leaked token".
 *   · `intent-sessions` — RFC-247 D7 puts `intent:*` permanently out of a
 *     token's reach, and every `/api/intent-sessions/*` route 403s for tokens.
 *     Allowing the socket would be a back door to exactly that data.
 */
const TOKEN_ALLOWED_WS_CHANNELS: ReadonlySet<string> = new Set([
  'task',
  'tasks-list',
  'workflows',
  'workgroups',
  'memories',
  'memory-distill-jobs',
  'scheduled-tasks',
  'mcp-runtime-tests',
])
