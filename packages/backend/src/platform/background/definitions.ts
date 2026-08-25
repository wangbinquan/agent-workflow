// RFC-294 W0-R — lifecycle contract for future managed daemon work.
// N1 defines the contract and inventories legacy work; W9 owns registration
// cutover.  Execution-local timers remain under their aggregate lifecycle and
// must not be disguised as daemon jobs.

export type BackgroundPhase = 'before-ready' | 'after-ready'
export type BackgroundReadiness = 'degraded' | 'ready' | 'starting' | 'stopped'

export interface BackgroundHealth {
  readonly status: 'degraded' | 'healthy' | 'stopped' | 'unhealthy'
  readonly checkedAt: string
  readonly reason?: string
}

export interface BackgroundLifecycleContext {
  readonly signal: AbortSignal
  readonly daemonGeneration: string
}

interface ManagedBackgroundDefinition {
  readonly id: string
  readonly owner: string
  readonly phase: BackgroundPhase
  readonly dependencies: readonly string[]
  readonly readiness: () => BackgroundReadiness
  readonly state: () => Readonly<Record<string, string | number | boolean | null>>
  readonly start: (context: BackgroundLifecycleContext) => Promise<void> | void
  readonly stop: (reason: string) => Promise<void> | void
  readonly health: () => Promise<BackgroundHealth> | BackgroundHealth
}

export interface BackgroundJobDefinition extends ManagedBackgroundDefinition {
  readonly kind: 'periodic'
  readonly cadenceMs: number
  readonly run: (context: BackgroundLifecycleContext) => Promise<void> | void
}

export interface ManagedWorkerDefinition extends ManagedBackgroundDefinition {
  readonly kind: 'long-running'
  readonly run: (context: BackgroundLifecycleContext) => Promise<void>
}

function freezeDefinition<T extends ManagedBackgroundDefinition>(definition: T): Readonly<T> {
  return Object.freeze({
    ...definition,
    dependencies: Object.freeze([...definition.dependencies]),
  })
}

export function defineBackgroundJob(
  definition: BackgroundJobDefinition,
): Readonly<BackgroundJobDefinition> {
  return freezeDefinition(definition)
}

export function defineManagedWorker(
  definition: ManagedWorkerDefinition,
): Readonly<ManagedWorkerDefinition> {
  return freezeDefinition(definition)
}
