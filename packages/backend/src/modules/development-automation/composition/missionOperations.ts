// RFC-497 (RFC-294 S10 step 4): the Mission operations use case lives in application/missionOperationHandlers.ts.
// Composition only binds persistence, builds the upload-admission baseline resolution from the selected baseline effects
// and gives the default clock.
// RFC-344 — bootstrap composition for DevelopmentMission inbound operations.

import type { RepositoryBaselineEffectsFactory } from '../application/ports/repositoryBaselineEffects'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createDevelopmentMissionOperations,
  type DevelopmentMissionOperationsInput,
} from '../application/missionOperationHandlers'
import type { DevelopmentAutomationModule } from '../composition'
import {
  createRepositoryBaselineResolverFromLocations,
  createRepositoryLocationRead,
} from '../infrastructure/gitBaselineReader'
import { createDevelopmentMigrationPersistence } from '../infrastructure/migrationAssets'
import { createMissionReadModelQueries } from '../infrastructure/missionReadModels'
import { createFactSnapshotReader } from '../infrastructure/reconcilerReaders'
import { createCutoverStore } from '../infrastructure/cutoverStore'
import { createMissionInputUploadPersistence } from '../infrastructure/missionInputUploadPersistence'
import { createMissionPersistence } from '../infrastructure/missionStore'
import type { DevelopmentMissionOperations } from '../application/missionOperations'

export interface DevelopmentMissionOperationCompositionOptions extends Omit<
  DevelopmentMissionOperationsInput,
  'automation' | 'resolveBaseline' | 'now'
> {
  readonly repositoryBaselines: RepositoryBaselineEffectsFactory
  /** Bootstrap-owned daemon participant shared by REST, MCP and recovery. */
  readonly automation: DevelopmentAutomationModule
}

/** Selected-provider writer state projected to the one admission fact this owner needs. */
export function createLegacyMissionAdmissionsEnabledQuery(writer: {
  read(): Promise<{ readonly legacyAdmissionsEnabled: boolean }>
}): () => Promise<boolean> {
  return async () => (await writer.read()).legacyAdmissionsEnabled
}

export interface DevelopmentMissionOperationCompositionDeps extends DevelopmentMissionOperationCompositionOptions {
  readonly db: PersistenceDb
}

/** 一份装配，两个 provider 共用（RFC-359 W4-D12）。 */
export function composeDevelopmentMissionOperations(
  deps: DevelopmentMissionOperationCompositionDeps,
): DevelopmentMissionOperations {
  const persistence = {
    uploads: createMissionInputUploadPersistence(deps.db),
    snapshots: createFactSnapshotReader(deps.db),
    missions: createMissionPersistence(deps.db),
    repositories: createRepositoryLocationRead(deps.db),
    readModels: createMissionReadModelQueries(deps.db),
    cutover: createCutoverStore(deps.db),
    migration: createDevelopmentMigrationPersistence(deps.db),
  }
  return createDevelopmentMissionOperations(
    {
      mrEffects: deps.mrEffects,
      repositoryClaimKeys: deps.repositoryClaimKeys,
      admissionLookup: deps.admissionLookup,
      automation: deps.automation,
      legacyAdmissionsEnabled: deps.legacyAdmissionsEnabled,
      resolveBaseline: createRepositoryBaselineResolverFromLocations(
        persistence.repositories,
        deps.repositoryBaselines,
      ),
      now: Date.now,
    },
    persistence,
  )
}
