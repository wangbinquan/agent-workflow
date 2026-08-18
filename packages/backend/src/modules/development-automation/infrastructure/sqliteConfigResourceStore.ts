// RFC-310 PR-1B —— configResourceStore 的 drizzle/bun-sqlite 实现。
//
// 两个具体工厂（actionTemplates / verificationProfiles）共享同一实现骨架；
// 表列集只差 actionTemplates 的 capability_id，所以 extra 的读写由各工厂
// 提供两个纯函数。SQLITE_CONSTRAINT_UNIQUE（owner+name 唯一索引）统一转
// typed 409（沿 util/errors 的 ConflictError 惯例），不让 raw SQLite 错误
// 以 500 泄给 route。

import { and, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  actionTemplates,
  actionTemplateRevisions,
  verificationProfiles,
  verificationProfileRevisions,
} from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  ActionTemplateStore,
  ConfigResourceRecord,
  ConfigRevisionRecord,
  VerificationProfileStore,
} from '../application/ports/configResourceStore'

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('UNIQUE constraint failed')
}

interface IdentityRow {
  id: string
  name: string
  draftJson: string
  publishedRevision: number | null
  ownerUserId: string | null
  visibility: 'private' | 'public'
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

interface RevisionRow {
  revision: number
  contentJson: string
  contentDigest: string
  publishedAt: number
  publishedBy: string | null
}

function record<TExtra>(row: IdentityRow, extra: TExtra): ConfigResourceRecord<TExtra> {
  return {
    id: row.id,
    name: row.name,
    draftJson: row.draftJson,
    publishedRevision: row.publishedRevision,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    extra,
  }
}

/** actionTemplates 具体 store。 */
export function createSqliteActionTemplateStore(db: DbClient): ActionTemplateStore {
  const conflictCode = 'action-template-name-conflict'
  return {
    create(input) {
      try {
        db.insert(actionTemplates)
          .values({
            id: input.id,
            name: input.name,
            capabilityId: input.extra.capabilityId,
            draftJson: input.draftJson,
            ownerUserId: input.ownerUserId,
            visibility: 'private',
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(conflictCode, `action template name already used: ${input.name}`)
        }
        throw error
      }
      const created = this.getById(input.id)
      if (created === null) throw new Error('action template vanished after insert')
      return created
    },
    getById(id) {
      const row = db.select().from(actionTemplates).where(eq(actionTemplates.id, id)).get()
      if (row === undefined) return null
      return record(row, { capabilityId: row.capabilityId })
    },
    list() {
      return db
        .select()
        .from(actionTemplates)
        .all()
        .map((row) => record(row, { capabilityId: row.capabilityId }))
    },
    updateDraft(input) {
      if (this.getById(input.id) === null) {
        throw new NotFoundError(
          'action-template-not-found',
          `action template not found: ${input.id}`,
        )
      }
      try {
        db.update(actionTemplates)
          .set({
            draftJson: input.draftJson,
            updatedAt: input.now,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.extra === undefined ? {} : { capabilityId: input.extra.capabilityId }),
          })
          .where(eq(actionTemplates.id, input.id))
          .run()
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(conflictCode, `action template name already used: ${input.name}`)
        }
        throw error
      }
    },
    publishRevision(input) {
      db.transaction((tx) => {
        const identity = tx
          .select({ id: actionTemplates.id })
          .from(actionTemplates)
          .where(eq(actionTemplates.id, input.resourceId))
          .get()
        if (identity === undefined) {
          throw new NotFoundError(
            'action-template-not-found',
            `action template not found: ${input.resourceId}`,
          )
        }
        tx.insert(actionTemplateRevisions)
          .values({
            templateId: input.resourceId,
            revision: input.revision,
            contentJson: input.contentJson,
            contentDigest: input.contentDigest,
            publishedAt: input.publishedAt,
            publishedBy: input.publishedBy,
          })
          .run()
        tx.update(actionTemplates)
          .set({ publishedRevision: input.revision, updatedAt: input.publishedAt })
          .where(eq(actionTemplates.id, input.resourceId))
          .run()
      })
    },
    getRevision(resourceId, revision) {
      const row = db
        .select()
        .from(actionTemplateRevisions)
        .where(
          and(
            eq(actionTemplateRevisions.templateId, resourceId),
            eq(actionTemplateRevisions.revision, revision),
          ),
        )
        .get()
      return row === undefined ? null : toRevisionRecord(resourceId, row)
    },
    listRevisions(resourceId) {
      return db
        .select()
        .from(actionTemplateRevisions)
        .where(eq(actionTemplateRevisions.templateId, resourceId))
        .all()
        .sort((a, b) => a.revision - b.revision)
        .map((row) => toRevisionRecord(resourceId, row))
    },
    archive(id, now) {
      if (this.getById(id) === null) {
        throw new NotFoundError('action-template-not-found', `action template not found: ${id}`)
      }
      db.update(actionTemplates)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(actionTemplates.id, id))
        .run()
    },
  }
}

