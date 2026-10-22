// RFC-359 W4-D27 —— 事务内的资源可见性判据：一份实现，两个引擎共用。
//
// 蓝本是 `composition/resourceAcl.ts` 的同步 `canViewResourceInTx`（跑得最久的那条）：
// 先取 audience 权威，只有「非 bypass 且私有」才去查这一行对该用户的授权级别，
// 再交给 `resolveAccessFrom` / `canViewAccess` 判定。合一前 PostgreSQL 侧在
// `postgresqlTaskExecutionResourceSnapshots.ts` 里内联了一份逐字等价的副本；现在两边都用这一份。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { and, eq } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import {
  canViewAccess,
  resolveAccessFrom,
  resourceAclAudienceAuthority,
  type AclRow,
} from '../domain/resourceAccess'
import type { AclResourceType } from '@agent-workflow/shared'

/** 该 actor 对这一行的访问级别；私有行才需要读授权表。 */
export async function resolveResourceAccessForTx(
  tx: PersistenceTx,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<ReturnType<typeof resolveAccessFrom>> {
  const audience = resourceAclAudienceAuthority(actor)
  const { resourceGrants } = tablesOf(tx)
  const grant =
    audience.bypass || !audience.private
      ? null
      : ((
          await first(
            tx
              .select({ level: resourceGrants.level })
              .from(resourceGrants)
              .where(
                and(
                  eq(resourceGrants.resourceType, type),
                  eq(resourceGrants.resourceId, row.id),
                  eq(resourceGrants.userId, actor.user.id),
                ),
              )
              .limit(1),
          )
        )?.level ?? null)
  return resolveAccessFrom(audience, actor.user.id, row, grant)
}

export async function canViewResourceForTx(
  tx: PersistenceTx,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<boolean> {
  return canViewAccess(await resolveResourceAccessForTx(tx, actor, type, row))
}
