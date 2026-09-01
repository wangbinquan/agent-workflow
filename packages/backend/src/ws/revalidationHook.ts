// RFC-212 T6 — indirection so credential/authorization write points can fire a
// WS revalidation WITHOUT importing `connections.ts`.
//
// A direct import would form a module cycle: sessionStore → connections →
// auth/session → sessionStore, which the single-binary build is sensitive to
// (see memory reference_binary_build_module_cycle). This module imports nothing
// heavy; `connections.ts` registers the real implementation at load, and the
// daemon loads it via `ws/server.ts` at boot. Before registration (e.g. a unit
// test that never boots the WS server) there are no live connections to revalidate.

export type RevocationReason =
  | 'session-revoked'
  | 'sessions-revoked-bulk'
  | 'pat-revoked'
  | 'identity-deleted'
  | 'user-patched'
  | 'user-disabled'
  | 'task-members-changed'
  | 'resource-acl-changed'
  | 'bootstrap-completed'
  | 'authority-changed'

export interface RevalidationTarget {
  readonly userId: string
  readonly revision: number
}

type TriggerImpl = (reason: RevocationReason, target?: RevalidationTarget) => Promise<void>

let impl: TriggerImpl | undefined

export function registerRevalidationTrigger(fn: TriggerImpl): void {
  impl = fn
}

/**
 * Fire a WS revalidation after a revocation. MUST be called after the write
 * commits (design §4): the rescan re-reads provider persistence, so firing before commit would
 * read the pre-revocation state and leave the connection alive. It stays dormant
 * until the WS server has registered its implementation.
 */
export function triggerRevalidation(reason: RevocationReason): void {
  void impl?.(reason).catch(() => {
    // The registered implementation logs and fails closed. This terminal catch
    // protects fire-and-forget callers from an unhandled rejection.
  })
}

/** RFC-244: awaited variant for audience-transition notifications. */
export function triggerRevalidationAndWait(reason: RevocationReason): Promise<void> {
  return impl?.(reason) ?? Promise.resolve()
}

/** RFC-305 targeted account-authority refresh. The commit is already durable;
 * only sockets for the changed subject are frozen and re-resolved. */
export function triggerAuthorityRevalidation(
  userId: string,
  revision: number,
  onFailure?: (error: unknown) => void,
): void {
  void impl?.('authority-changed', { userId, revision }).catch((error: unknown) => {
    // Registered implementation fails closed for every targeted socket.
    onFailure?.(error)
  })
}
