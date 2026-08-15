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
import type { DbClient } from '@/db/client'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import type {
  AuthorizationSubjectRef,
  DelegatedSource,
} from '@/modules/identity-access/public/participants'
import { UserAccessError } from '@/modules/identity-access/public/types'
import { UnauthorizedError } from '@/util/errors'
import { SYSTEM_USER_ID } from './systemIdentity'

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
  // RFC-247 — a token's grant set is computed by ONE function in shared
  // (resolveTokenPermissions); this file must not reimplement any part of it.
  //
  // Three behaviour changes vs RFC-036/RFC-222, all deliberate:
  //  1. The `patScopes.length > 0` short-circuit is GONE. It meant an
  //     empty-scoped PAT silently inherited the owner's ENTIRE account authority
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
        accountPermissions,
        matrix: opts.patScopes ?? [],
      }),
      purpose: opts.patPurpose ?? 'mcp_only',
      patId: opts.patId,
      authorityRevision: opts.authorityRevision ?? 0,
    }
  }
  return {
    user: opts.user,
    source: opts.source,
    permissions: accountPermissions,
    authorityRevision: opts.authorityRevision ?? 0,
  }
}

export function actorOf(c: Context): Actor {
  const actor = c.get('actor') as Actor | undefined
  if (!actor) throw new UnauthorizedError('no actor on context')
  return actor
}

/** RFC-305 single current-account adapter for session, PAT, daemon and
 * delegated authority. It re-reads role, status, grants and revision through
 * identity-access instead of trusting a credential-time user snapshot. */
export async function buildCurrentActor(
  db: DbClient,
  input: {
    readonly userId: string
    readonly source: ActorSource
    readonly patScopes?: ReadonlyArray<Permission>
    readonly patPurpose?: PatPurpose
    readonly patId?: string
  },
): Promise<Actor | null> {
  const current = await composeIdentityAccess(db).resolveAuthority.execute(input.userId)
  if (current === null) return null
  return buildActor({
    user: {
      id: current.userId,
      username: current.username,
      displayName: current.displayName,
      role: current.role,
      status: current.status,
    },
    source: input.source,
    patScopes: input.patScopes,
    patPurpose: input.patPurpose,
    patId: input.patId,
    additionalPermissions: current.additionalPermissions,
    authorityRevision: current.accessRevision,
  })
}

/**
 * RFC-285 B3（D7）—— 后台代表 owner 行事时的**唯一** actor 重建入口：
 * scheduled 定时触发与 call-workflow / call-workgroup 子任务新启三臂共用
 * （三份手工 rebuild → 1；此前 call 臂用 `as unknown as` 伪造无权限幽灵）。
 *
 * 判定归此、错误形态归调用方：
 * - owner 行存在且 active → 以真实用户行重建（source='daemon'，当前有效权限）。
 * - owner 失活 / 行缺失 → **null**（scheduled 臂抛 `owner-inactive`、call 新启
 *   臂抛 `call-owner-inactive`；resume 臂按 Q6 豁免不经此检查）。
 * - ownerUserId 为 NULL（legacy 任务）→ **Q5 拍板放行**：返回 `__system__`
 *   幽灵 actor（空权限集——无 owner 可判失活，也绝不扩权）。
 * - ownerUserId 为字符串 `'__system__'`（daemon-token 启动的任务）→ 走**真身
 *   查行**臂：解析出 `__system__` 用户行（role=admin）。这是有意的行为变化
 *   （实现门路 2 P3-3 确认）：旧 `as unknown as` 伪造对该值给空权限幽灵，
 *   现在系统自有任务的子调用以系统身份行事更自洽；普通 session/PAT 无法把
 *   任务 owner 写成 `__system__`，无越权面。「空幽灵」语义只属 NULL 臂。
 */
export async function buildInheritedActor(
  db: DbClient,
  ownerUserId: string | null,
  delegatedSource?: DelegatedSource,
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
      authorityRevision: 0,
    }
  }
  if (delegatedSource !== undefined) {
    try {
      await composeIdentityAccess(db).delegatedAuthority.resolve(
        delegatedSource,
        Object.freeze({ userId: ownerUserId }) as AuthorizationSubjectRef,
      )
    } catch (error) {
      if (error instanceof UserAccessError && error.code === 'delegated-subject-inactive') {
        return null
      }
      throw error
    }
  }
  return buildCurrentActor(db, { userId: ownerUserId, source: 'daemon' })
}

/** Optional variant — handlers that may be called outside an auth scope (none yet, but exposed for tests). */
export function tryActorOf(c: Context): Actor | null {
  return (c.get('actor') as Actor | undefined) ?? null
}
