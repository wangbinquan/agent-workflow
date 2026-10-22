import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError } from '@/util/errors'
import type { GraphDesignStore, GraphStoredLink } from '../../application/ports/graphDesignStore'

const conflict = (code: string) => new ConflictError(code, code)

/** The same compare-and-swap transactions execute on SQLite and PostgreSQL. */
export function createGraphDesignStore(db: PersistenceDb): GraphDesignStore {
  const session = databaseSessionFor(db)
  const find: GraphDesignStore['find'] = async (id) => {
    const { developmentDesigns } = tablesOf(db)
    return (
      (
        await db.select().from(developmentDesigns).where(eq(developmentDesigns.id, id)).limit(1)
      )[0] ?? null
    )
  }
  const findByCase: GraphDesignStore['findByCase'] = async (caseId) => {
    const { developmentDesigns } = tablesOf(db)
    return (
      (
        await db
          .select()
          .from(developmentDesigns)
          .where(eq(developmentDesigns.caseId, caseId))
          .limit(1)
      )[0] ?? null
    )
  }
  const record: GraphDesignStore['record'] = async (id, recordId) => {
    const { developmentDesignProposals } = tablesOf(db)
    return (
      (
        await db
          .select()
          .from(developmentDesignProposals)
          .where(
            and(
              eq(developmentDesignProposals.designId, id),
              eq(developmentDesignProposals.id, recordId),
            ),
          )
          .limit(1)
      )[0] ?? null
    )
  }
  return {
    find,
    findByCase,
    record,
    async create(identity, revision) {
      await session.transaction(async (tx) => {
        const { developmentDesigns, developmentDesignRevisions } = tablesOf(tx)
        const inserted = await tx
          .insert(developmentDesigns)
          .values(identity)
          .onConflictDoNothing()
          .returning({ id: developmentDesigns.id })
        if (inserted.length) await insertOne(tx, developmentDesignRevisions, revision)
      })
      const value = await findByCase(identity.caseId)
      if (!value) throw conflict('graph-design-create-conflict')
      return value
    },
    async revision(id, revision) {
      const { developmentDesignRevisions } = tablesOf(db)
      return (
        (
          await db
            .select()
            .from(developmentDesignRevisions)
            .where(
              and(
                eq(developmentDesignRevisions.designId, id),
                eq(developmentDesignRevisions.revision, revision),
              ),
            )
            .limit(1)
        )[0] ?? null
      )
    },
    async revisions(id) {
      const { developmentDesignRevisions } = tablesOf(db)
      return await db
        .select()
        .from(developmentDesignRevisions)
        .where(eq(developmentDesignRevisions.designId, id))
        .orderBy(asc(developmentDesignRevisions.revision))
    },
    async commit(input) {
      return await session.transaction(async (tx) => {
        const next = input.revision
        const receiptId = `change:${next.requestId}`
        const { developmentDesignProposals, developmentDesigns, developmentDesignRevisions } =
          tablesOf(tx)
        // Claim before changing the pointer; ON CONFLICT serializes identical concurrent requests.
        const claimed = await tx
          .insert(developmentDesignProposals)
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
          .returning({ id: developmentDesignProposals.id })
        if (!claimed.length) {
          const previous = (
            await tx
              .select()
              .from(developmentDesignProposals)
              .where(
                and(
                  eq(developmentDesignProposals.designId, next.designId),
                  eq(developmentDesignProposals.id, receiptId),
                ),
              )
              .limit(1)
          )[0]
          if (!previous || previous.requestDigest !== input.requestDigest)
            throw conflict('graph-request-reused-with-different-input')
          const original = (
            await tx
              .select()
              .from(developmentDesignRevisions)
              .where(
                and(
                  eq(developmentDesignRevisions.designId, next.designId),
                  eq(developmentDesignRevisions.requestId, next.requestId),
                ),
              )
              .limit(1)
          )[0]
          if (!original) throw conflict('graph-change-receipt-incomplete')
          return original
        }
        if (next.revision !== input.expectedRevision + 1)
          throw conflict('graph-invalid-next-revision')
        const changed = await tx
          .update(developmentDesigns)
          .set({ revision: next.revision, updatedAt: next.createdAt })
          .where(
            and(
              eq(developmentDesigns.id, next.designId),
              eq(developmentDesigns.revision, input.expectedRevision),
            ),
          )
          .returning({ id: developmentDesigns.id })
        if (changed.length !== 1) throw conflict('graph-design-revision-conflict')
        await insertOne(tx, developmentDesignRevisions, next)
        return next
      })
    },
    async presentation(input) {
      const { developmentDesigns } = tablesOf(db)
      const updated = await db
        .update(developmentDesigns)
        .set({
          presentationJson: input.json,
          presentationRevision: input.expectedRevision + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(developmentDesigns.id, input.id),
            eq(developmentDesigns.presentationRevision, input.expectedRevision),
          ),
        )
        .returning({ id: developmentDesigns.id })
      if (updated.length !== 1) throw conflict('graph-presentation-revision-conflict')
    },
    async records(id) {
      const { developmentDesignProposals } = tablesOf(db)
      return await db
        .select()
        .from(developmentDesignProposals)
        .where(eq(developmentDesignProposals.designId, id))
        .orderBy(asc(developmentDesignProposals.createdAt), asc(developmentDesignProposals.id))
    },
    async insertRecord(value) {
      const { developmentDesignProposals } = tablesOf(db)
      await db.insert(developmentDesignProposals).values(value).onConflictDoNothing()
      const stored = await record(value.designId, value.id)
      if (!stored || stored.requestDigest !== value.requestDigest || stored.kind !== value.kind)
        throw conflict('graph-request-reused-with-different-input')
      return stored
    },
    async updateRecord(value, expectedVersion) {
      if (value.version !== expectedVersion + 1) throw conflict('graph-invalid-record-version')
      const { developmentDesignProposals } = tablesOf(db)
      const updated = await db
        .update(developmentDesignProposals)
        .set({
          status: value.status,
          version: value.version,
          payloadJson: value.payloadJson,
          updatedAt: value.updatedAt,
        })
        .where(
          and(
            eq(developmentDesignProposals.designId, value.designId),
            eq(developmentDesignProposals.id, value.id),
            eq(developmentDesignProposals.version, expectedVersion),
            eq(developmentDesignProposals.requestDigest, value.requestDigest),
          ),
        )
        .returning({ id: developmentDesignProposals.id })
      if (updated.length !== 1) throw conflict('graph-record-revision-conflict')
    },
    async interruptRunningActions(now) {
      const { developmentDesignProposals } = tablesOf(db)
      await db
        .update(developmentDesignProposals)
        .set({
          status: 'interrupted',
          version: sql`${developmentDesignProposals.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(developmentDesignProposals.kind, 'action'),
            eq(developmentDesignProposals.status, 'running'),
          ),
        )
    },
    async basis(id, basisId) {
      const { developmentDesignBaselines } = tablesOf(db)
      return (
        (
          await db
            .select()
            .from(developmentDesignBaselines)
            .where(
              and(
                eq(developmentDesignBaselines.designId, id),
                eq(developmentDesignBaselines.id, basisId),
              ),
            )
            .limit(1)
        )[0] ?? null
      )
    },
    async bases(id) {
      const { developmentDesignBaselines } = tablesOf(db)
      return await db
        .select()
        .from(developmentDesignBaselines)
        .where(eq(developmentDesignBaselines.designId, id))
        .orderBy(asc(developmentDesignBaselines.createdAt), asc(developmentDesignBaselines.id))
    },
    async insertBasis(value) {
      const { developmentDesignBaselines } = tablesOf(db)
      await db.insert(developmentDesignBaselines).values(value).onConflictDoNothing()
      const stored = (
        await db
          .select()
          .from(developmentDesignBaselines)
          .where(
            and(
              eq(developmentDesignBaselines.designId, value.designId),
              eq(developmentDesignBaselines.id, value.id),
            ),
          )
          .limit(1)
      )[0]
      if (!stored || stored.digest !== value.digest) throw conflict('graph-basis-identity-conflict')
      return stored
    },
    async links(id) {
      const { developmentDesignLinks } = tablesOf(db)
      return (await db
        .select()
        .from(developmentDesignLinks)
        .where(eq(developmentDesignLinks.designId, id))
        .orderBy(
          asc(developmentDesignLinks.createdAt),
          asc(developmentDesignLinks.id),
        )) as GraphStoredLink[]
    },
    async insertLink(value) {
      const { developmentDesignLinks } = tablesOf(db)
      await db.insert(developmentDesignLinks).values(value).onConflictDoNothing()
      const stored = (
        await db
          .select()
          .from(developmentDesignLinks)
          .where(
            and(
              eq(developmentDesignLinks.designId, value.designId),
              eq(developmentDesignLinks.id, value.id),
            ),
          )
          .limit(1)
      )[0]
      if (!stored || stored.kind !== value.kind || stored.payloadJson !== value.payloadJson)
        throw conflict('graph-link-identity-conflict')
    },
  }
}
