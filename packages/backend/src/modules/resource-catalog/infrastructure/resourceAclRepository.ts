// RFC-359 W4-D3 —— resource-catalog 自有 ACL 类型的写端口：一份实现，两个 provider 共用。
// identity 行的 CAS（aclRevision）、grants 整体替换与 owner 侧的 after-write 钩子在同一个目录写事务原语里
// （SERIALIZABLE：PG 抬升隔离级别并重试，SQLite 独占事务）。owner + name 撞库经引擎能力矩阵归类。

import type { AclResourceType } from '@agent-workflow/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { resourceGrants, users } from '@/db/schema'
import { postgresqlUniqueViolationConstraint } from '@/platform/persistence/capabilities'
import { engineOf, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { ConflictError } from '@/util/errors'
import type {
  ResourceCatalogAclMutationChange,
  ResourceCatalogAclMutationPort,
} from '../application/ports/providerResourceCatalogPersistence'
import { OWNER_NAME_UNIQUE_CONSTRAINTS, OWNER_NAME_UNIQUE_TYPES } from './aclRegistry'
import { ownedAclTable } from './aclReadRepository'
import { runResourceCatalogTransaction } from './resourceCatalogTransaction'

export interface ResourceAclMutationLifecycle {
  afterWriteInTransaction?(
    transaction: DatabaseTransaction,
    change: ResourceCatalogAclMutationChange<AclResourceType>,
  ): Promise<void> | void
}

/**
 * owner + name 唯一键撞库：先经能力矩阵判定是不是唯一冲突，再核对约束名（PG 带约束名；SQLite 的驱动错误
 * 只有一句 `UNIQUE constraint failed: <table>.<col>`，没有约束名——与此前 SQLite 侧的判据一致，视为撞库）。
 */
export function isOwnerNameConstraintError(db: ProviderNeutralDatabase, error: unknown): boolean {
  if (engineOf(db).classifyError(error) !== 'unique-violation') return false
  const constraint = postgresqlUniqueViolationConstraint(error)
  return (
    constraint === undefined ||
    (OWNER_NAME_UNIQUE_CONSTRAINTS as readonly string[]).includes(constraint)
  )
}

export function createResourceAclMutationPort(
  db: ProviderNeutralDatabase,
  lifecycle: ResourceAclMutationLifecycle = {},
): ResourceCatalogAclMutationPort<AclResourceType> {
  const port: ResourceCatalogAclMutationPort<AclResourceType> = {
    async mutate(request, decide) {
      const table = ownedAclTable(request.type)
      return runResourceCatalogTransaction(db, async (transaction) => {
        const current = (
          await transaction
            .select({
              id: table.id,
              name: table.name,
              ownerUserId: table.ownerUserId,
              visibility: table.visibility,
              aclRevision: table.aclRevision,
            })
            .from(table)
            .where(eq(table.id, request.resourceId))
            .limit(1)
        )[0]
        if (current === undefined) return undefined

        const grantRows = await transaction
          .select({ userId: resourceGrants.userId, level: resourceGrants.level })
          .from(resourceGrants)
          .where(
            and(
              eq(resourceGrants.resourceType, request.type),
              eq(resourceGrants.resourceId, request.resourceId),
            ),
          )
        const currentGrants = new Map(
          grantRows.map((grant) => [grant.userId, grant.level] as const),
        )

        const activeRows =
          request.referencedUserIds.length === 0
            ? []
            : await transaction
                .select({ id: users.id })
                .from(users)
                .where(
                  and(
                    inArray(users.id, [...request.referencedUserIds]),
                    eq(users.status, 'active'),
                  ),
                )
        const candidateOwner = request.candidateOwnerUserId
        const ownerNameIsUnique = (OWNER_NAME_UNIQUE_TYPES as ReadonlySet<AclResourceType>).has(
          request.type,
        )
        const collision =
          typeof candidateOwner === 'string' && ownerNameIsUnique
            ? (
                await transaction
                  .select({ id: table.id })
                  .from(table)
                  .where(
                    and(
                      eq(table.ownerUserId, candidateOwner),
                      eq(table.name, current.name),
                      ne(table.id, request.resourceId),
                    ),
                  )
                  .limit(1)
              )[0]
            : undefined
        const decision = decide({
          current,
          ownerNameIsUnique,
          ownerNameCollision: collision !== undefined,
          activeUserIds: new Set(activeRows.map((row) => row.id)),
          currentGrants,
          actorGrantLevel: currentGrants.get(request.actorUserId) ?? null,
        })

        // identity 行的 CAS：aclRevision 变了就是有人先写了，整个事务回滚。
        const updated = await transaction
          .update(table)
          .set(decision.update)
          .where(and(eq(table.id, request.resourceId), eq(table.aclRevision, current.aclRevision)))
          .returning({ id: table.id })
        if (updated.length === 0) {
          throw new ConflictError(
            'acl-revision-conflict',
            'resource ACL changed while saving; reload and retry',
          )
        }

        await transaction
          .delete(resourceGrants)
          .where(
            and(
              eq(resourceGrants.resourceType, request.type),
              eq(resourceGrants.resourceId, request.resourceId),
            ),
          )
        if (decision.grants.size > 0) {
          await transaction.insert(resourceGrants).values(
            [...decision.grants].map(([userId, level]) => ({
              resourceType: request.type,
              resourceId: request.resourceId,
              userId,
              level,
              addedBy: decision.addedBy,
              addedAt: decision.addedAt,
            })),
          )
        }

        await lifecycle.afterWriteInTransaction?.(transaction, {
          type: request.type,
          resourceId: request.resourceId,
          ownerUserId: decision.update.ownerUserId,
          visibility: decision.update.visibility,
          aclRevision: decision.update.aclRevision,
          grantedUserIds: new Set(decision.grants.keys()),
          now: decision.update.updatedAt,
        })
        return decision.result
      })
    },
    isOwnerNameConstraintError: (error) => isOwnerNameConstraintError(db, error),
  }
  return Object.freeze(port)
}
