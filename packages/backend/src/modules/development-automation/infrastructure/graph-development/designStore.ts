import { and, asc, eq, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  developmentDesigns as designs,
  developmentDesignRevisions as revisions,
  developmentDesignProposals as records,
  developmentDesignBaselines as bases,
  developmentDesignLinks as links,
} from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError } from '@/util/errors'
import type { GraphDesignStore, GraphStoredLink } from '../../application/ports/graphDesignStore'

const conflict = (code: string) => new ConflictError(code, code)

/** The same compare-and-swap transactions execute on SQLite and PostgreSQL. */
export function createGraphDesignStore(db: ProviderNeutralDatabase): GraphDesignStore {
  const session = databaseSessionFor(db)
  const find: GraphDesignStore['find'] = async (id) =>
    (await db.select().from(designs).where(eq(designs.id, id)).limit(1))[0] ?? null
  const findByCase: GraphDesignStore['findByCase'] = async (caseId) =>
    (await db.select().from(designs).where(eq(designs.caseId, caseId)).limit(1))[0] ?? null
  const record: GraphDesignStore['record'] = async (id, recordId) =>
    (
      await db
        .select()
        .from(records)
        .where(and(eq(records.designId, id), eq(records.id, recordId)))
        .limit(1)
    )[0] ?? null
  return {
    find,
    findByCase,
    record,
    async create(identity, revision) {
      await session.transaction(async (tx) => {
        const inserted = await tx
          .insert(designs)
          .values(identity)
          .onConflictDoNothing()
          .returning({ id: designs.id })
        if (inserted.length) await tx.insert(revisions).values(revision)
      })
      const value = await findByCase(identity.caseId)
      if (!value) throw conflict('graph-design-create-conflict')
      return value
    },
    async revision(id, revision) {
      return (
        (
          await db
            .select()
            .from(revisions)
            .where(and(eq(revisions.designId, id), eq(revisions.revision, revision)))
            .limit(1)
        )[0] ?? null
      )
    },
    async revisions(id) {
      return await db
        .select()
        .from(revisions)
        .where(eq(revisions.designId, id))
        .orderBy(asc(revisions.revision))
    },
    async commit(input) {
      return await session.transaction(async (tx) => {
        const next = input.revision
        const receiptId = `change:${next.requestId}`
        // Claim before changing the pointer; ON CONFLICT serializes identical concurrent requests.
        const claimed = await tx
          .insert(records)
          .values({
            designId: next.designId,
            id: receiptId,
            kind: 'change',
            requestDigest: input.requestDigest,
            status: 'accepted',
            version: 1,
            payloadJson: JSON.stringify(next),
            createdAt: next.createdAt,
            updatedAt: next.createdAt,
          })
          .onConflictDoNothing()
          .returning({ id: records.id })
        if (!claimed.length) {
          const previous = (
            await tx
              .select()
              .from(records)
              .where(and(eq(records.designId, next.designId), eq(records.id, receiptId)))
              .limit(1)
          )[0]
          if (!previous || previous.requestDigest !== input.requestDigest)
            throw conflict('graph-request-reused-with-different-input')
          const original = (
            await tx
              .select()
              .from(revisions)
              .where(
                and(eq(revisions.designId, next.designId), eq(revisions.requestId, next.requestId)),
              )
              .limit(1)
          )[0]
          if (!original) throw conflict('graph-change-receipt-incomplete')
          return original
        }
        if (next.revision !== input.expectedRevision + 1)
          throw conflict('graph-invalid-next-revision')
        const changed = await tx
          .update(designs)
          .set({ revision: next.revision, updatedAt: next.createdAt })
          .where(and(eq(designs.id, next.designId), eq(designs.revision, input.expectedRevision)))
          .returning({ id: designs.id })
        if (changed.length !== 1) throw conflict('graph-design-revision-conflict')
        await tx.insert(revisions).values(next)
        return next
      })
    },
    async presentation(input) {
      const updated = await db
        .update(designs)
        .set({
          presentationJson: input.json,
          presentationRevision: input.expectedRevision + 1,
          updatedAt: input.now,
        })
        .where(
          and(eq(designs.id, input.id), eq(designs.presentationRevision, input.expectedRevision)),
        )
        .returning({ id: designs.id })
      if (updated.length !== 1) throw conflict('graph-presentation-revision-conflict')
    },
    async records(id) {
      return await db
        .select()
        .from(records)
        .where(eq(records.designId, id))
        .orderBy(asc(records.createdAt), asc(records.id))
    },
    async insertRecord(value) {
      await db.insert(records).values(value).onConflictDoNothing()
      const stored = await record(value.designId, value.id)
      if (!stored || stored.requestDigest !== value.requestDigest || stored.kind !== value.kind)
        throw conflict('graph-request-reused-with-different-input')
      return stored
    },
    async updateRecord(value, expectedVersion) {
      if (value.version !== expectedVersion + 1) throw conflict('graph-invalid-record-version')
      const updated = await db
        .update(records)
        .set({
          status: value.status,
          version: value.version,
          payloadJson: value.payloadJson,
          updatedAt: value.updatedAt,
        })
        .where(
          and(
            eq(records.designId, value.designId),
            eq(records.id, value.id),
            eq(records.version, expectedVersion),
            eq(records.requestDigest, value.requestDigest),
          ),
        )
        .returning({ id: records.id })
      if (updated.length !== 1) throw conflict('graph-record-revision-conflict')
    },
    async interruptRunningActions(now) {
      await db
        .update(records)
        .set({ status: 'interrupted', version: sql`${records.version} + 1`, updatedAt: now })
        .where(and(eq(records.kind, 'action'), eq(records.status, 'running')))
    },
    async basis(id, basisId) {
      return (
        (
          await db
            .select()
            .from(bases)
            .where(and(eq(bases.designId, id), eq(bases.id, basisId)))
            .limit(1)
        )[0] ?? null
      )
    },
    async bases(id) {
      return await db
        .select()
        .from(bases)
        .where(eq(bases.designId, id))
        .orderBy(asc(bases.createdAt), asc(bases.id))
    },
    async insertBasis(value) {
      await db.insert(bases).values(value).onConflictDoNothing()
      const stored = (
        await db
          .select()
          .from(bases)
          .where(and(eq(bases.designId, value.designId), eq(bases.id, value.id)))
          .limit(1)
      )[0]
      if (!stored || stored.digest !== value.digest) throw conflict('graph-basis-identity-conflict')
      return stored
    },
    async links(id) {
      return (await db
        .select()
        .from(links)
        .where(eq(links.designId, id))
        .orderBy(asc(links.createdAt), asc(links.id))) as GraphStoredLink[]
    },
    async insertLink(value) {
      await db.insert(links).values(value).onConflictDoNothing()
      const stored = (
        await db
          .select()
          .from(links)
          .where(and(eq(links.designId, value.designId), eq(links.id, value.id)))
          .limit(1)
      )[0]
      if (!stored || stored.kind !== value.kind || stored.payloadJson !== value.payloadJson)
        throw conflict('graph-link-identity-conflict')
    },
  }
}