/** verificationProfiles 具体 store（无 extra 列）。 */
export function createSqliteVerificationProfileStore(db: DbClient): VerificationProfileStore {
  const conflictCode = 'verification-profile-name-conflict'
  const empty: Record<never, never> = {}
  return {
    create(input) {
      try {
        db.insert(verificationProfiles)
          .values({
            id: input.id,
            name: input.name,
            draftJson: input.draftJson,
            ownerUserId: input.ownerUserId,
            visibility: 'private',
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(
            conflictCode,
            `verification profile name already used: ${input.name}`,
          )
        }
        throw error
      }
      const created = this.getById(input.id)
      if (created === null) throw new Error('verification profile vanished after insert')
      return created
    },
    getById(id) {
      const row = db
        .select()
        .from(verificationProfiles)
        .where(eq(verificationProfiles.id, id))
        .get()
      return row === undefined ? null : record(row, empty)
    },
    list() {
      return db
        .select()
        .from(verificationProfiles)
        .all()
        .map((row) => record(row, empty))
    },
    updateDraft(input) {
      if (this.getById(input.id) === null) {
        throw new NotFoundError(
          'verification-profile-not-found',
          `verification profile not found: ${input.id}`,
        )
      }
      try {
        db.update(verificationProfiles)
          .set({
            draftJson: input.draftJson,
            updatedAt: input.now,
            ...(input.name === undefined ? {} : { name: input.name }),
          })
          .where(eq(verificationProfiles.id, input.id))
          .run()
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(
            conflictCode,
            `verification profile name already used: ${input.name}`,
          )
        }
        throw error
      }
    },
    publishRevision(input) {
      db.transaction((tx) => {
        const identity = tx
          .select({ id: verificationProfiles.id })
          .from(verificationProfiles)
          .where(eq(verificationProfiles.id, input.resourceId))
          .get()
        if (identity === undefined) {
          throw new NotFoundError(
            'verification-profile-not-found',
            `verification profile not found: ${input.resourceId}`,
          )
        }
        tx.insert(verificationProfileRevisions)
          .values({
            profileId: input.resourceId,
            revision: input.revision,
            contentJson: input.contentJson,
            contentDigest: input.contentDigest,
            publishedAt: input.publishedAt,
            publishedBy: input.publishedBy,
          })
          .run()
        tx.update(verificationProfiles)
          .set({ publishedRevision: input.revision, updatedAt: input.publishedAt })
          .where(eq(verificationProfiles.id, input.resourceId))
          .run()
      })
    },
    getRevision(resourceId, revision) {
      const row = db
        .select()
        .from(verificationProfileRevisions)
        .where(
          and(
            eq(verificationProfileRevisions.profileId, resourceId),
            eq(verificationProfileRevisions.revision, revision),
          ),
        )
        .get()
      return row === undefined ? null : toRevisionRecord(resourceId, row)
    },
    listRevisions(resourceId) {
      return db
        .select()
        .from(verificationProfileRevisions)
        .where(eq(verificationProfileRevisions.profileId, resourceId))
        .all()
        .sort((a, b) => a.revision - b.revision)
        .map((row) => toRevisionRecord(resourceId, row))
    },
    archive(id, now) {
      if (this.getById(id) === null) {
        throw new NotFoundError(
          'verification-profile-not-found',
          `verification profile not found: ${id}`,
        )
      }
      db.update(verificationProfiles)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(verificationProfiles.id, id))
        .run()
    },
  }
}

function toRevisionRecord(resourceId: string, row: RevisionRow): ConfigRevisionRecord {
  return {
    resourceId,
    revision: row.revision,
    contentJson: row.contentJson,
    contentDigest: row.contentDigest,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
  }
}
