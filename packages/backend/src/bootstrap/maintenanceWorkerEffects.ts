// RFC-399 B2: business effect families are selected at the Worker composition root.
import type { ContentStore as ImportedContentStore } from '@/platform/content/contentStore'
import type { TaskArchiveContentBinding } from '@/modules/task-execution/public/types'
import type { IntentArtifactContentPort, IntentScratchStore } from '@/modules/intent/public/types'
import type { WorkspaceMaintenanceEffects } from '@/modules/source-control/public/types'
import type { PostgresqlDatabaseClientOptions } from '@/platform/persistence/postgresqlDatabaseClient'
import type { EventsArchiveContent } from '@/platform/background/eventsArchiveContent'
import type {
  DatabaseBackupMaintenance,
  HostedObjectPublicationMaintenance,
} from '@/modules/system-operations/public/commands'
import type {
  PluginGenerationFilesystemGcPort,
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageRecoveryEffectsFactory,
} from '@/modules/resource-catalog/public/types'

import {
  openMaintenanceWorkerEffectsScope as openPlatformEffectsScope,
  assertMaintenanceWorkerEffectMethods,
  maintenanceWorkerEffectRecord,
  type MaintenanceWorkerEffectsEnvironment as PlatformEffectsEnvironment,
  type MaintenanceWorkerEffectsFactory as PlatformEffectsFactory,
  type MaintenanceWorkerEffectsScope,
} from '@/platform/background/maintenanceWorkerEffects'

export interface MaintenanceWorkerEffectsSelections {
  readonly contentStore?: ImportedContentStore
  /** RFC-370 v3 V6: the single hosted object recovery/GC job body. */
  readonly objectPublications?: HostedObjectPublicationMaintenance
  readonly databaseBackups?: DatabaseBackupMaintenance
  readonly eventsArchive?: EventsArchiveContent
  readonly databaseWrites?: {
    readonly assertHeld: NonNullable<PostgresqlDatabaseClientOptions['beforeWrite']>
  }
  readonly taskArchive?: TaskArchiveContentBinding
  readonly resourcePackageRecovery?: ResourcePackageApplyArtifactRecoveryPort
  readonly resourcePackageRecoveryContent?: ResourcePackageRecoveryEffectsFactory
  readonly pluginGenerationGc?: PluginGenerationFilesystemGcPort
  readonly intentArtifactContent?: IntentArtifactContentPort
  readonly intentScratch?: IntentScratchStore
  readonly workspaceMaintenance?: WorkspaceMaintenanceEffects
}

export type MaintenanceWorkerEffectsCapability = keyof MaintenanceWorkerEffectsSelections

export type MaintenanceWorkerEffectsEnvironment =
  PlatformEffectsEnvironment<MaintenanceWorkerEffectsSelections>
export type MaintenanceWorkerEffectsFactory =
  PlatformEffectsFactory<MaintenanceWorkerEffectsSelections>

