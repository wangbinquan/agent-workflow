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
import type { WsConnectionData } from './registry'

const live = new Set<ServerWebSocket<WsConnectionData>>()

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
