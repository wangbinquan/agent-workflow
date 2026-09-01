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
    runIdentityMigrationBarrier: () =>
      Promise.resolve(Object.freeze(runSkillIdentityMigrationBarrier(input.db, input))),
    activateAvailabilityGate: () => activateBootReverify(),
    reconcileLiveFiles: () => Promise.resolve(reconcileSkillLiveFiles(input.db, input)),
    backfillLegacyVersions: () =>
      Promise.resolve(Object.freeze(backfillLegacySkillVersions(input.db, input))),
    reverifySnapshots: () =>
      Promise.resolve(Object.freeze(runBootSnapshotReverify(input.db, input))),
  })
}
