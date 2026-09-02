import { desc, eq, and, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  customEventSourceDefinitions,
  customEventSourceRevisions,
  eventSources,
  eventTypeCatalog,
} from '@/db/schema'
import type { CustomEventSourceStorePort } from '../application/ports/customEventSourceStore'
import {
  customEventSourceDraftSchema,
  type CustomEventSourceAuthoringRecord,
  type CustomEventSourceValidationReceipt,
  type PublishedCustomEventSource,
} from '../domain/customEventSource'

function validationReceipt(value: string): CustomEventSourceValidationReceipt {
  const parsed = JSON.parse(value) as Partial<CustomEventSourceValidationReceipt>
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.draftDigest !== 'string' ||
    typeof parsed.validatedAt !== 'number' ||
    typeof parsed.observationCount !== 'number' ||
    typeof parsed.stdoutDigest !== 'string'
  ) {
    throw new Error('custom event source validation receipt is corrupt')
  }
  return parsed as CustomEventSourceValidationReceipt
}

export function createSqliteCustomEventSourceStore(db: DbClient): CustomEventSourceStorePort {
  const record = (
    row: typeof customEventSourceDefinitions.$inferSelect,
  ): CustomEventSourceAuthoringRecord => {
    const published =
      row.publishedRevision === null
        ? undefined
        : db
            .select({ contentDigest: customEventSourceRevisions.contentDigest })
            .from(customEventSourceRevisions)
            .where(
              and(
                eq(customEventSourceRevisions.sourceId, row.id),
                eq(customEventSourceRevisions.revision, row.publishedRevision),
              ),
            )
            .get()
    return {
      id: row.id,
      draft: customEventSourceDraftSchema.parse(JSON.parse(row.draftJson) as unknown),
      publishedRevision: row.publishedRevision,
      publishedDigest: published?.contentDigest ?? null,
      ownerUserId: row.ownerUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      retiredAt: row.retiredAt,
    }
  }

  return {
    async create(input) {
      db.insert(customEventSourceDefinitions)
        .values({
          id: input.id,
          draftJson: JSON.stringify(input.draft),
          publishedRevision: null,
          ownerUserId: input.ownerUserId,
          createdAt: input.now,
          updatedAt: input.now,
          retiredAt: null,
        })
        .run()
      return record(
        db
          .select()
          .from(customEventSourceDefinitions)
          .where(eq(customEventSourceDefinitions.id, input.id))
          .get()!,
      )
    },

    async get(id) {
      const row = db
        .select()
        .from(customEventSourceDefinitions)
        .where(eq(customEventSourceDefinitions.id, id))
        .get()
      return row === undefined ? null : record(row)
    },

    async list() {
      return db
        .select()
        .from(customEventSourceDefinitions)
        .orderBy(
          desc(customEventSourceDefinitions.updatedAt),
          desc(customEventSourceDefinitions.id),
        )
        .all()
        .map(record)
    },

    async update(input) {
      const changed = db
        .update(customEventSourceDefinitions)
        .set({ draftJson: JSON.stringify(input.draft), updatedAt: input.now })
        .where(
          and(
            eq(customEventSourceDefinitions.id, input.id),
            isNull(customEventSourceDefinitions.retiredAt),
          ),
        )
        .run()
      if ((changed as unknown as { changes?: number }).changes !== 1) return null
      const row = db
        .select()
        .from(customEventSourceDefinitions)
        .where(eq(customEventSourceDefinitions.id, input.id))
        .get()
      return row === undefined ? null : record(row)
    },

    async publish(input) {
      dbTxSync(db, (tx) => {
        const current = tx
          .select()
          .from(customEventSourceDefinitions)
          .where(eq(customEventSourceDefinitions.id, input.id))
          .get()
        if (current === undefined || current.retiredAt !== null) {
          throw new Error('custom event source is unavailable')
        }
        if ((current.publishedRevision ?? 0) + 1 !== input.revision) {
          throw new Error('custom event source publish revision conflict')
        }
        if (current.draftJson !== JSON.stringify(input.draft)) {
          throw new Error('custom event source draft changed during validation')
        }

        tx.insert(customEventSourceRevisions)
          .values({
            sourceId: input.id,
            revision: input.revision,
            contentJson: JSON.stringify(input.draft),
            contentDigest: input.digest,
            validationReceiptJson: JSON.stringify(input.validationReceipt),
            publishedAt: input.now,
            publishedBy: input.actorUserId,
          })
          .run()
        tx.insert(eventSources)
          .values({
            sourceId: input.source.sourceRef.id,
            revision: input.source.sourceRef.revision,
            descriptorJson: JSON.stringify(input.source),
            descriptorDigest: input.digest,
            state: 'published',
            registeredAt: input.now,
          })
          .run()
        for (const eventType of input.eventTypes) {
          tx.insert(eventTypeCatalog)
            .values({
              eventTypeId: eventType.eventTypeRef.id,
              revision: eventType.eventTypeRef.revision,
              sourceId: eventType.sourceRef.id,
              sourceRevision: eventType.sourceRef.revision,
              descriptorJson: JSON.stringify(eventType),
              descriptorDigest: input.digest,
              catalogVisibility: 'public',
              state: 'published',
              registeredAt: input.now,
            })
            .run()
        }
        tx.update(customEventSourceDefinitions)
          .set({ publishedRevision: input.revision, updatedAt: input.now })
          .where(eq(customEventSourceDefinitions.id, input.id))
          .run()
      })
      return {
        sourceRef: { id: input.id, revision: input.revision },
        content: input.draft,
        contentDigest: input.digest,
        validationReceipt: input.validationReceipt,
      }
    },

    async retire(id, now) {
      const result = db
        .update(customEventSourceDefinitions)
        .set({ retiredAt: now, updatedAt: now })
        .where(
          and(
            eq(customEventSourceDefinitions.id, id),
            isNull(customEventSourceDefinitions.retiredAt),
          ),
        )
        .run()
      return (result as unknown as { changes?: number }).changes === 1
    },

    async getPublished(ref) {
      const row = db
        .select()
        .from(customEventSourceRevisions)
        .where(
          and(
            eq(customEventSourceRevisions.sourceId, ref.id),
            eq(customEventSourceRevisions.revision, ref.revision),
          ),
        )
        .get()
      if (row === undefined) return null
      return {
        sourceRef: ref,
        content: customEventSourceDraftSchema.parse(JSON.parse(row.contentJson) as unknown),
        contentDigest: row.contentDigest,
        validationReceipt: validationReceipt(row.validationReceiptJson),
      } satisfies PublishedCustomEventSource
    },

    async acceptsNewSubscriptions(ref) {
      const definition = db
        .select({ retiredAt: customEventSourceDefinitions.retiredAt })
        .from(customEventSourceDefinitions)
        .where(eq(customEventSourceDefinitions.id, ref.id))
        .get()
      if (definition === undefined) return true
      if (definition.retiredAt !== null) return false
      return (
        db
          .select({ sourceId: customEventSourceRevisions.sourceId })
          .from(customEventSourceRevisions)
          .where(
            and(
              eq(customEventSourceRevisions.sourceId, ref.id),
              eq(customEventSourceRevisions.revision, ref.revision),
            ),
          )
          .get() !== undefined
      )
    },
  }
}
