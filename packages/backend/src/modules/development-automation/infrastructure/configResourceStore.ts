// RFC-310 PR-1B —— configResourceStore（actionTemplates / verificationProfiles）的持久化。RFC-359 W4-D6b 起
// 一份实现，两个 provider 共用。
//
// 两个具体工厂共享同一实现骨架；表列集只差 actionTemplates 的 capability_id，所以 extra 的读写由各工厂
// 各自给出。(owner, name) 撞唯一索引经能力矩阵归类（classifyError）后翻译成 typed 409（沿 util/errors 的
// ConflictError 惯例），不让 raw 驱动错误以 500 泄给 route。publishRevision 在统一事务原语里「插 revision 行 +
// 推进 identity.publishedRevision」，不存在半发布状态；archive 只封存 identity，revision 行 immutable。

import { and, asc, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  actionTemplateRevisions,
  actionTemplates,
  verificationProfileRevisions,
  verificationProfiles,
} from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  ActionTemplatePersistence,
  ConfigResourceRecord,
  ConfigRevisionRecord,
  VerificationProfilePersistence,
} from '../application/ports/configResourceStore'

interface IdentityRow {
  readonly id: string
  readonly name: string
  readonly draftJson: string
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

interface RevisionRow {
  readonly revision: number
  readonly contentJson: string
  readonly contentDigest: string
  readonly publishedAt: number
  readonly publishedBy: string | null
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

function revisionRecord(resourceId: string, row: RevisionRow): ConfigRevisionRecord {
  return {
    resourceId,
    revision: row.revision,
    contentJson: row.contentJson,
    contentDigest: row.contentDigest,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
  }
}

/** actionTemplates 具体 persistence。 */
export function createActionTemplatePersistence(
  db: ProviderNeutralDatabase,
): ActionTemplatePersistence {
  const session = databaseSessionFor(db)
  const notFound = (id: string): NotFoundError =>
    new NotFoundError('action-template-not-found', `action template not found: ${id}`)
  const nameTaken = (error: unknown, name: string | undefined): never => {
    if (session.engine.classifyError(error) === 'unique-violation') {
      throw new ConflictError(
        'action-template-name-conflict',
        `action template name already used: ${name}`,
      )
    }
    throw error
  }
  const getById = async (
    id: string,
  ): Promise<ConfigResourceRecord<{ readonly capabilityId: string }> | null> => {
    const row = (
      await db.select().from(actionTemplates).where(eq(actionTemplates.id, id)).limit(1)
    )[0]
    return row === undefined ? null : record(row, { capabilityId: row.capabilityId })
  }
  return {
    async create(input) {
      try {
        await db.insert(actionTemplates).values({
          id: input.id,
          name: input.name,
          capabilityId: input.extra.capabilityId,
          draftJson: input.draftJson,
          ownerUserId: input.ownerUserId,
          visibility: 'private',
          createdAt: input.now,
          updatedAt: input.now,
        })
      } catch (error) {
        nameTaken(error, input.name)
      }
      const created = await getById(input.id)
      if (created === null) throw new Error('action template vanished after insert')
      return created
    },
    getById,
    async list() {
      const rows = await db
        .select()
        .from(actionTemplates)
        .orderBy(asc(actionTemplates.createdAt), asc(actionTemplates.id))
      return rows.map((row) => record(row, { capabilityId: row.capabilityId }))
    },
    async updateDraft(input) {
      if ((await getById(input.id)) === null) throw notFound(input.id)
      try {
        await db
          .update(actionTemplates)
          .set({
            draftJson: input.draftJson,
            updatedAt: input.now,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.extra === undefined ? {} : { capabilityId: input.extra.capabilityId }),
          })
          .where(eq(actionTemplates.id, input.id))
      } catch (error) {
        nameTaken(error, input.name)
      }
    },
    async publishRevision(input) {
      await session.transaction(async (tx) => {
        const identity = (
          await tx
            .select({ id: actionTemplates.id })
            .from(actionTemplates)
            .where(eq(actionTemplates.id, input.resourceId))
            .limit(1)
        )[0]
        if (identity === undefined) throw notFound(input.resourceId)
        await tx.insert(actionTemplateRevisions).values({
          templateId: input.resourceId,
          revision: input.revision,
          contentJson: input.contentJson,
          contentDigest: input.contentDigest,
          publishedAt: input.publishedAt,
          publishedBy: input.publishedBy,
        })
        await tx
          .update(actionTemplates)
          .set({ publishedRevision: input.revision, updatedAt: input.publishedAt })
          .where(eq(actionTemplates.id, input.resourceId))
      })
    },
    async getRevision(resourceId, revision) {
      const row = (
        await db
          .select()
          .from(actionTemplateRevisions)
          .where(
            and(
              eq(actionTemplateRevisions.templateId, resourceId),
              eq(actionTemplateRevisions.revision, revision),
            ),
          )
          .limit(1)
      )[0]
      return row === undefined ? null : revisionRecord(resourceId, row)
    },
    async listRevisions(resourceId) {
      const rows = await db
        .select()
        .from(actionTemplateRevisions)
        .where(eq(actionTemplateRevisions.templateId, resourceId))
        .orderBy(asc(actionTemplateRevisions.revision))
      return rows.map((row) => revisionRecord(resourceId, row))
    },
    async archive(id, now) {
      const updated = await db
        .update(actionTemplates)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(actionTemplates.id, id))
        .returning({ id: actionTemplates.id })
      if (updated.length !== 1) throw notFound(id)
    },
  }
}

