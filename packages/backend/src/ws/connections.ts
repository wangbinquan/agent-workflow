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
// frame forwards" / "aclBypassShortCircuit sends synchronously") assert that frames
// are delivered without ever awaiting. To rescan on revocation we need one flat
// set of live connections; that is this file. Deliberately NOT a reverse index
// (user→conn, task→conn): the rescan is coarse, so a single set suffices and
// there is nothing per-revocation-kind to keep in sync.
//
// PR-1 ships only the bookkeeping (this file + the two hook calls). The rescan
// itself lands in PR-2 so the infrastructure can be reviewed with zero
// behavioural change.

import type { ServerWebSocket } from 'bun'
import type { WsControlMessage } from '@agent-workflow/shared'
import type { DirectAuthorityIdentity } from '@/modules/identity-access/public/participants'
import type { RealtimeCredentialAccess } from '@/modules/runtime-management/public/participants'
import { createLogger, type Logger } from '@/util/log'
import {
  checkUpgradeGate,
  releasePresence,
  erasedSpecOf,
  setExpiredCredentialHandler,
  type WsConnectionData,
  type WsCredential,
} from './registry'

const live = new Set<ServerWebSocket<WsConnectionData>>()

// RFC-212 impl-gate finding 2 (Codex 2026-07-22): a monotonic counter bumped on
// every revocation. A connection captures it at the START of its upgrade (before
// resolveActor); if it differs by the time the connection is tracked, a
// revocation raced the upgrade and this connection — resolved with a possibly
// stale actor and NOT seen by that rescan's live snapshot — must be re-checked.
let revalidationEpoch = 0
export function currentRevalidationEpoch(): number {
  return revalidationEpoch
}

/** Private WebSocket close codes (4000-4999) the frontend maps to user copy. */
export const WS_CLOSE_AUTH_REVOKED = 4401
export const WS_CLOSE_NOT_VISIBLE = 4403

import {
  registerRevalidationTrigger,
  type RevalidationTarget,
  type RevocationReason,
} from './revalidationHook'

export type { RevocationReason }

export interface RevalidateDeps {
  log: Logger
}

export interface RevalidateStats {
  scanned: number
  closedAuth: number
  closedGate: number
  refreshed: number
}

function credentialRevalidationKey(credential: WsCredential): string {
  return credential.kind === 'daemon' ? 'daemon' : `${credential.kind}\u0000${credential.hash}`
}

/** Called from `handleOpen`, before the channel subscribes. */
export function trackConnection(ws: ServerWebSocket<WsConnectionData>): void {
  live.add(ws)
}

