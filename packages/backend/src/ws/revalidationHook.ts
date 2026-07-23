// RFC-212 T6 — indirection so credential/authorization write points can fire a
// WS revalidation WITHOUT importing `connections.ts`.
//
// A direct import would form a module cycle: sessionStore → connections →
// auth/session → sessionStore, which the single-binary build is sensitive to
// (see memory reference_binary_build_module_cycle). This module imports nothing
// heavy; `connections.ts` registers the real implementation at load, and the
// daemon loads it via `ws/server.ts` at boot. Before registration (e.g. a unit
// test that never boots the WS server) the trigger is a safe no-op — there are
// no live connections to revalidate anyway.

import type { DbClient } from '@/db/client'

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

type TriggerImpl = (db: DbClient, reason: RevocationReason) => void

let impl: TriggerImpl | undefined

export function registerRevalidationTrigger(fn: TriggerImpl): void {
  impl = fn
}

/**
 * Fire a WS revalidation after a revocation. MUST be called after the write
 * commits (design §4): the rescan re-reads the DB, so firing before commit would
 * read the pre-revocation state and leave the connection alive. No-op until the
 * WS server has registered its implementation.
 */
export function triggerRevalidation(db: DbClient, reason: RevocationReason): void {
  impl?.(db, reason)
}
