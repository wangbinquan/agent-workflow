// RFC-359 W4-B6 —— 自定义事件源存储：一份实现，两个 provider 共用。
// 发布走统一事务；最后一步对定义行做 CAS（草稿与已发布修订未变、未退役），PG 的 READ COMMITTED 下需要它，
// SQLite 独占事务下恒成立。

import { and, desc, eq, isNull } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  customEventSourceDefinitions,
  customEventSourceRevisions,
  eventSources,
  eventTypeCatalog,
} from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
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

export function createCustomEventSourceStore(
  db: ProviderNeutralDatabase,
): CustomEventSourceStorePort {
  const record = async (
    row: typeof customEventSourceDefinitions.$inferSelect,
  ): Promise<CustomEventSourceAuthoringRecord> => {
    const published =
      row.publishedRevision === null
        ? undefined
        : (
            await db
              .select({ contentDigest: customEventSourceRevisions.contentDigest })
              .from(customEventSourceRevisions)
              .where(
                and(
                  eq(customEventSourceRevisions.sourceId, row.id),
                  eq(customEventSourceRevisions.revision, row.publishedRevision),
                ),
              )
              .limit(1)
          )[0]
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

  const definition = async (id: string) =>
    (
      await db
        .select()
        .from(customEventSourceDefinitions)
        .where(eq(customEventSourceDefinitions.id, id))
        .limit(1)
    )[0]

  return {
    async create(input) {
      await db.insert(customEventSourceDefinitions).values({
        id: input.id,
        draftJson: JSON.stringify(input.draft),
        publishedRevision: null,
        ownerUserId: input.ownerUserId,
        createdAt: input.now,
        updatedAt: input.now,
        retiredAt: null,
      })
      const created = await definition(input.id)
      if (created === undefined) throw new Error('custom event source insert was not visible')
      return await record(created)
    },

    async get(id) {
      const row = await definition(id)
      return row === undefined ? null : await record(row)
    },

    async list() {
      const rows = await db
        .select()
        .from(customEventSourceDefinitions)
        .orderBy(
          desc(customEventSourceDefinitions.updatedAt),
          desc(customEventSourceDefinitions.id),
        )
      return await Promise.all(rows.map(record))
    },

    async update(input) {
      const changed = await db
        .update(customEventSourceDefinitions)
        .set({ draftJson: JSON.stringify(input.draft), updatedAt: input.now })
        .where(
          and(
            eq(customEventSourceDefinitions.id, input.id),
            isNull(customEventSourceDefinitions.retiredAt),
          ),
        )
        .returning({ id: customEventSourceDefinitions.id })
      if (changed.length !== 1) return null
      const row = await definition(input.id)
      return row === undefined ? null : await record(row)
    },

    async publish(input) {
      await databaseSessionFor(db).transaction(async (tx) => {
        const current = (
          await tx
            .select()
            .from(customEventSourceDefinitions)
            .where(eq(customEventSourceDefinitions.id, input.id))
            .limit(1)
        )[0]
        if (current === undefined || current.retiredAt !== null) {
          throw new Error('custom event source is unavailable')
        }
        if ((current.publishedRevision ?? 0) + 1 !== input.revision) {
          throw new Error('custom event source publish revision conflict')
        }
        if (current.draftJson !== JSON.stringify(input.draft)) {
          throw new Error('custom event source draft changed during validation')
        }

        await tx.insert(customEventSourceRevisions).values({
          sourceId: input.id,
          revision: input.revision,
          contentJson: JSON.stringify(input.draft),
          contentDigest: input.digest,
          validationReceiptJson: JSON.stringify(input.validationReceipt),
          publishedAt: input.now,
          publishedBy: input.actorUserId,
        })
        await tx.insert(eventSources).values({
          sourceId: input.source.sourceRef.id,
          revision: input.source.sourceRef.revision,
          descriptorJson: JSON.stringify(input.source),
          descriptorDigest: input.digest,
          state: 'published',
          registeredAt: input.now,
        })
        for (const eventType of input.eventTypes) {
          await tx.insert(eventTypeCatalog).values({
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
        }
        const published = await tx
          .update(customEventSourceDefinitions)
          .set({ publishedRevision: input.revision, updatedAt: input.now })
          .where(
            and(
              eq(customEventSourceDefinitions.id, input.id),
              isNull(customEventSourceDefinitions.retiredAt),
              eq(customEventSourceDefinitions.draftJson, current.draftJson),
              current.publishedRevision === null
                ? isNull(customEventSourceDefinitions.publishedRevision)
                : eq(customEventSourceDefinitions.publishedRevision, current.publishedRevision),
            ),
          )
          .returning({ id: customEventSourceDefinitions.id })
        if (published.length !== 1) {
          throw new Error('custom event source changed during publish')
        }
      })
      return {
        sourceRef: { id: input.id, revision: input.revision },
        content: input.draft,
        contentDigest: input.digest,
        validationReceipt: input.validationReceipt,
      }
    },

    async retire(id, now) {
      const retired = await db
        .update(customEventSourceDefinitions)
        .set({ retiredAt: now, updatedAt: now })
        .where(
          and(
            eq(customEventSourceDefinitions.id, id),
            isNull(customEventSourceDefinitions.retiredAt),
          ),
        )
        .returning({ id: customEventSourceDefinitions.id })
      return retired.length === 1
    },

    async getPublished(ref) {
      const row = (
        await db
          .select()
          .from(customEventSourceRevisions)
          .where(
            and(
              eq(customEventSourceRevisions.sourceId, ref.id),
              eq(customEventSourceRevisions.revision, ref.revision),
            ),
          )
          .limit(1)
      )[0]
      if (row === undefined) return null
      return {
        sourceRef: ref,
        content: customEventSourceDraftSchema.parse(JSON.parse(row.contentJson) as unknown),
        contentDigest: row.contentDigest,
        validationReceipt: validationReceipt(row.validationReceiptJson),
      } satisfies PublishedCustomEventSource
    },

    async acceptsNewSubscriptions(ref) {
      const definitionRow = (
        await db
          .select({ retiredAt: customEventSourceDefinitions.retiredAt })
          .from(customEventSourceDefinitions)
          .where(eq(customEventSourceDefinitions.id, ref.id))
          .limit(1)
      )[0]
      if (definitionRow === undefined) return true
      if (definitionRow.retiredAt !== null) return false
      return (
        (
          await db
            .select({ sourceId: customEventSourceRevisions.sourceId })
            .from(customEventSourceRevisions)
            .where(
              and(
                eq(customEventSourceRevisions.sourceId, ref.id),
                eq(customEventSourceRevisions.revision, ref.revision),
              ),
            )
            .limit(1)
        ).length > 0
      )
    },
  }
}
