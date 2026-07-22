// RFC-212 PR-1 — process-level registry of live WebSocket connections.
//
// WHY THIS EXISTS
// ---------------
// `ws/server.ts` resolves an actor once at upgrade time and pins it into
// `ws.data`; nothing ever re-checks it. Revocation therefore does not reach an
// already-open socket: a user removed from a task, demoted from admin, or whose
// session/PAT was revoked keeps receiving frames — on the `task` channel that
// includes the agent's full stdout. See design/RFC-212-ws-authorization-revalidation.
//
// The fix (RFC-212 方案 D) runs the re-check in the REVOKER's async context, not
// in the broadcast path — `broadcaster.broadcast` is a synchronous for-of and
// two existing locks (`rfc152-ws-channel-registry.test.ts` "no frameGate ⇒ every
// frame forwards" / "adminShortCircuit sends synchronously") assert that frames
// are delivered without ever awaiting. To rescan on revocation we need one flat
// set of live connections; that is this file. Deliberately NOT a reverse index
// (user→conn, task→conn): the rescan is coarse, so a single set suffices and
// there is nothing per-revocation-kind to keep in sync.
//
// PR-1 ships only the bookkeeping (this file + the two hook calls). The rescan
// itself lands in PR-2 so the infrastructure can be reviewed with zero
// behavioural change.

import type { ServerWebSocket } from 'bun'
import { reresolveActor } from '@/auth/session'
import type { DbClient } from '@/db/client'
import { createLogger, type Logger } from '@/util/log'
import {
  checkUpgradeGate,
  erasedSpecOf,
  setExpiredCredentialHandler,
  type WsConnectionData,
} from './registry'

const live = new Set<ServerWebSocket<WsConnectionData>>()

/** Private WebSocket close codes (4000-4999) the frontend maps to user copy. */
export const WS_CLOSE_AUTH_REVOKED = 4401
export const WS_CLOSE_NOT_VISIBLE = 4403

import { registerRevalidationTrigger, type RevocationReason } from './revalidationHook'

export type { RevocationReason }

export interface RevalidateDeps {
  db: DbClient
  log: Logger
}

export interface RevalidateStats {
  scanned: number
  closedAuth: number
  closedGate: number
  refreshed: number
}

/** Called from `handleOpen`, before the channel subscribes. */
export function trackConnection(ws: ServerWebSocket<WsConnectionData>): void {
  live.add(ws)
}

/** Called from `handleClose`. Idempotent — a double close must not throw. */
export function untrackConnection(ws: ServerWebSocket<WsConnectionData>): void {
  live.delete(ws)
}

/**
 * Snapshot of the live set. A COPY: the rescan closes sockets while iterating,
 * and `handleClose` mutates `live` from under it.
 */
export function liveConnections(): ServerWebSocket<WsConnectionData>[] {
  return [...live]
}

export function liveConnectionCount(): number {
  return live.size
}

/**
 * Test-only reset. The set is process-global and `bun test --isolate` gives each
 * FILE a fresh module, but cases inside one file share it.
 */
export function resetConnectionsForTest(): void {
  live.clear()
}

/** Close a connection, dropping in-flight frames synchronously first. */
function closeConnection(
  ws: ServerWebSocket<WsConnectionData>,
  code: number,
  reason: string,
): void {
  // Order matters. `broadcaster.broadcast` is a synchronous for-of and Bun's
  // close callback (which untracks) is async, so a frame arriving between
  // ws.close() and that callback would still be delivered. Set `closing` and
  // unsubscribe SYNCHRONOUSLY here; the frame listener short-circuits on
  // `closing`, and untracking now (rather than waiting for handleClose) keeps
  // the rescan's own snapshot honest.
  ws.data.closing = true
  try {
    ws.data.unsubscribe()
  } catch {
    /* already gone */
  }
  untrackConnection(ws)
  try {
    ws.close(code, reason)
  } catch {
    /* socket already closed by the client */
  }
}

// RFC-212 T7 — the frame path (registry.ts) detects an expired credential but
// delegates the close here, where the close sequence lives. Registered at module
// load so registry.ts never needs to import this file (cycle-free).
setExpiredCredentialHandler((ws) => {
  closeConnection(ws, WS_CLOSE_AUTH_REVOKED, 'auth-expired')
})

