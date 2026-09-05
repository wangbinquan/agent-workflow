// RFC-310 T16 —— DevelopmentAdapterStore。RFC-359 W4-D6 起一份实现，两个 provider 共用。
//
// identity 行持 ACL 列与可变 draft；revisions 行 immutable（(adapter_id, revision) 主键）。publish 在统一
// 事务原语里插 revision 行并推进 identity 的 published_revision——不存在半发布状态。name 走 owner+name 唯一
// 索引，撞库经能力矩阵归类后翻译成 typed 409（RFC-223 惯例）。ACL identity 面绑定 resource-catalog 交来的
// 目录写事务句柄（`ResourceAclIdentityPersistence`），owner 只回答自己那张表。

import { and, eq, ne } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { developmentAdapterDefinitionRevisions, developmentAdapterDefinitions } from '@/db/schema'
import type {
  DevelopmentAdapterAclIdentityMutation,
  DevelopmentAdapterAclIdentityPersistence,
  DevelopmentAdapterIdentityRow,
  DevelopmentAdapterStore,
} from '@/modules/integration/application/developmentAdapterCommands'
import {
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { postgresqlUniqueViolationConstraint } from '@/platform/persistence/capabilities'
import { ConflictError } from '@/util/errors'

const OWNER_NAME_CONSTRAINT = 'development_adapter_definitions_owner_name_unique'

function toIdentityRow(
  row: typeof developmentAdapterDefinitions.$inferSelect,
): DevelopmentAdapterIdentityRow {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    draftJson: row.draftJson,
    publishedRevision: row.publishedRevision,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  }
}

/** owner + name 撞库：先经能力矩阵判是不是唯一冲突，再核约束名（PG 带约束名，SQLite 只有一句 message）。 */
export function isDevelopmentAdapterOwnerNameConstraintError(
  db: ProviderNeutralDatabase,
  error: unknown,
): boolean {
  if (engineOf(db).classifyError(error) !== 'unique-violation') return false
  const constraint = postgresqlUniqueViolationConstraint(error)
  return constraint === undefined || constraint === OWNER_NAME_CONSTRAINT
}

function createDevelopmentAdapterAclIdentity(
  db: ProviderNeutralDatabase,
): DevelopmentAdapterAclIdentityPersistence {
  const identity: DevelopmentAdapterAclIdentityPersistence = {
    type: 'development_adapter',
    async getRevision(resourceId) {
      const rows = await db
        .select({ aclRevision: developmentAdapterDefinitions.aclRevision })
        .from(developmentAdapterDefinitions)
        .where(eq(developmentAdapterDefinitions.id, resourceId))
        .limit(1)
      return rows[0]?.aclRevision ?? 0
    },
    async loadForMutation(
      transaction: DatabaseTransaction,
      resourceId: string,
    ): Promise<DevelopmentAdapterAclIdentityMutation | undefined> {
      const row = (
        await transaction
          .select({
            id: developmentAdapterDefinitions.id,
            name: developmentAdapterDefinitions.name,
            ownerUserId: developmentAdapterDefinitions.ownerUserId,
            visibility: developmentAdapterDefinitions.visibility,
            aclRevision: developmentAdapterDefinitions.aclRevision,
          })
          .from(developmentAdapterDefinitions)
          .where(eq(developmentAdapterDefinitions.id, resourceId))
          .limit(1)
      )[0]
      if (row === undefined) return undefined
      const mutation: DevelopmentAdapterAclIdentityMutation = {
        current: row,
        ownerNameIsUnique: true,
        async hasOwnerNameCollision(nextOwnerUserId) {
          const rows = await transaction
            .select({ id: developmentAdapterDefinitions.id })
            .from(developmentAdapterDefinitions)
            .where(
              and(
                eq(developmentAdapterDefinitions.ownerUserId, nextOwnerUserId),
                eq(developmentAdapterDefinitions.name, row.name),
                ne(developmentAdapterDefinitions.id, resourceId),
              ),
            )
            .limit(1)
          return rows[0] !== undefined
        },
        async update(input) {
          const updated = await transaction
            .update(developmentAdapterDefinitions)
            .set({
              ownerUserId: input.ownerUserId,
              visibility: input.visibility,
              aclRevision: input.aclRevision,
              updatedAt: input.updatedAt,
            })
            .where(
              and(
                eq(developmentAdapterDefinitions.id, resourceId),
                eq(developmentAdapterDefinitions.aclRevision, row.aclRevision),
              ),
            )
            .returning({ id: developmentAdapterDefinitions.id })
          return updated.length === 1
        },
      }
      return mutation
    },
  }
  return Object.freeze(identity)
}