/** verificationProfiles 具体 persistence（无 extra 列）。 */
export function createVerificationProfilePersistence(
  db: ProviderNeutralDatabase,
): VerificationProfilePersistence {
  const session = databaseSessionFor(db)
  const empty: Record<never, never> = {}
  const notFound = (id: string): NotFoundError =>
    new NotFoundError('verification-profile-not-found', `verification profile not found: ${id}`)
  const nameTaken = (error: unknown, name: string | undefined): never => {
    if (session.engine.classifyError(error) === 'unique-violation') {
      throw new ConflictError(
        'verification-profile-name-conflict',
        `verification profile name already used: ${name}`,
      )
    }
    throw error
  }
  const getById = async (
    id: string,
  ): Promise<ConfigResourceRecord<Record<never, never>> | null> => {
    const row = (
      await db.select().from(verificationProfiles).where(eq(verificationProfiles.id, id)).limit(1)
    )[0]
    return row === undefined ? null : record(row, empty)
  }
  return {
    async create(input) {
      try {
        await db.insert(verificationProfiles).values({
          id: input.id,
          name: input.name,
          draftJson: input.draftJson,
          ownerUserId: input.ownerUserId,
          visibility: 'private',
          createdAt: input.now,
          updatedAt: input.now,
        })
      } catch (error) {
        nameTaken(error, input.name)
      }
      const created = await getById(input.id)
      if (created === null) throw new Error('verification profile vanished after insert')
      return created
    },
    getById,
    async list() {
      const rows = await db
        .select()
        .from(verificationProfiles)
        .orderBy(asc(verificationProfiles.createdAt), asc(verificationProfiles.id))
      return rows.map((row) => record(row, empty))
    },
    async updateDraft(input) {
      if ((await getById(input.id)) === null) throw notFound(input.id)
      try {
        await db
          .update(verificationProfiles)
          .set({
            draftJson: input.draftJson,
            updatedAt: input.now,
            ...(input.name === undefined ? {} : { name: input.name }),
          })
          .where(eq(verificationProfiles.id, input.id))
      } catch (error) {
        nameTaken(error, input.name)
      }
    },
    async publishRevision(input) {
      await session.transaction(async (tx) => {
        const identity = (
          await tx
            .select({ id: verificationProfiles.id })
            .from(verificationProfiles)
            .where(eq(verificationProfiles.id, input.resourceId))
            .limit(1)
        )[0]
        if (identity === undefined) throw notFound(input.resourceId)
        await tx.insert(verificationProfileRevisions).values({
          profileId: input.resourceId,
          revision: input.revision,
          contentJson: input.contentJson,
          contentDigest: input.contentDigest,
          publishedAt: input.publishedAt,
          publishedBy: input.publishedBy,
        })
        await tx
          .update(verificationProfiles)
          .set({ publishedRevision: input.revision, updatedAt: input.publishedAt })
          .where(eq(verificationProfiles.id, input.resourceId))
      })
    },
    async getRevision(resourceId, revision) {
      const row = (
        await db
          .select()
          .from(verificationProfileRevisions)
          .where(
            and(
              eq(verificationProfileRevisions.profileId, resourceId),
              eq(verificationProfileRevisions.revision, revision),
            ),
          )
          .limit(1)
      )[0]
      return row === undefined ? null : revisionRecord(resourceId, row)
    },
    async listRevisions(resourceId) {
      const rows = await db
        .select()
        .from(verificationProfileRevisions)
        .where(eq(verificationProfileRevisions.profileId, resourceId))
        .orderBy(asc(verificationProfileRevisions.revision))
      return rows.map((row) => revisionRecord(resourceId, row))
    },
    async archive(id, now) {
      const updated = await db
        .update(verificationProfiles)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(verificationProfiles.id, id))
        .returning({ id: verificationProfiles.id })
      if (updated.length !== 1) throw notFound(id)
    },
  }
}
