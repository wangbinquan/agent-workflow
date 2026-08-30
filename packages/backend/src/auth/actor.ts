// RFC-036 — Actor type + helpers. Resolved by auth/session.ts multiAuth and
// stored on the Hono context via `c.set('actor', actor)`. Services / route
// handlers call actorOf(c) to access the current identity.

import type { Context } from 'hono'
import {
  resolveEffectiveAccountPermissions,
  resolveTokenPermissions,
  type PatPurpose,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import { UnauthorizedError } from '@/util/errors'

export { SYSTEM_USER_ID } from './systemIdentity'

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
  /** Already-resolved effective account permissions, narrowed by PAT scopes for PAT actors. */
  permissions: ReadonlySet<Permission>
  /**
   * RFC-247 D2 — present only for `source: 'pat'`. Kept on the actor rather than
   * re-read per request so the purpose gate is a field comparison instead of
   * another DB round trip on every call.
   */
  purpose?: PatPurpose
  /**
   * RFC-247 D16 — which token this is, for the call audit. Present only for
   * `source: 'pat'`. The audit is keyed on the TOKEN rather than the user: two
   * of someone's tokens doing different things is precisely the distinction an
   * operator is trying to make when they open the log.
   */
  patId?: string
  /** RFC-305 OCC/revalidation fence for role + per-account grants. */
  authorityRevision?: number
}

export function buildActor(opts: {
  user: ActorUser
  source: ActorSource
  patScopes?: ReadonlyArray<Permission>
  patPurpose?: PatPurpose
  patId?: string
  additionalPermissions?: ReadonlyArray<Permission>
  authorityRevision?: number
}): Actor {
  const accountPermissions = resolveEffectiveAccountPermissions({
    role: opts.user.role,
    additionalPermissions: opts.additionalPermissions ?? [],
  })
  const permissions =
    opts.source === 'pat'
      ? resolveTokenPermissions({
          accountPermissions,
          matrix: opts.patScopes ?? [],
        })
      : accountPermissions
  return Object.freeze({
    user: Object.freeze({ ...opts.user }),
    source: opts.source,
    permissions,
    ...(opts.source === 'pat'
      ? {
          purpose: opts.patPurpose ?? ('mcp_only' as const),
          ...(opts.patId === undefined ? {} : { patId: opts.patId }),
        }
      : {}),
    authorityRevision: opts.authorityRevision ?? 0,
  })
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
