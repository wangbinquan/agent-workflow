// RFC-370 v3 V6 — assemble the neutral hosted object publication journal.
// Every hosted root (serving slot and maintenance Worker) composes the same
// journal; owners receive only its public participant.
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationStreamObjectStorage } from '@/platform/crewstation/objectStorage'
import type {
  HostedObjectOwnerSweep,
  HostedObjectPublicationMaintenance,
} from '../infrastructure/crewstation/objectPublicationContract'
import { createHostedBackupReleaseHorizon } from '../infrastructure/crewstation/backupReleaseHorizon'
import { createHostedObjectPublications } from '../infrastructure/crewstation/objectPublications'

export function composeCrewStationObjectPublications(input: {
  readonly db: ProviderNeutralDatabase
  readonly fence: CrewStationMutationFence
  readonly objects: CrewStationStreamObjectStorage
  readonly sealer?: { seal(plaintext: string): string; unseal(packed: string): string }
}) {
  const journal = createHostedObjectPublications(input)
  return {
    publications: journal.publications,
    /** The single maintenance job body, run by the maintenance Worker. */
    maintenance: (sweeps: readonly HostedObjectOwnerSweep[]): HostedObjectPublicationMaintenance =>
      journal.maintenance({ horizon: createHostedBackupReleaseHorizon(input), sweeps }),
  }
}
