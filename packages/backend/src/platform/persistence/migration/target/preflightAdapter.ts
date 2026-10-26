import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { PostgresqlCatalogArtifact } from '@/platform/persistence/schema/history/catalog'
import { preflightPostgresqlConversionTarget } from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import type { DatabaseProvider } from '../../databaseProviders'
import type { EpochTargetLocation, TargetPreflight } from '../run/types'

export function createExternalTargetPreflight(input: {
  readonly runtime: (profileRef: string) => PostgresqlDatabaseRuntime
  readonly catalogArtifacts: readonly PostgresqlCatalogArtifact[]
  readonly capacity?: (
    profileRef: string,
  ) => Promise<{ readonly availableBytes: number | null; readonly requiredBytes: number }>
}): {
  preflight(request: {
    provider: DatabaseProvider
    location: EpochTargetLocation
    sourceFingerprint: string | null
  }): Promise<TargetPreflight>
} {
  return {
    async preflight(request) {
      if (request.provider !== 'postgresql' || request.location.kind !== 'postgresql-target')
        throw new Error('postgresql-target-location-required')
      const profileRef = request.location.profileRef
      const runtime = input.runtime(profileRef)
      try {
        return await preflightPostgresqlConversionTarget({
          runtime,
          profileRef,
          sourceFingerprint: request.sourceFingerprint,
          supportedMajors: input.catalogArtifacts.map((artifact) => artifact.postgresqlMajor),
          ...(await input.capacity?.(profileRef)),
        })
      } finally {
        await runtime.close()
      }
    },
  }
}
