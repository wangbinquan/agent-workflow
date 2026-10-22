// RFC-370 v3 V5 — assemble hosted database backups: the standalone PostgreSQL
// logical backup format, stored as one CS object through the publication
// journal. Assembly only; provenance and catalog reads live in infrastructure.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationStreamObjectStorage } from '@/platform/crewstation/objectStorage'
import { createPortableBackupApplicationAssets } from '@/platform/persistence/portableApplicationAssets'
import { openPostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { HostedObjectPublications } from '../infrastructure/crewstation/objectPublicationContract'
import { createHostedBackupCatalog } from '../infrastructure/crewstation/databaseBackupCatalog'
import { readHostedDatabaseBackupProvenance } from '../infrastructure/crewstation/databaseBackupProvenance'
import { createHostedDatabaseBackups } from '../infrastructure/crewstation/databaseBackups'
import { sha256Hex } from '@/util/hash'

export function composeCrewStationDatabaseBackups(input: {
  readonly contract: LogicalSchemaContract
  readonly db: PersistenceDb
  readonly runtime: PostgresqlDatabaseRuntime
  readonly fence: CrewStationMutationFence
  readonly objects: Pick<CrewStationStreamObjectStorage, 'stat'>
  readonly publications: HostedObjectPublications
  readonly installation: string
  readonly objectSpaceId: string
  readonly secretKey: Uint8Array
}) {
  const contract = input.contract
  const provenance = () => readHostedDatabaseBackupProvenance(input.runtime, contract)
  const selected = createHostedDatabaseBackups({
    ...input,
    contract,
    keyFingerprint: sha256Hex(input.secretKey),
    workflows: createPortableBackupApplicationAssets({ db: input.db }),
    openSource: () =>
      openPostgresqlLogicalSource({
        runtime: input.runtime,
        generationId: input.runtime.generationId,
        contract,
      }),
    assertBornHosted: async () => {
      await provenance()
    },
    protectedBackupIds: provenance,
  })
  return {
    maintenance: selected.maintenance,
    backup: {
      ...selected.backup,
      catalog: createHostedBackupCatalog({
        db: input.db,
        objects: input.objects,
        protectedBackupIds: provenance,
      }),
    },
  }
}
