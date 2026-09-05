// RFC-247 compatibility surface for token-call auditing.
//
// Provider SQL and retention mechanics now live behind the closed AUTH
// participant (one implementation for both providers, RFC-359 W4-D9). Existing
// db-parameter callers keep their signatures until bootstrap injects the
// participant directly; this file owns only request-local snapshot capture plus
// thin delegation.

import type { Context } from 'hono'

import type { Actor } from '@/auth/actor'
import { legacyTokenCallAudit } from '@/auth/composition'

export {
  TOKEN_AUDIT_PRUNE_BATCH,
  redactSnapshot,
  type TokenAuditChannel,
  type TokenAuditPruneCursorV1,
  type TokenAuditPruneSliceResult,
  type TokenAuditRecord,
  type TokenCallAuditParticipant,
  type TokenCallRecord,
} from '@/auth/application/tokenCallAudit'

/**
 * RFC-247 AC-20 — hold one pre-delete row until the post-response audit hook
 * consumes it. Only PAT callers pay the allocation.
 */
const pendingSnapshots = new WeakMap<object, unknown>()

/** Call from a delete route AFTER loading the row and BEFORE removing it. */
export function captureDeleteSnapshot(c: Context, actor: Actor, row: unknown): void {
  if (actor.source !== 'pat') return
  pendingSnapshots.set(c, row)
}

/** Consume it. Returns undefined when the route captured nothing. */
export function takeDeleteSnapshot(c: Context): unknown {
  const row = pendingSnapshots.get(c)
  if (row !== undefined) pendingSnapshots.delete(c)
  return row
}

export function recordTokenCall(
  ...args: Parameters<typeof legacyTokenCallAudit.record>
): ReturnType<typeof legacyTokenCallAudit.record> {
  return legacyTokenCallAudit.record(...args)
}

export function listTokenAuditForUser(
  ...args: Parameters<typeof legacyTokenCallAudit.listForUser>
): ReturnType<typeof legacyTokenCallAudit.listForUser> {
  return legacyTokenCallAudit.listForUser(...args)
}

export function listTokenAudit(
  ...args: Parameters<typeof legacyTokenCallAudit.list>
): ReturnType<typeof legacyTokenCallAudit.list> {
  return legacyTokenCallAudit.list(...args)
}

export function pruneTokenAudit(
  ...args: Parameters<typeof legacyTokenCallAudit.prune>
): ReturnType<typeof legacyTokenCallAudit.prune> {
  return legacyTokenCallAudit.prune(...args)
}

export function pruneTokenAuditSlice(
  ...args: Parameters<typeof legacyTokenCallAudit.pruneSlice>
): ReturnType<typeof legacyTokenCallAudit.pruneSlice> {
  return legacyTokenCallAudit.pruneSlice(...args)
}