export function createDevelopmentAdapterStore(
  db: ProviderNeutralDatabase,
): DevelopmentAdapterStore {
  const session = databaseSessionFor(db)
  return {
    resourceAclIdentity: createDevelopmentAdapterAclIdentity(db),

    async create(input) {
      const id = ulid()
      try {
        const rows = await db
          .insert(developmentAdapterDefinitions)
          .values({
            id,
            name: input.name,
            purpose: input.purpose,
            draftJson: input.draftJson,
            publishedRevision: null,
            ownerUserId: input.ownerUserId,
            visibility: 'private',
            aclRevision: 0,
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
          })
          .returning()
        const row = rows[0]
        if (row === undefined) throw new Error('insert visibility failure')
        return toIdentityRow(row)
      } catch (error) {
        if (isDevelopmentAdapterOwnerNameConstraintError(db, error)) {
          throw new ConflictError(
            'development-adapter-name-taken',
            `an adapter named '${input.name}' already exists for this owner`,
          )
        }
        throw error
      }
    },

    async getById(id) {
      const rows = await db
        .select()
        .from(developmentAdapterDefinitions)
        .where(eq(developmentAdapterDefinitions.id, id))
        .limit(1)
      const row = rows[0]
      return row === undefined ? null : toIdentityRow(row)
    },
    async list() {
      return (await db.select().from(developmentAdapterDefinitions)).map(toIdentityRow)
    },

    async updateDraft(input) {
      try {
        await db
          .update(developmentAdapterDefinitions)
          .set({
            ...(input.name === undefined ? {} : { name: input.name }),
            draftJson: input.draftJson,
            updatedAt: input.now,
          })
          .where(eq(developmentAdapterDefinitions.id, input.id))
      } catch (error) {
        if (isDevelopmentAdapterOwnerNameConstraintError(db, error)) {
          throw new ConflictError(
            'development-adapter-name-taken',
            `an adapter named '${input.name ?? ''}' already exists for this owner`,
          )
        }
        throw error
      }
    },

    async publish(input) {
      await session.transaction(async (tx) => {
        await tx.insert(developmentAdapterDefinitionRevisions).values({
          adapterId: input.id,
          revision: input.revision,
          contentJson: input.contentJson,
          contentDigest: input.contentDigest,
          publishedAt: input.now,
          publishedBy: input.publishedBy,
        })
        await tx
          .update(developmentAdapterDefinitions)
          .set({ publishedRevision: input.revision, updatedAt: input.now })
          .where(eq(developmentAdapterDefinitions.id, input.id))
      })
    },

    async archive(input) {
      await db
        .update(developmentAdapterDefinitions)
        .set({ archivedAt: input.now, updatedAt: input.now })
        .where(eq(developmentAdapterDefinitions.id, input.id))
    },

    async getRevision(id, revision) {
      const rows = await db
        .select({
          contentJson: developmentAdapterDefinitionRevisions.contentJson,
          contentDigest: developmentAdapterDefinitionRevisions.contentDigest,
        })
        .from(developmentAdapterDefinitionRevisions)
        .where(
          and(
            eq(developmentAdapterDefinitionRevisions.adapterId, id),
            eq(developmentAdapterDefinitionRevisions.revision, revision),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },
  }
}

/** 旧名保留为装配别名，bootstrap 收敛后删除。 */
export const createSqliteDevelopmentAdapterStore = createDevelopmentAdapterStore
export const createPostgresqlDevelopmentAdapterRevisionStore = createDevelopmentAdapterStore
