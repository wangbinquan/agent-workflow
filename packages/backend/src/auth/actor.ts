// RFC-036 — Actor type + helpers. Resolved by auth/session.ts multiAuth and
// stored on the Hono context via `c.set('actor', actor)`. Services / route
// handlers call actorOf(c) to access the current identity.

import type { Context } from 'hono'
import {
  resolveTokenPermissions,
  ROLE_PERMISSIONS,
  type PatPurpose,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { users } from '@/db/schema'
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
}

export const SYSTEM_USER_ID = '__system__'

export function buildActor(opts: {
  user: ActorUser
  source: ActorSource
  patScopes?: ReadonlyArray<Permission>
  patPurpose?: PatPurpose
  patId?: string
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
      purpose: opts.patPurpose ?? 'mcp_only',
      patId: opts.patId,
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

/**
 * RFC-285 B3（D7）—— 后台代表 owner 行事时的**唯一** actor 重建入口：
 * scheduled 定时触发与 call-workflow / call-workgroup 子任务新启三臂共用
 * （三份手工 rebuild → 1；此前 call 臂用 `as unknown as` 伪造无权限幽灵）。
 *
 * 判定归此、错误形态归调用方：
 * - owner 行存在且 active → 以真实用户行重建（source='daemon'，角色基线权限）。
 * - owner 失活 / 行缺失 → **null**（scheduled 臂抛 `owner-inactive`、call 新启
 *   臂抛 `call-owner-inactive`；resume 臂按 Q6 豁免不经此检查）。
 * - ownerUserId 为 NULL（legacy 任务）→ **Q5 拍板放行**：返回 `__system__`
 *   幽灵 actor（空权限集，与历史伪造形态语义一致——无 owner 可判失活，
 *   也绝不扩权）。
 */
export async function buildInheritedActor(
  db: DbClient,
  ownerUserId: string | null,
): Promise<Actor | null> {
  if (ownerUserId === null) {
    return {
      user: {
        id: SYSTEM_USER_ID,
        username: SYSTEM_USER_ID,
        displayName: SYSTEM_USER_ID,
        role: 'user',
        status: 'active',
      },
      source: 'daemon',
      permissions: new Set(),
    }
  }
  const owner = (await db.select().from(users).where(eq(users.id, ownerUserId)).limit(1))[0]
  if (!owner || owner.status !== 'active') return null
  return buildActor({
    user: {
      id: owner.id,
      username: owner.username,
      displayName: owner.displayName,
      role: owner.role,
      status: owner.status,
    },
    source: 'daemon',
  })
}

/** Optional variant — handlers that may be called outside an auth scope (none yet, but exposed for tests). */
export function tryActorOf(c: Context): Actor | null {
  return (c.get('actor') as Actor | undefined) ?? null
}
