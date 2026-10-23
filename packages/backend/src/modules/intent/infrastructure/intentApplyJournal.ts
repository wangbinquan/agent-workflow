import { and, eq } from 'drizzle-orm'
import type { AtomicApplyJournal } from '@/platform/contracts/atomicApply'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'

type Row = PersistenceTables['intentApplyJournal']['$inferSelect']
interface Key {
  readonly sessionId: string
  readonly clientMutationId: string
}
interface Insert extends Key {
  readonly draftId: string
  readonly draftHash: string
}

export function createIntentApplyJournal(
  db: PersistenceDb,
): AtomicApplyJournal<PersistenceTx, Key, Insert, Row> {
  return {
    transaction: (run) => databaseSessionFor(db).transaction(run),
    async find(tx, key) {
      const { intentApplyJournal: table } = tablesOf(tx)
      return first(
        tx
          .select()
          .from(table)
          .where(
            and(
              eq(table.sessionId, key.sessionId),
              eq(table.clientMutationId, key.clientMutationId),
            ),
          ),
      )
    },
    async insert(tx, row, data) {
      const { intentApplyJournal: table } = tablesOf(tx)
      return (
        (await first(
          tx
            .insert(table)
            .values({ ...row, ...data })
            .onConflictDoNothing()
            .returning({ id: table.id }),
        )) !== undefined
      )
    },
    async compareAndSet(tx, id, expected, patch) {
      const { intentApplyJournal: table } = tablesOf(tx)
      return (
        (await first(
          tx
            .update(table)
            .set(patch)
            .where(and(eq(table.id, id), eq(table.state, expected)))
            .returning({ id: table.id }),
        )) !== undefined
      )
    },
    list() {
      const { intentApplyJournal } = tablesOf(db)
      return db.select().from(intentApplyJournal)
    },
  }
}
