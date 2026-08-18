// RFC-310 T16 —— DevelopmentAdapterStore 的 SQLite 实现（migration 0176 表）。
//
// identity 行持 ACL 列与可变 draft；revisions 行 immutable（(adapter_id,
// revision) 主键）。publish 在一个 dbTxSync 里插 revision 行并推进 identity
// 的 published_revision——不存在半发布状态。name 走 owner+name 唯一索引，
// 冲突翻译成 typed 409（RFC-223 惯例）。

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type {
  DevelopmentAdapterIdentityRow,
  DevelopmentAdapterStore,
} from '@/modules/integration/application/developmentAdapterCommands'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { developmentAdapterDefinitionRevisions, developmentAdapterDefinitions } from '@/db/schema'
import { ConflictError } from '@/util/errors'

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

export function createSqliteDevelopmentAdapterStore(db: DbClient): DevelopmentAdapterStore {
  return {
    create(input) {
      const id = ulid()
      try {
        db.insert(developmentAdapterDefinitions)
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
          .run()
      } catch (error) {
        if (String(error).includes('development_adapter_definitions_owner_name_unique')) {
          throw new ConflictError(
            'development-adapter-name-taken',
            `an adapter named '${input.name}' already exists for this owner`,
          )
        }
        throw error
      }
      const row = db
        .select()
        .from(developmentAdapterDefinitions)
        .where(eq(developmentAdapterDefinitions.id, id))
        .get()
      if (row === undefined) throw new Error('insert visibility failure')
      return toIdentityRow(row)
    },

    getById(id) {
      const row = db
        .select()
        .from(developmentAdapterDefinitions)
        .where(eq(developmentAdapterDefinitions.id, id))
        .get()
      return row === undefined ? null : toIdentityRow(row)
    },
    list() {
      return db.select().from(developmentAdapterDefinitions).all().map(toIdentityRow)
    },

    updateDraft(input) {
      db.update(developmentAdapterDefinitions)
        .set({ draftJson: input.draftJson, updatedAt: input.now })
        .where(eq(developmentAdapterDefinitions.id, input.id))
        .run()
    },

    publish(input) {
      dbTxSync(db, (tx) => {
        tx.insert(developmentAdapterDefinitionRevisions)
          .values({
            adapterId: input.id,
            revision: input.revision,
            contentJson: input.contentJson,
            contentDigest: input.contentDigest,
            publishedAt: input.now,
            publishedBy: input.publishedBy,
          })
          .run()
        tx.update(developmentAdapterDefinitions)
          .set({ publishedRevision: input.revision, updatedAt: input.now })
          .where(eq(developmentAdapterDefinitions.id, input.id))
          .run()
      })
    },

    archive(input) {
      db.update(developmentAdapterDefinitions)
        .set({ archivedAt: input.now, updatedAt: input.now })
        .where(eq(developmentAdapterDefinitions.id, input.id))
        .run()
    },

    getRevision(id, revision) {
      const row = db
        .select()
        .from(developmentAdapterDefinitionRevisions)
        .where(
          and(
            eq(developmentAdapterDefinitionRevisions.adapterId, id),
            eq(developmentAdapterDefinitionRevisions.revision, revision),
          ),
        )
        .get()
      return row === undefined
        ? null
        : { contentJson: row.contentJson, contentDigest: row.contentDigest }
    },
  }
}
