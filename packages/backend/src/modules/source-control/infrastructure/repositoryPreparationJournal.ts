import { and, eq } from 'drizzle-orm'
import { scPreparationOperations, scRepositorySnapshots, scRepositorySources } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { ConflictError } from '@/util/errors'
import { canAdvanceRepositoryPreparation } from '../domain/repositoryPreparationState'
import type { RepositoryPreparationJournal } from '../application/ports/repositoryPreparationJournal'

/** The caller supplies its live transaction for admission. Effects use the normal DB handle. */
export function createRepositoryPreparationJournal(
  db: ProviderNeutralDatabase,
): RepositoryPreparationJournal {
  return {
    async source(id) {
      return (
        (await db.select().from(scRepositorySources).where(eq(scRepositorySources.id, id)))[0] ??
        null
      )
    },
    async sourceByRequest(requestKey) {
      return (
        (
          await db
            .select()
            .from(scRepositorySources)
            .where(eq(scRepositorySources.requestKey, requestKey))
        )[0] ?? null
      )
    },
    async seal(input) {
      await db.insert(scRepositorySources).values(input).onConflictDoNothing()
      const row = (
        await db
          .select()
          .from(scRepositorySources)
          .where(eq(scRepositorySources.requestKey, input.requestKey))
      )[0]
      if (
        !row ||
        row.requestDigest !== input.requestDigest ||
        row.kind !== input.kind ||
        row.factsJson !== input.factsJson
      )
        throw new ConflictError(
          'repository-source-request-mismatch',
          'repository source request changed',
        )
      return row
    },
    async snapshot(id) {
      return (
        (
          await db.select().from(scRepositorySnapshots).where(eq(scRepositorySnapshots.id, id))
        )[0] ?? null
      )
    },
    async freeze(input) {
      await db.insert(scRepositorySnapshots).values(input).onConflictDoNothing()
      const row = (
        await db.select().from(scRepositorySnapshots).where(eq(scRepositorySnapshots.id, input.id))
      )[0]
      if (
        !row ||
        row.sourceRef !== input.sourceRef ||
        row.revision !== input.revision ||
        row.factsJson !== input.factsJson
      )
        throw new ConflictError('repository-snapshot-mismatch', 'repository snapshot is immutable')
      return row
    },
    async operation(id) {
      return (
        (
          await db.select().from(scPreparationOperations).where(eq(scPreparationOperations.id, id))
        )[0] ?? null
      )
    },
    async plan(input) {
      await db
        .insert(scPreparationOperations)
        .values({
          id: input.id,
          snapshotRef: input.snapshotRef,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
      const row = (
        await db
          .select()
          .from(scPreparationOperations)
          .where(eq(scPreparationOperations.id, input.id))
      )[0]
      if (!row || row.snapshotRef !== input.snapshotRef)
        throw new ConflictError(
          'repository-preparation-source-mismatch',
          'preparation operation belongs to another snapshot',
        )
      return row
    },
    async advance(input) {
      if (!canAdvanceRepositoryPreparation(input.from, input.to))
        throw new ConflictError(
          'repository-preparation-transition-invalid',
          'invalid preparation transition',
        )
      if (input.to === 'materializing' && input.resolvedJson === undefined)
        throw new ConflictError(
          'repository-preparation-commits-missing',
          'resolved commits must be recorded before materialization',
        )
      if (
        input.to === 'prepared' &&
        (input.receiptRef === undefined || input.receiptJson === undefined)
      )
        throw new ConflictError(
          'repository-preparation-receipt-missing',
          'prepared workspace requires a durable receipt',
        )
      // No later transition may change the first resolved commits or successful receipt.
      if (
        (input.resolvedJson !== undefined && input.to !== 'materializing') ||
        ((input.receiptRef !== undefined || input.receiptJson !== undefined) &&
          input.to !== 'prepared')
      )
        throw new ConflictError(
          'repository-preparation-facts-immutable',
          'preparation facts cannot be replaced',
        )
      const rows = await db
        .update(scPreparationOperations)
        .set({
          state: input.to,
          version: input.expectedVersion + 1,
          updatedAt: input.now,
          ...(input.resolvedJson === undefined ? {} : { resolvedJson: input.resolvedJson }),
          ...(input.receiptRef === undefined ? {} : { receiptRef: input.receiptRef }),
          ...(input.receiptJson === undefined ? {} : { receiptJson: input.receiptJson }),
          ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
          ...(input.diagnosticsJson === undefined
            ? {}
            : { diagnosticsJson: input.diagnosticsJson }),
        })
        .where(
          and(
            eq(scPreparationOperations.id, input.id),
            eq(scPreparationOperations.version, input.expectedVersion),
            eq(scPreparationOperations.state, input.from),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
  }
}
