import type {
  SkillCatalogBootParticipant,
  SkillSnapshotReverifyReceipt,
} from '../../public/participants'
import { skillCatalogBootParticipantBrand } from '../../domain/participantBrands'

/** Provider-private mechanics consumed by the owner factory. */
export interface SkillCatalogBootAdapter {
  recoverOperations(): Promise<{
    readonly total: number
    readonly rolledBack: number
    readonly rolledForward: number
    readonly quarantined: number
  }>
  activateAvailabilityGate(): void
  reconcileLiveFiles(): Promise<void>
  reverifySnapshots(): Promise<SkillSnapshotReverifyReceipt>
}

/** The sole owner factory for the nominal public boot capability. */
export function createSkillCatalogBootParticipant(
  adapter: SkillCatalogBootAdapter,
): SkillCatalogBootParticipant {
  const participant = Object.freeze({
    [skillCatalogBootParticipantBrand]: 'skill-catalog-boot-participant' as const,
    recoverOperations: () => adapter.recoverOperations(),
    activateAvailabilityGate: () => adapter.activateAvailabilityGate(),
    reconcileLiveFiles: () => adapter.reconcileLiveFiles(),
    reverifySnapshots: () => adapter.reverifySnapshots(),
  })
  return participant
}
