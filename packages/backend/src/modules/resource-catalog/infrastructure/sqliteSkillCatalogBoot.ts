import type { DbClient } from '@/db/client'
import type { SkillCatalogBootAdapter } from '../application/skills/skillCatalogBootParticipant'
import { activateBootReverify, runBootSnapshotReverify } from './legacy/skillBootVerify'
import { runSkillIdentityMigrationBarrier } from './legacy/skillIdentityMigration'
import { backfillLegacySkillVersions, reconcileSkillLiveFiles } from './legacy/skillVersion'

/** SQLite owner adapter over the existing crash-safe boot state machines. */
export function createSqliteSkillCatalogBootAdapter(input: {
  readonly db: DbClient
  readonly appHome: string
}): SkillCatalogBootAdapter {
  return Object.freeze({
    runIdentityMigrationBarrier: async () =>
      Object.freeze(await runSkillIdentityMigrationBarrier(input.db, input)),
    activateAvailabilityGate: () => activateBootReverify(),
    reconcileLiveFiles: async () => await reconcileSkillLiveFiles(input.db, input),
    backfillLegacyVersions: async () =>
      Object.freeze(await backfillLegacySkillVersions(input.db, input)),
    reverifySnapshots: async () => Object.freeze(await runBootSnapshotReverify(input.db, input)),
  })
}