function selectEffects(
  environment: MaintenanceWorkerEffectsEnvironment,
  capabilities: readonly string[],
): MaintenanceWorkerEffectsSelections {
  assertMaintenanceWorkerEffectMethods(environment, ['dispose'], 'environment')
  if (
    capabilities.length === 0 ||
    new Set(capabilities).size !== capabilities.length ||
    (capabilities.includes('resourcePackageRecovery') &&
      capabilities.includes('resourcePackageRecoveryContent'))
  )
    throw new Error('maintenance-worker-effects-invalid-selection')
  const selection: {
    contentStore?: MaintenanceWorkerEffectsSelections['contentStore']
    objectPublications?: HostedObjectPublicationMaintenance
    databaseBackups?: DatabaseBackupMaintenance
    eventsArchive?: EventsArchiveContent
    databaseWrites?: MaintenanceWorkerEffectsSelections['databaseWrites']
    taskArchive?: TaskArchiveContentBinding
    resourcePackageRecovery?: ResourcePackageApplyArtifactRecoveryPort
    resourcePackageRecoveryContent?: ResourcePackageRecoveryEffectsFactory
    pluginGenerationGc?: PluginGenerationFilesystemGcPort
    intentArtifactContent?: IntentArtifactContentPort
    intentScratch?: IntentScratchStore
    workspaceMaintenance?: WorkspaceMaintenanceEffects
  } = {}
  for (const family of capabilities) {
    switch (family) {
      case 'contentStore': {
        assertMaintenanceWorkerEffectMethods(
          environment.contentStore,
          ['put', 'read', 'release'],
          family,
        )
        selection.contentStore = environment.contentStore
        break
      }
      case 'objectPublications': {
        assertMaintenanceWorkerEffectMethods(environment.objectPublications, ['run'], family)
        selection.objectPublications = environment.objectPublications
        break
      }
      case 'databaseBackups': {
        assertMaintenanceWorkerEffectMethods(environment.databaseBackups, ['prune'], family)
        selection.databaseBackups = environment.databaseBackups
        break
      }
      case 'eventsArchive': {
        assertMaintenanceWorkerEffectMethods(
          environment.eventsArchive,
          ['recover', 'archive'],
          family,
        )
        selection.eventsArchive = environment.eventsArchive
        break
      }
      case 'databaseWrites': {
        assertMaintenanceWorkerEffectMethods(environment.databaseWrites, ['assertHeld'], family)
        selection.databaseWrites = environment.databaseWrites
        break
      }
      case 'workspaceMaintenance': {
        const workspace = environment.workspaceMaintenance
        assertMaintenanceWorkerEffectMethods(workspace, ['filesystem'], family)
        assertMaintenanceWorkerEffectMethods(
          workspace?.preparation,
          ['create'],
          `${family}-preparation`,
        )
        assertMaintenanceWorkerEffectMethods(
          workspace?.scratch,
          ['prepare', 'restore', 'cleanup'],
          `${family}-scratch`,
        )
        selection.workspaceMaintenance = workspace
        break
      }
      case 'intentScratch': {
        const scratch = environment.intentScratch
        assertMaintenanceWorkerEffectMethods(scratch, ['staleTurnIds', 'remove'], family)
        selection.intentScratch = scratch
        break
      }
      case 'intentArtifactContent': {
        const content = environment.intentArtifactContent
        assertMaintenanceWorkerEffectMethods(
          content,
          ['pluginExists', 'discardPlugin', 'publishSkill', 'discardSkill', 'discardLegacy'],
          family,
        )
        selection.intentArtifactContent = content
        break
      }
      case 'taskArchive': {
        const binding = environment.taskArchive
        assertMaintenanceWorkerEffectMethods(
          binding?.content,
          [
            'resolve',
            'exists',
            'list',
            'createDirectory',
            'remove',
            'move',
            'appendText',
            'writeText',
            'restoreMovedDirectories',
            'releaseTaskStorage',
          ],
          family,
        )
        const locations = binding?.locations
        if (
          locations === undefined ||
          ['archiveDir', 'runsDir', 'logsDir'].some(
            (name) => typeof maintenanceWorkerEffectRecord(locations)?.[name] !== 'string',
          )
        )
          throw new Error('maintenance-worker-effects-incomplete:taskArchive-locations')
        selection.taskArchive = binding
        break
      }
      case 'resourcePackageRecovery': {
        const recovery = environment.resourcePackageRecovery
        assertMaintenanceWorkerEffectMethods(recovery, ['rollForward', 'compensate'], family)
        selection.resourcePackageRecovery = recovery
        break
      }
      case 'resourcePackageRecoveryContent': {
        const recovery = environment.resourcePackageRecoveryContent
        assertMaintenanceWorkerEffectMethods(
          recovery,
          [
            'root',
            'live',
            'version',
            'staged',
            'candidate',
            'normalize',
            'parent',
            'storedReference',
            'assertManaged',
            'acquire',
          ],
          family,
        )
        selection.resourcePackageRecoveryContent = recovery
        break
      }
      case 'pluginGenerationGc': {
        const gc = environment.pluginGenerationGc
        assertMaintenanceWorkerEffectMethods(gc, ['hasCandidates', 'collect'], family)
        selection.pluginGenerationGc = gc
        break
      }
      default:
        throw new Error(`maintenance-worker-effects-unknown-selection:${String(family)}`)
    }
  }
  return Object.freeze(selection)
}

export function openMaintenanceWorkerEffectsScope(
  input: Omit<
    Parameters<typeof openPlatformEffectsScope<MaintenanceWorkerEffectsSelections>>[0],
    'selectEffects'
  >,
): MaintenanceWorkerEffectsScope<MaintenanceWorkerEffectsSelections> {
  return openPlatformEffectsScope({ ...input, selectEffects })
}