/** Called from `handleClose`. Idempotent — a double close must not throw. */
export function untrackConnection(ws: ServerWebSocket<WsConnectionData>): void {
  live.delete(ws)
  releasePresence(ws)
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
export function closeConnection(
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
 *   ③ replace ws.data.actor so ACL-bypass / permission gates see the new
 *      effective permission set
 *   ④ clear the visibility cache (only meaningful for channels that have one)
 *   ⑤ if the channel declares rerunUpgradeGate, re-run it; fail → close(4403)
 * Fail-closed: a resolver that throws closes the socket as auth-revoked.
 */
export async function revalidateAllConnections(
  deps: RevalidateDeps,
  reason: RevocationReason,
  now: number = Date.now(),
  target?: RevalidationTarget,
): Promise<RevalidateStats> {
  const stats: RevalidateStats = { scanned: 0, closedAuth: 0, closedGate: 0, refreshed: 0 }
  // One pass observes one committed provider snapshot at one `now`. Connections
  // carrying the same credential therefore have the same actor verdict.
  // Resolve that credential once while still running every socket's cache
  // clear, upgrade gate, notification and close decision below.
  const identityByRuntime = new Map<
    RealtimeCredentialAccess,
    Map<string, Promise<DirectAuthorityIdentity | null>>
  >()
  // Snapshot: closeConnection mutates `live` while we iterate.
  for (const ws of liveConnections()) {
    if (ws.data.closing) continue
    if (target !== undefined && ws.data.actor.user.id !== target.userId) continue
    stats.scanned += 1
    let freshIdentity
    try {
      const credentialKey = credentialRevalidationKey(ws.data.credential)
      let identityByCredential = identityByRuntime.get(ws.data.credentials)
      if (identityByCredential === undefined) {
        identityByCredential = new Map()
        identityByRuntime.set(ws.data.credentials, identityByCredential)
      }
      let resolution = identityByCredential.get(credentialKey)
      if (resolution === undefined) {
        resolution = ws.data.credentials.reresolve(ws.data.credential, now)
        identityByCredential.set(credentialKey, resolution)
      }
      freshIdentity = await resolution
    } catch (err) {
      deps.log.warn('ws-revalidate-resolve-threw', {
        reason,
        err: err instanceof Error ? err.message : String(err),
      })
      freshIdentity = null
    }
    if (ws.data.closing) continue // a concurrent rescan may have closed it
    if (freshIdentity === null) {
      closeConnection(ws, WS_CLOSE_AUTH_REVOKED, 'auth-revoked')
      stats.closedAuth += 1
      continue
    }
    // ③ actor replacement — required for every channel (see ChannelRevalidation).
    ws.data.actor = freshIdentity.actor
    ws.data.authority = freshIdentity.authority
    stats.refreshed += 1
    // ④ cache clear — a no-op for channels that declare cache.kind === 'none'.
    const spec = erasedSpecOf(ws.data.channel.kind)
    if (spec.revalidation.cache.kind === 'prefixes') {
      ws.data.visibilityCache.clear()
    }
    // Notify while the freshly resolved credential is still connected. A
    // revocation can make the channel's own gate fail below; sending first lets
    // the app-wide authority socket refresh navigation and route guards even
    // when this particular business socket is about to close with 4403.
    if (reason === 'authority-changed') {
      sendAuthorityChanged(ws, ws.data.actor.authorityRevision ?? target?.revision ?? 0)
      if (ws.data.closing) continue
    }
    // RFC-324 —— 授权面变了。重扫本身只做「这条连接还能不能留着」，对**降档**
    // （write → read，仍然看得见）什么也不做，于是被降档的人会一直停在可编辑的
    // 界面上，直到他自己刷新——而他没有任何理由去刷新。这一帧就是缺的那个信号。
    if (reason === 'resource-acl-changed') {
      sendResourceAclChanged(ws)
      if (ws.data.closing) continue
    }
    // ⑤ re-run the whole-connection gate where the channel has one.
    if (spec.revalidation.rerunUpgradeGate === true) {
      let verdict
      try {
        verdict = await checkUpgradeGate(ws.data.channels, ws.data.actor, ws.data.channel)
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
    if (!ws.data.closing) {
      ws.data.revalidating = false
      // RFC-312 实现门 P1 —— 冻结期间到达的帧是被**丢弃**的，不是排队。累积式增量流
      // （presence）因此会永久停在旧状态。让通道自己声明如何重同步（数据而非分支）；
      // 没有累积状态的通道不实现该钩子，行为逐字不变。
      erasedSpecOf(ws.data.channel.kind).resync?.(ws)
    }
  }
  if (stats.closedAuth > 0 || stats.closedGate > 0) {
    deps.log.info('ws-revalidate', { reason, ...stats })
  }
  return stats
}

function sendAuthorityChanged(ws: ServerWebSocket<WsConnectionData>, revision: number): void {
  const frame: WsControlMessage = { type: 'authority.changed', revision }
  try {
    // RFC-312 实现门 P2 —— Bun 用**返回 0 表示这一帧被丢弃**（背压 / 已关闭）。此前只
    // catch 异常，于是"通知被丢"与"通知送达"不可分：客户端收不到失效信号、`/me` 不刷新，
    // 却又因为不认 4403 而一路重连。丢弃与抛出后果相同，处置也相同——按本函数既有裁决
    // 关掉连接，让客户端重连并重新解析权限。
    if (ws.send(JSON.stringify(frame)) === 0) {
      closeConnection(ws, WS_CLOSE_AUTH_REVOKED, 'authority-notification-dropped')
    }
  } catch {
    closeConnection(ws, WS_CLOSE_AUTH_REVOKED, 'authority-notification-failed')
  }
}

/**
 * RFC-324 —— 通知客户端让本地的授权判定失效。
 *
 * 丢帧的处置比 `authority.changed` 轻：那条丢了意味着客户端会拿着已撤销的权限继续
 * 渲染导航与路由守卫，所以要关连接逼它重连；这条丢了只意味着某个页面的只读态晚到
 * 一次交互——把连接关掉（进而触发重连风暴）是比问题本身更大的代价。客户端在重连
 * 后本来就会重新拉取，所以这里吞掉即可。
 */
function sendResourceAclChanged(ws: ServerWebSocket<WsConnectionData>): void {
  const frame: WsControlMessage = { type: 'resource-acl.changed' }
  try {
    ws.send(JSON.stringify(frame))
  } catch {
    /* 背压或已关闭：重连后客户端自会重新解析，不值得为此关掉连接 */
  }
}

const revalidateLog = createLogger('ws.revalidate')

// RFC-212 T6 — register the real trigger so revocation write points (which only
// import the light revalidationHook module) fan out here. Fire-and-forget: the
// write point does not wait for sockets to close. Tests drive
// revalidateAllConnections directly for determinism.
registerRevalidationTrigger((reason, target) => {
  // finding 2: bump the epoch FIRST so an upgrade in flight (which already
  // captured the old epoch) can detect that it raced this revocation.
  revalidationEpoch += 1
  // RFC-212 impl-gate (Codex 2026-07-22): SYNCHRONOUSLY freeze every live
  // connection BEFORE the async pass starts. The revocation write has already
  // committed by the time the trigger fires, so between here and each
  // connection's re-resolve the synchronous broadcast for-of must not deliver a
  // frame under the stale actor. `revalidating` is cleared per-connection by the
  // pass once its actor is refreshed (or the socket is closed).
  const frozen = liveConnections().filter(
    (ws) => target === undefined || ws.data.actor.user.id === target.userId,
  )
  for (const ws of frozen) {
    if (!ws.data.closing) ws.data.revalidating = true
  }
  return revalidateAllConnections({ log: revalidateLog }, reason, Date.now(), target)
    .then(() => undefined)
    .catch((err) => {
      revalidateLog.warn('ws-revalidate-threw', {
        reason,
        err: err instanceof Error ? err.message : String(err),
      })
      // A failed pass must never leave a live socket frozen indefinitely or
      // restore it under an actor we did not finish checking. Fail closed for
      // every connection captured by this trigger that is still unresolved.
      for (const ws of frozen) {
        if (!ws.data.closing && ws.data.revalidating) {
          closeConnection(ws, WS_CLOSE_AUTH_REVOKED, 'auth-revalidation-failed')
        }
      }
      // Legacy fire-and-forget callers suppress this after the fail-closed
      // cleanup. Targeted RFC-305 callers attach an onFailure observer and
      // must receive the failure for health diagnostics.
      throw err
    })
})
