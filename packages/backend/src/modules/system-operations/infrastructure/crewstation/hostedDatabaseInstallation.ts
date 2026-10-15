// RFC-370 M0 — the database installation of a CrewStation-hosted instance.
// The platform provisions PostgreSQL and the release migration Job installs or
// upgrades its schema; a serving process only verifies it. There is no local
// generation pointer, SQLite source or migration manifest: reads report that no
// local migration record exists (the generation's operation is the Job's
// installation copy, recorded in PostgreSQL), and the SQLite→PostgreSQL
// migration and recovery capabilities of the port do not exist here.
import type { DatabaseConfig } from '@agent-workflow/shared'
import type { PreparedPostgresqlProviderSchema } from '@/platform/persistence/databaseProviderRuntime'
import {
  hostedDatabaseGeneration,
  type ResolvedDatabaseGeneration,
} from '@/platform/persistence/generationValidation'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { DatabaseInstallationPort } from '../../application/ports/databaseInstallation'

export class HostedDatabaseInstallationError extends Error {
  constructor(readonly capability: string) {
    super(`a CrewStation-hosted database has no ${capability}`)
    this.name = 'HostedDatabaseInstallationError'
  }
}

export interface HostedDatabasePreparation {
  readonly config: DatabaseConfig
  readonly contract: LogicalSchemaContract
  readonly generation: ResolvedDatabaseGeneration
}

export function createHostedDatabaseInstallation(input: {
  readonly project: string
  readonly service: string
  readonly prepare: (
    request: HostedDatabasePreparation,
  ) => Promise<PreparedPostgresqlProviderSchema>
}): DatabaseInstallationPort<PreparedPostgresqlProviderSchema> {
  const unsupported = (capability: string): never => {
    throw new HostedDatabaseInstallationError(capability)
  }
  return Object.freeze({
    readGeneration: ({ contract }) => ({
      kind: 'current' as const,
      generation: hostedDatabaseGeneration({
        project: input.project,
        service: input.service,
        schemaDigest: contract.digest,
      }),
    }),
    resolveRecoverySource: () => unsupported('migration recovery source'),
    listMigrations: () => [],
    readMigration: () => null,
    writeGeneration: () => unsupported('generation pointer'),
    // The PostgreSQL schema advisory lock inside the migrator is the only
    // upgrade lock a hosted installation needs.
    requireUpgradeLock: () => {},
    releaseUpgradeLock: () => {},
    resumeMigration: () => unsupported('migration recovery'),
    async prepareProvider({ config, contract, candidate }) {
      if (candidate.kind !== 'current') return unsupported('generation upgrade')
      return await input.prepare({ config, contract, generation: candidate.generation })
    },
  } satisfies DatabaseInstallationPort<PreparedPostgresqlProviderSchema>)
}
