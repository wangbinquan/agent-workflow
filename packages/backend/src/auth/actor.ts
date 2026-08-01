// RFC-036 — Actor type + helpers. Resolved by auth/session.ts multiAuth and
// stored on the Hono context via `c.set('actor', actor)`. Services / route
// handlers call actorOf(c) to access the current identity.

import type { Context } from 'hono'
import {
  resolveTokenPermissions,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import { UnauthorizedError } from '@/util/errors'

export interface ActorUser {
  id: string
  username: string
  displayName: string
  role: Role
  status: 'active' | 'disabled' | 'invited'
}

export type ActorSource = 'session' | 'pat' | 'daemon'

export interface Actor {
  user: ActorUser
  source: ActorSource
  /** Already-resolved permission set: role baseline ∩ (PAT scopes if source='pat'). */
  permissions: ReadonlySet<Permission>
}

export const SYSTEM_USER_ID = '__system__'

export function buildActor(opts: {
  user: ActorUser
  source: ActorSource
  patScopes?: ReadonlyArray<Permission>
}): Actor {
  // RFC-247 — a token's grant set is computed by ONE function in shared
  // (resolveTokenPermissions); this file must not reimplement any part of it.
  //
  // Three behaviour changes vs RFC-036/RFC-222, all deliberate:
  //  1. The `patScopes.length > 0` short-circuit is GONE. It meant an
  //     empty-scoped PAT silently inherited the owner's ENTIRE role baseline
  //     (docs/audit-backlog.md:61). An empty matrix now yields a READ-ONLY
  //     token, which is also what the account page promises.
  //  2. Reads are always granted (RFC-247 D3) rather than having to be ticked.
  //  3. Delete points are stripped unless the matrix names them — generalised
  //     from RFC-222's hand-listed PAT_EXPLICIT_ONLY_PERMISSIONS to every
  //     `:delete` point, so a new resource type cannot widen a historical token.
  if (opts.source === 'pat') {
    return {
      user: opts.user,
      source: opts.source,
      permissions: resolveTokenPermissions({
        role: opts.user.role,
        matrix: opts.patScopes ?? [],
      }),
    }
  }
  return {
    user: opts.user,
    source: opts.source,
    permissions: new Set(ROLE_PERMISSIONS[opts.user.role]),
  }
}

export function actorOf(c: Context): Actor {
  const actor = c.get('actor') as Actor | undefined
  if (!actor) throw new UnauthorizedError('no actor on context')
  return actor
}

/** Optional variant — handlers that may be called outside an auth scope (none yet, but exposed for tests). */
export function tryActorOf(c: Context): Actor | null {
  return (c.get('actor') as Actor | undefined) ?? null
}
