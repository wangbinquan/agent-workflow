import type { ProviderNeutralDatabase } from '@/db/query'
import type { SkillCatalogBootAdapter } from '../application/skills/skillCatalogBootParticipant'
import { activateBootReverify, runBootSnapshotReverify } from './legacy/skillBootVerify'
import { runSkillIdentityMigrationBarrier } from './legacy/skillIdentityMigration'
import type {
  SkillLifecycleContentStore,
  SkillSnapshotInspector,
} from '../application/skills/lifecycleContentStore'
import type { SkillDeletionContentStore } from '../application/skills/deletionContentStore'
import type { SkillVersionRecoveryContentStore } from '../application/skills/versionRecoveryContentStore'
import type { SkillIdentityContentStore } from '../application/skills/identityContentStore'
import type { SkillIdentityInspector } from '../application/skills/identityInspector'
import type { SkillCreationContentStore } from '../application/skills/creationContentStore'
import { createFileSkillVersionRecoveryContentStore } from './local/fileSkillVersionRecoveryContentStore'
import { createFileSkillIdentityContentStore } from './local/fileSkillIdentityContentStore'
import { createFileSkillIdentityInspector } from './local/fileSkillIdentityInspector'
import { createFileSkillLifecycleContentStore } from './local/fileSkillLifecycleContentStore'
import { createFileSkillSnapshotInspector } from './local/fileSkillSnapshotInspector'
import { createFileSkillDeletionContentStore } from './local/fileSkillDeletionContentStore'
import { backfillLegacySkillVersions, reconcileSkillLiveFiles } from './legacy/skillVersion'

/** RFC-359 W4-D23c：崩溃安全的启动状态机，一份适配器两个数据库共用。 */
export function createSkillCatalogBootAdapter(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly lifecycleContent?: SkillLifecycleContentStore
  readonly snapshotInspector?: SkillSnapshotInspector
  readonly deletionContent?: SkillDeletionContentStore
  readonly creationContent?: SkillCreationContentStore
  readonly versionRecovery?: SkillVersionRecoveryContentStore
  readonly identityContent?: SkillIdentityContentStore
  readonly identityInspector?: SkillIdentityInspector
}): SkillCatalogBootAdapter {
  const selected = {
    ...input,
    identityContent: input.identityContent ?? createFileSkillIdentityContentStore(input.appHome),
    identityInspector: input.identityInspector ?? createFileSkillIdentityInspector(input.appHome),
    lifecycleContent: input.lifecycleContent ?? createFileSkillLifecycleContentStore(input.appHome),
    snapshotInspector: input.snapshotInspector ?? createFileSkillSnapshotInspector(input.appHome),
    deletionContent: input.deletionContent ?? createFileSkillDeletionContentStore(input.appHome),
    versionRecovery:
      input.versionRecovery ?? createFileSkillVersionRecoveryContentStore(input.appHome),
  }
  return Object.freeze({
    runIdentityMigrationBarrier: async () =>
      Object.freeze(await runSkillIdentityMigrationBarrier(input.db, selected)),
    activateAvailabilityGate: () => activateBootReverify(),
    reconcileLiveFiles: async () => await reconcileSkillLiveFiles(input.db, selected),
    backfillLegacyVersions: async () =>
      Object.freeze(await backfillLegacySkillVersions(input.db, selected)),
    reverifySnapshots: async () => Object.freeze(await runBootSnapshotReverify(input.db, selected)),
  })
}
