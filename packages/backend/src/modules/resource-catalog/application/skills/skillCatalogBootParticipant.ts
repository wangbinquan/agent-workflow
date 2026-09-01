import type {
  SkillCatalogBootParticipant,
  SkillIdentityMigrationReceipt,
  SkillLegacyVersionBackfillReceipt,
  SkillSnapshotReverifyReceipt,
} from '../../public/participants'
import { skillCatalogBootParticipantBrand } from '../../domain/participantBrands'

/** Provider-private mechanics consumed by the owner factory. */
export interface SkillCatalogBootAdapter {
  runIdentityMigrationBarrier(): Promise<SkillIdentityMigrationReceipt>
  activateAvailabilityGate(): void
  reconcileLiveFiles(): Promise<void>
  backfillLegacyVersions(): Promise<SkillLegacyVersionBackfillReceipt>
  reverifySnapshots(): Promise<SkillSnapshotReverifyReceipt>
}

/** The sole owner factory for the nominal public boot capability. */
export function createSkillCatalogBootParticipant(
  adapter: SkillCatalogBootAdapter,
): SkillCatalogBootParticipant {
  const participant = Object.freeze({
    [skillCatalogBootParticipantBrand]: 'skill-catalog-boot-participant' as const,
    runIdentityMigrationBarrier: () => adapter.runIdentityMigrationBarrier(),
    activateAvailabilityGate: () => adapter.activateAvailabilityGate(),
    reconcileLiveFiles: () => adapter.reconcileLiveFiles(),
    backfillLegacyVersions: () => adapter.backfillLegacyVersions(),
    reverifySnapshots: () => adapter.reverifySnapshots(),
  })
  return participant
}
