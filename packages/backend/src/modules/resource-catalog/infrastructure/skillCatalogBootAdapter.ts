import type { ProviderNeutralDatabase } from '@/db/query'
import type { SkillCatalogBootAdapter } from '../application/skills/skillCatalogBootParticipant'
import { activateBootReverify, runBootSnapshotReverify } from './legacy/skillBootVerify'
import { runSkillIdentityMigrationBarrier } from './legacy/skillIdentityMigration'
import { backfillLegacySkillVersions, reconcileSkillLiveFiles } from './legacy/skillVersion'

/** RFC-359 W4-D23c：崩溃安全的启动状态机，一份适配器两个数据库共用。 */
export function createSkillCatalogBootAdapter(input: {
  readonly db: ProviderNeutralDatabase
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
