// RFC-359 W12 — one journal reader and expected-state settlement for both clients.

import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { resourceBundleApplies } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type {
  ResourcePackageApplyJournalPort,
  ResourcePackageApplyJournalSnapshot,
} from '../application/resourcePackageMaintenance'

export function createResourcePackageApplyJournalPort(
  db: ProviderNeutralDatabase,
): ResourcePackageApplyJournalPort {
  return Object.freeze({
    async list(): Promise<readonly ResourcePackageApplyJournalSnapshot[]> {
      const rows = await db.select().from(resourceBundleApplies)
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            id: row.id,
            state: row.state,
            preparedArtifactsJson: row.preparedArtifactsJson,
            receiptJson: row.receiptJson,
            updatedAt: row.updatedAt,
          }),
        ),
      )
    },
    async settleFailed(
      command: Parameters<ResourcePackageApplyJournalPort['settleFailed']>[0],
    ): Promise<boolean> {
      return databaseSessionFor(db).transaction(async (tx) => {
        const settled = await tx
          .update(resourceBundleApplies)
          .set({ state: 'failed', error: command.error, updatedAt: command.updatedAt })
          .where(
            and(
              eq(resourceBundleApplies.id, command.id),
              eq(resourceBundleApplies.state, command.expectedState),
            ),
          )
          .returning({ id: resourceBundleApplies.id })
          .get()
        return settled !== undefined
      })
    },
  })
}
