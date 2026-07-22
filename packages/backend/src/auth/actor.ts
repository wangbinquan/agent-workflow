// RFC-036 — Actor type + helpers. Resolved by auth/session.ts multiAuth and
// stored on the Hono context via `c.set('actor', actor)`. Services / route
// handlers call actorOf(c) to access the current identity.

import type { Context } from 'hono'
import {
  PAT_EXPLICIT_ONLY_PERMISSIONS,
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
  const rolePerms = ROLE_PERMISSIONS[opts.user.role]
  let set: Set<Permission>
  if (opts.source === 'pat' && opts.patScopes && opts.patScopes.length > 0) {
    // PAT narrows the role baseline; never widens it.
    const baseline = new Set(rolePerms)
    set = new Set(opts.patScopes.filter((p) => baseline.has(p)))
  } else {
    set = new Set(rolePerms)
  }
  // RFC-222 (P1-3): explicit-only permissions never ride the role baseline into
  // a PAT. Even an empty-scoped PAT (which otherwise inherits the full role
  // baseline via the else-branch above) must name them, else they're stripped.
  // Protects high-blast-radius points (tasks:delete) from silently widening a
  // historical token as the catalog grows. Session/daemon actors are untouched.
  if (opts.source === 'pat') {
    for (const perm of PAT_EXPLICIT_ONLY_PERMISSIONS) {
      if (!(opts.patScopes?.includes(perm) ?? false)) set.delete(perm)
    }
  }
  return { user: opts.user, source: opts.source, permissions: set }
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