/**
 * RFC-212 — re-check every live connection after a revocation. Runs in the
 * REVOKER's async context (NOT the broadcast path), so frame delivery is
 * untouched. For each connection:
 *   ① re-resolve the actor from its credential fingerprint (read-only)
 *   ② null → credential revoked/expired/user disabled → close(4401)
 *   ③ replace ws.data.actor so adminShortCircuit / permission gates see the new
 *      role — this is what makes a demotion take effect
 *   ④ clear the visibility cache (only meaningful for channels that have one)
 *   ⑤ if the channel declares rerunUpgradeGate, re-run it; fail → close(4403)
 * Fail-closed: a resolver that throws closes the socket as auth-revoked.
 */
export async function revalidateAllConnections(
  deps: RevalidateDeps,
  reason: RevocationReason,
  now: number = Date.now(),
): Promise<RevalidateStats> {
  const stats: RevalidateStats = { scanned: 0, closedAuth: 0, closedGate: 0, refreshed: 0 }
  // Snapshot: closeConnection mutates `live` while we iterate.
  for (const ws of liveConnections()) {
    if (ws.data.closing) continue
    stats.scanned += 1
    let freshActor
    try {
      freshActor = await reresolveActor(deps.db, ws.data.credential, now)
    } catch (err) {
      deps.log.warn('ws-revalidate-resolve-threw', {
        reason,
        err: err instanceof Error ? err.message : String(err),
      })
      freshActor = null
    }
    if (ws.data.closing) continue // a concurrent rescan may have closed it
    if (freshActor === null) {
      closeConnection(ws, WS_CLOSE_AUTH_REVOKED, 'auth-revoked')
      stats.closedAuth += 1
      continue
    }
    // ③ actor replacement — required for every channel (see ChannelRevalidation).
    ws.data.actor = freshActor
    stats.refreshed += 1
    // ④ cache clear — a no-op for channels that declare cache.kind === 'none'.
    const spec = erasedSpecOf(ws.data.channel.kind)
    if (spec.revalidation.cache.kind === 'prefixes') {
      ws.data.visibilityCache.clear()
    }
    // ⑤ re-run the whole-connection gate where the channel has one.
    if (spec.revalidation.rerunUpgradeGate === true) {
      let verdict
      try {
        verdict = await checkUpgradeGate(deps.db, freshActor, ws.data.channel)
      } catch (err) {
        deps.log.warn('ws-revalidate-gate-threw', {
          reason,
          err: err instanceof Error ? err.message : String(err),
        })
        verdict = { code: 'gate-threw', message: 'revalidation gate error' }
      }
      if (ws.data.closing) continue
      if (verdict !== true) {
        closeConnection(ws, WS_CLOSE_NOT_VISIBLE, verdict.code)
        stats.closedGate += 1
        continue
      }
    }
    // Survived the pass with a refreshed actor — unfreeze so the broadcast path
    // delivers again (impl-gate: the frame freeze is only for the pass duration).
    if (!ws.data.closing) ws.data.revalidating = false
  }
  if (stats.closedAuth > 0 || stats.closedGate > 0) {
    deps.log.info('ws-revalidate', { reason, ...stats })
  }
  return stats
}

const revalidateLog = createLogger('ws.revalidate')

// RFC-212 T6 — register the real trigger so revocation write points (which only
// import the light revalidationHook module) fan out here. Fire-and-forget: the
// write point does not wait for sockets to close. Tests drive
// revalidateAllConnections directly for determinism.
registerRevalidationTrigger((db, reason) => {
  // RFC-212 impl-gate (Codex 2026-07-22): SYNCHRONOUSLY freeze every live
  // connection BEFORE the async pass starts. The revocation write has already
  // committed by the time the trigger fires, so between here and each
  // connection's re-resolve the synchronous broadcast for-of must not deliver a
  // frame under the stale actor. `revalidating` is cleared per-connection by the
  // pass once its actor is refreshed (or the socket is closed).
  for (const ws of liveConnections()) {
    if (!ws.data.closing) ws.data.revalidating = true
  }
  void revalidateAllConnections({ db, log: revalidateLog }, reason).catch((err) => {
    revalidateLog.warn('ws-revalidate-threw', {
      reason,
      err: err instanceof Error ? err.message : String(err),
    })
  })
})
