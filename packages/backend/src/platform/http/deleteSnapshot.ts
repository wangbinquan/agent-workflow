// RFC-247 AC-20 — hold one pre-delete row until the post-response token-call audit consumes it.
//
// A delete handler captures the row after loading it and before removing it. The token-call audit
// takes it once the handler has answered: the `/api/*` audit middleware in `server.ts`, or the
// bound operation invoker when MCP drives the same handler. Both sides must reach the SAME
// `WeakMap`, keyed by the request's Hono context, so this file is the only place the snapshot
// lives. Only PAT calls are audited, so only PAT callers pay the allocation.
//
// RFC-440: this is request-local transport state, so it lives in platform/http. It used to sit
// in the `services/tokenAudit` compatibility facade, which is gone.

import type { Context } from 'hono'

import type { Actor } from '@/auth/actor'

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
