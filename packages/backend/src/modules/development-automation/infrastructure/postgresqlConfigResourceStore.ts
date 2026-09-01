// RFC-349 — asynchronous PostgreSQL adapters for immutable development config resources.

import { and, asc, eq } from 'drizzle-orm'

import {
  actionTemplateRevisions,
  actionTemplates,
  verificationProfileRevisions,
  verificationProfiles,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  ActionTemplatePersistence,
  ConfigResourceRecord,
  ConfigRevisionRecord,
  VerificationProfilePersistence,
} from '../application/ports/configResourceStore'

function uniqueNameGuard(error: unknown, code: string, message: string): never {
  const detail = error instanceof Error ? error.message : String(error)
  if (detail.toLowerCase().includes('unique')) throw new ConflictError(code, message)
  throw error
}

function revisionRecord(
  resourceId: string,
  row: {
    readonly revision: number
    readonly contentJson: string
    readonly contentDigest: string
    readonly publishedAt: number
    readonly publishedBy: string | null
  },
): ConfigRevisionRecord {
  return { resourceId, ...row }
}

export function createPostgresqlActionTemplatePersistence(
  db: PostgresqlDatabaseClient,
): ActionTemplatePersistence {
  const getById = async (
    id: string,
  ): Promise<ConfigResourceRecord<{ capabilityId: string }> | null> => {
    const row = await db
      .select()
      .from(actionTemplates)
      .where(eq(actionTemplates.id, id))
      .limit(1)
      .get()
    return row === undefined ? null : { ...row, extra: { capabilityId: row.capabilityId } }
  }
  return {
    async create(input) {
      try {
        await db
          .insert(actionTemplates)
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
        uniqueNameGuard(
          error,
          'action-template-name-conflict',
          `action template name already used: ${input.name}`,
        )
      }
      const created = await getById(input.id)
      if (created === null) throw new Error('action template vanished after insert')
      return created
    },
    getById,
    async list() {
      const rows = await db.select().from(actionTemplates).all()
      return rows.map((row) => ({ ...row, extra: { capabilityId: row.capabilityId } }))
    },
    async updateDraft(input) {
      if ((await getById(input.id)) === null) {
        throw new NotFoundError(
          'action-template-not-found',
          `action template not found: ${input.id}`,
        )
      }
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
          .run()
      } catch (error) {
        uniqueNameGuard(
          error,
          'action-template-name-conflict',
          `action template name already used: ${input.name}`,
        )
      }
    },
    async publishRevision(input) {
      await db.transaction(async (tx) => {
        const identity = await tx
          .select({ id: actionTemplates.id })
          .from(actionTemplates)
          .where(eq(actionTemplates.id, input.resourceId))
          .limit(1)
          .get()
        if (identity === undefined) {
          throw new NotFoundError(
            'action-template-not-found',
            `action template not found: ${input.resourceId}`,
          )
        }
        await tx
          .insert(actionTemplateRevisions)
          .values({
            templateId: input.resourceId,
            revision: input.revision,
            contentJson: input.contentJson,
            contentDigest: input.contentDigest,
            publishedAt: input.publishedAt,
            publishedBy: input.publishedBy,
          })
          .run()
        await tx
          .update(actionTemplates)
          .set({ publishedRevision: input.revision, updatedAt: input.publishedAt })
          .where(eq(actionTemplates.id, input.resourceId))
          .run()
      })
    },
    async getRevision(resourceId, revision) {
      const row = await db
        .select({
          revision: actionTemplateRevisions.revision,
          contentJson: actionTemplateRevisions.contentJson,
          contentDigest: actionTemplateRevisions.contentDigest,
          publishedAt: actionTemplateRevisions.publishedAt,
          publishedBy: actionTemplateRevisions.publishedBy,
        })
        .from(actionTemplateRevisions)
        .where(
          and(
            eq(actionTemplateRevisions.templateId, resourceId),
            eq(actionTemplateRevisions.revision, revision),
          ),
        )
        .limit(1)
        .get()
      return row === undefined ? null : revisionRecord(resourceId, row)
    },
    async listRevisions(resourceId) {
      const rows = await db
        .select({
          revision: actionTemplateRevisions.revision,
          contentJson: actionTemplateRevisions.contentJson,
          contentDigest: actionTemplateRevisions.contentDigest,
          publishedAt: actionTemplateRevisions.publishedAt,
          publishedBy: actionTemplateRevisions.publishedBy,
        })
        .from(actionTemplateRevisions)
        .where(eq(actionTemplateRevisions.templateId, resourceId))
        .orderBy(asc(actionTemplateRevisions.revision))
        .all()
      return rows.map((row) => revisionRecord(resourceId, row))
    },
    async archive(id, now) {
      const updated = await db
        .update(actionTemplates)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(actionTemplates.id, id))
        .returning({ id: actionTemplates.id })
        .all()
      if (updated.length !== 1) {
        throw new NotFoundError('action-template-not-found', `action template not found: ${id}`)
      }
    },
  }
}

