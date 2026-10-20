import type { TaskArchiveContentBinding } from '@/modules/task-execution/public/types'
import type { IntentArtifactContentPort, IntentScratchStore } from '@/modules/intent/public/types'
import type { WorkspaceMaintenanceEffects } from '@/modules/source-control/public/types'
import type { PostgresqlDatabaseClientOptions } from '@/platform/persistence/postgresqlDatabaseClient'
import type { EventsArchiveContent } from './eventsArchiveContent'
import type {
  DatabaseBackupMaintenance,
  HostedObjectPublicationMaintenance,
} from '@/modules/system-operations/public/commands'
import type {
  PluginGenerationFilesystemGcPort,
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageRecoveryEffectsFactory,
} from '@/modules/resource-catalog/public/types'

export interface MaintenanceWorkerEffectsSelections {
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

/** Cloneable assembly facts; functions and database connections remain Worker-owned. */
export interface MaintenanceWorkerEffectsDescriptor {
  readonly moduleSpecifier: string
  readonly exportName: string
  readonly configurationJson: string
  readonly capabilities: readonly MaintenanceWorkerEffectsCapability[]
  /** RFC-370 §9.2 V9 — the deployment's Worker entry that registers
   * `moduleSpecifier`; absent, the ordinary platform Worker entry runs. */
  readonly workerEntry?: string
}

const effectModules = new Map<string, () => Promise<Record<string, unknown>>>()

/** RFC-370 §9.2 V9 — a deployment's Worker entry registers its effect module
 * under a symbolic name before any init message arrives, so the platform
 * Worker never imports a deployment or business module itself. */
export function registerMaintenanceWorkerEffectModule(
  specifier: string,
  load: () => Promise<Record<string, unknown>>,
): void {
  effectModules.set(specifier, load)
}

export function importMaintenanceWorkerEffectModule(
  specifier: string,
): Promise<Record<string, unknown>> {
  const load = effectModules.get(specifier)
  return load === undefined ? import(specifier) : load()
}

export interface MaintenanceWorkerEffectsContext {
  readonly appHome: string
  /** Environment lifetime only; never a Task owner or execution authority. */
  readonly instanceRef: string
  readonly configurationJson: string
}

export interface MaintenanceWorkerEffectsEnvironment extends MaintenanceWorkerEffectsSelections {
  dispose(): void | Promise<void>
}

export type MaintenanceWorkerEffectsFactory = (
  context: MaintenanceWorkerEffectsContext,
) => MaintenanceWorkerEffectsEnvironment | Promise<MaintenanceWorkerEffectsEnvironment>

export interface MaintenanceWorkerEffectsScope {
  readonly ready: Promise<MaintenanceWorkerEffectsSelections>
  /** Waits for construction and releases even when selection validation failed. */
  dispose(): Promise<void>
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? (value as Record<string, unknown>)
    : null
}

function completeMethods(value: unknown, methods: readonly string[], family: string): void {
  const object = recordOf(value)
  if (object === null || methods.some((method) => typeof object[method] !== 'function'))
    throw new Error(`maintenance-worker-effects-incomplete:${family}`)
}

function selectEffects(
  environment: MaintenanceWorkerEffectsEnvironment,
  capabilities: readonly MaintenanceWorkerEffectsCapability[],
): MaintenanceWorkerEffectsSelections {
  completeMethods(environment, ['dispose'], 'environment')
  if (
    capabilities.length === 0 ||
    new Set(capabilities).size !== capabilities.length ||
    (capabilities.includes('resourcePackageRecovery') &&
      capabilities.includes('resourcePackageRecoveryContent'))
  )
    throw new Error('maintenance-worker-effects-invalid-selection')
  const selection: {
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
      case 'objectPublications': {
        completeMethods(environment.objectPublications, ['run'], family)
        selection.objectPublications = environment.objectPublications
        break
      }
      case 'databaseBackups': {
        completeMethods(environment.databaseBackups, ['prune'], family)
        selection.databaseBackups = environment.databaseBackups
        break
      }
      case 'eventsArchive': {
        completeMethods(environment.eventsArchive, ['recover', 'archive'], family)
        selection.eventsArchive = environment.eventsArchive
        break
      }
      case 'databaseWrites': {
        completeMethods(environment.databaseWrites, ['assertHeld'], family)
        selection.databaseWrites = environment.databaseWrites
        break
      }
      case 'workspaceMaintenance': {
        const workspace = environment.workspaceMaintenance
        completeMethods(workspace, ['filesystem'], family)
        completeMethods(workspace?.preparation, ['create'], `${family}-preparation`)
        completeMethods(workspace?.scratch, ['prepare', 'restore', 'cleanup'], `${family}-scratch`)
        selection.workspaceMaintenance = workspace
        break
      }
      case 'intentScratch': {
        const scratch = environment.intentScratch
        completeMethods(scratch, ['staleTurnIds', 'remove'], family)
        selection.intentScratch = scratch
        break
      }
      case 'intentArtifactContent': {
        const content = environment.intentArtifactContent
        completeMethods(
          content,
          ['pluginExists', 'discardPlugin', 'publishSkill', 'discardSkill', 'discardLegacy'],
          family,
        )
        selection.intentArtifactContent = content
        break
      }
      case 'taskArchive': {
        const binding = environment.taskArchive
        completeMethods(
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
            (name) => typeof recordOf(locations)?.[name] !== 'string',
          )
        )
          throw new Error('maintenance-worker-effects-incomplete:taskArchive-locations')
        selection.taskArchive = binding
        break
      }
      case 'resourcePackageRecovery': {
        const recovery = environment.resourcePackageRecovery
        completeMethods(recovery, ['rollForward', 'compensate'], family)
        selection.resourcePackageRecovery = recovery
        break
      }
      case 'resourcePackageRecoveryContent': {
        const recovery = environment.resourcePackageRecoveryContent
        completeMethods(
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
        completeMethods(gc, ['hasCandidates', 'collect'], family)
        selection.pluginGenerationGc = gc
        break
      }
      default:
        throw new Error(`maintenance-worker-effects-unknown-selection:${String(family)}`)
    }
  }
  return Object.freeze(selection)
}

