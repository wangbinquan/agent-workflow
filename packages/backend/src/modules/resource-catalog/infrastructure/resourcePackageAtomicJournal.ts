import { and, eq } from 'drizzle-orm'
import type { AtomicApplyJournal } from '@/platform/contracts/atomicApply'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'

type Row = PersistenceTables['resourceBundleApplies']['$inferSelect']
interface Key {
  readonly scope: string
  readonly key: string
}
interface Insert extends Key {
  readonly actorUserId: string
}
export function createResourcePackageAtomicJournal(
  db: PersistenceDb,
): AtomicApplyJournal<PersistenceTx, Key, Insert, Row> {
  return {
    transaction: (run) => databaseSessionFor(db).transaction(run),
    async find(tx, key) {
      const { resourceBundleApplies: table } = tablesOf(tx)
      return first(
        tx
          .select()
          .from(table)
          .where(and(eq(table.scope, key.scope), eq(table.key, key.key))),
      )
    },
    async insert(tx, row, data) {
      const { resourceBundleApplies: table } = tablesOf(tx)
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
      const { resourceBundleApplies: table } = tablesOf(tx)
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
      const { resourceBundleApplies } = tablesOf(db)
      return db.select().from(resourceBundleApplies)
    },
  }
}