export function createPostgresqlVerificationProfilePersistence(
  db: PostgresqlDatabaseClient,
): VerificationProfilePersistence {
  const getById = async (
    id: string,
  ): Promise<ConfigResourceRecord<Record<never, never>> | null> => {
    const row = await db
      .select()
      .from(verificationProfiles)
      .where(eq(verificationProfiles.id, id))
      .limit(1)
      .get()
    return row === undefined ? null : { ...row, extra: {} }
  }
  return {
    async create(input) {
      try {
        await db
          .insert(verificationProfiles)
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
        uniqueNameGuard(
          error,
          'verification-profile-name-conflict',
          `verification profile name already used: ${input.name}`,
        )
      }
      const created = await getById(input.id)
      if (created === null) throw new Error('verification profile vanished after insert')
      return created
    },
    getById,
    async list() {
      const rows = await db.select().from(verificationProfiles).all()
      return rows.map((row) => ({ ...row, extra: {} }))
    },
    async updateDraft(input) {
      if ((await getById(input.id)) === null) {
        throw new NotFoundError(
          'verification-profile-not-found',
          `verification profile not found: ${input.id}`,
        )
      }
      try {
        await db
          .update(verificationProfiles)
          .set({
            draftJson: input.draftJson,
            updatedAt: input.now,
            ...(input.name === undefined ? {} : { name: input.name }),
          })
          .where(eq(verificationProfiles.id, input.id))
          .run()
      } catch (error) {
        uniqueNameGuard(
          error,
          'verification-profile-name-conflict',
          `verification profile name already used: ${input.name}`,
        )
      }
    },
    async publishRevision(input) {
      await db.transaction(async (tx) => {
        const identity = await tx
          .select({ id: verificationProfiles.id })
          .from(verificationProfiles)
          .where(eq(verificationProfiles.id, input.resourceId))
          .limit(1)
          .get()
        if (identity === undefined) {
          throw new NotFoundError(
            'verification-profile-not-found',
            `verification profile not found: ${input.resourceId}`,
          )
        }
        await tx
          .insert(verificationProfileRevisions)
          .values({
            profileId: input.resourceId,
            revision: input.revision,
            contentJson: input.contentJson,
            contentDigest: input.contentDigest,
            publishedAt: input.publishedAt,
            publishedBy: input.publishedBy,
          })
          .run()
        await tx
          .update(verificationProfiles)
          .set({ publishedRevision: input.revision, updatedAt: input.publishedAt })
          .where(eq(verificationProfiles.id, input.resourceId))
          .run()
      })
    },
    async getRevision(resourceId, revision) {
      const row = await db
        .select({
          revision: verificationProfileRevisions.revision,
          contentJson: verificationProfileRevisions.contentJson,
          contentDigest: verificationProfileRevisions.contentDigest,
          publishedAt: verificationProfileRevisions.publishedAt,
          publishedBy: verificationProfileRevisions.publishedBy,
        })
        .from(verificationProfileRevisions)
        .where(
          and(
            eq(verificationProfileRevisions.profileId, resourceId),
            eq(verificationProfileRevisions.revision, revision),
          ),
        )
        .limit(1)
        .get()
      return row === undefined ? null : revisionRecord(resourceId, row)
    },
    async listRevisions(resourceId) {
      const rows = await db
        .select({
          revision: verificationProfileRevisions.revision,
          contentJson: verificationProfileRevisions.contentJson,
          contentDigest: verificationProfileRevisions.contentDigest,
          publishedAt: verificationProfileRevisions.publishedAt,
          publishedBy: verificationProfileRevisions.publishedBy,
        })
        .from(verificationProfileRevisions)
        .where(eq(verificationProfileRevisions.profileId, resourceId))
        .orderBy(asc(verificationProfileRevisions.revision))
        .all()
      return rows.map((row) => revisionRecord(resourceId, row))
    },
    async archive(id, now) {
      const updated = await db
        .update(verificationProfiles)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(verificationProfiles.id, id))
        .returning({ id: verificationProfiles.id })
        .all()
      if (updated.length !== 1) {
        throw new NotFoundError(
          'verification-profile-not-found',
          `verification profile not found: ${id}`,
        )
      }
    },
  }
}