/** Establish the lifetime before import/factory ACK so an early drain can await it. */
export function openMaintenanceWorkerEffectsScope(input: {
  readonly descriptor: MaintenanceWorkerEffectsDescriptor
  readonly context: Omit<MaintenanceWorkerEffectsContext, 'configurationJson'>
  readonly importModule?: (specifier: string) => Promise<Record<string, unknown>>
}): MaintenanceWorkerEffectsScope {
  const descriptor = Object.freeze({
    moduleSpecifier: input.descriptor.moduleSpecifier,
    exportName: input.descriptor.exportName,
    configurationJson: input.descriptor.configurationJson,
    capabilities: Object.freeze([...input.descriptor.capabilities]),
  })
  const context = Object.freeze({
    appHome: input.context.appHome,
    instanceRef: input.context.instanceRef,
    configurationJson: descriptor.configurationJson,
  })
  const importer = input.importModule ?? importMaintenanceWorkerEffectModule
  let environment: MaintenanceWorkerEffectsEnvironment | undefined
  let disposal: Promise<void> | undefined
  let closing = false
  const constructed = (async () => {
    const module = await importer(descriptor.moduleSpecifier)
    const factory = module[descriptor.exportName]
    if (typeof factory !== 'function') throw new Error('maintenance-worker-effects-factory-missing')
    environment = await (factory as MaintenanceWorkerEffectsFactory)(context)
    return environment
  })()
  const ready = constructed.then((value) => {
    if (closing) throw new Error('maintenance-worker-effects-scope-disposing')
    return selectEffects(value, descriptor.capabilities)
  })
  // The Worker immediately awaits readiness; disposal may also wait after a failure.
  void ready.catch(() => {})
  return Object.freeze({
    ready,
    dispose() {
      closing = true
      disposal ??= (async () => {
        await constructed.catch(() => undefined)
        if (environment !== undefined) {
          completeMethods(environment, ['dispose'], 'environment')
          await environment.dispose()
        }
      })()
      return disposal
    },
  })
}
