import type { TaskArchiveContentBinding } from '@/modules/task-execution/public/types'
import type {
  PluginGenerationFilesystemGcPort,
  ResourcePackageApplyArtifactRecoveryPort,
} from '@/modules/resource-catalog/public/types'

export interface MaintenanceWorkerEffectsSelections {
  readonly taskArchive?: TaskArchiveContentBinding
  readonly resourcePackageRecovery?: ResourcePackageApplyArtifactRecoveryPort
  readonly pluginGenerationGc?: PluginGenerationFilesystemGcPort
}

export type MaintenanceWorkerEffectsCapability = keyof MaintenanceWorkerEffectsSelections

/** Cloneable assembly facts; functions and database connections remain Worker-owned. */
export interface MaintenanceWorkerEffectsDescriptor {
  readonly moduleSpecifier: string
  readonly exportName: string
  readonly configurationJson: string
  readonly capabilities: readonly MaintenanceWorkerEffectsCapability[]
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
  if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length)
    throw new Error('maintenance-worker-effects-invalid-selection')
  const selection: {
    taskArchive?: TaskArchiveContentBinding
    resourcePackageRecovery?: ResourcePackageApplyArtifactRecoveryPort
    pluginGenerationGc?: PluginGenerationFilesystemGcPort
  } = {}
  for (const family of capabilities) {
    switch (family) {
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
  const importer = input.importModule ?? ((specifier: string) => import(specifier))
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
