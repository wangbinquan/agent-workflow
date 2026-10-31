// RFC-399 B2: neutral Worker effect-module lifetime; selection is injected.
/** Cloneable assembly facts; functions and database connections remain Worker-owned. */
export interface MaintenanceWorkerEffectsDescriptor {
  readonly moduleSpecifier: string
  readonly exportName: string
  readonly configurationJson: string
  readonly capabilities: readonly string[]
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

export type MaintenanceWorkerEffectsEnvironment<Selection extends object> = Selection & {
  dispose(): void | Promise<void>
}

export type MaintenanceWorkerEffectsFactory<Selection extends object> = (
  context: MaintenanceWorkerEffectsContext,
) =>
  | MaintenanceWorkerEffectsEnvironment<Selection>
  | Promise<MaintenanceWorkerEffectsEnvironment<Selection>>

export interface MaintenanceWorkerEffectsScope<Selection extends object> {
  readonly ready: Promise<Selection>
  /** Waits for construction and releases even when selection validation failed. */
  dispose(): Promise<void>
}

export function maintenanceWorkerEffectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? (value as Record<string, unknown>)
    : null
}

export function assertMaintenanceWorkerEffectMethods(
  value: unknown,
  methods: readonly string[],
  family: string,
): void {
  const object = maintenanceWorkerEffectRecord(value)
  if (object === null || methods.some((method) => typeof object[method] !== 'function'))
    throw new Error(`maintenance-worker-effects-incomplete:${family}`)
}

/** Establish the lifetime before import/factory ACK so an early drain can await it. */
export function openMaintenanceWorkerEffectsScope<Selection extends object>(input: {
  readonly selectEffects: (
    environment: MaintenanceWorkerEffectsEnvironment<Selection>,
    capabilities: readonly string[],
  ) => Selection
  readonly descriptor: MaintenanceWorkerEffectsDescriptor
  readonly context: Omit<MaintenanceWorkerEffectsContext, 'configurationJson'>
  readonly importModule?: (specifier: string) => Promise<Record<string, unknown>>
}): MaintenanceWorkerEffectsScope<Selection> {
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
  let environment: MaintenanceWorkerEffectsEnvironment<Selection> | undefined
  let disposal: Promise<void> | undefined
  let closing = false
  const constructed = (async () => {
    const module = await importer(descriptor.moduleSpecifier)
    const factory = module[descriptor.exportName]
    if (typeof factory !== 'function') throw new Error('maintenance-worker-effects-factory-missing')
    environment = await (factory as MaintenanceWorkerEffectsFactory<Selection>)(context)
    return environment
  })()
  const ready = constructed.then((value) => {
    if (closing) throw new Error('maintenance-worker-effects-scope-disposing')
    return input.selectEffects(value, descriptor.capabilities)
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
          assertMaintenanceWorkerEffectMethods(environment, ['dispose'], 'environment')
          await environment.dispose()
        }
      })()
      return disposal
    },
  })
}
