import { DATABASE_PROVIDERS, type DatabaseProvider } from '@/platform/persistence/schemaContract'
import {
  createHostExecutionAuthorityLifecycle,
  type CreateHostExecutionAuthorityLifecycleInput,
} from '../application/hostExecutionAuthority'
import type {
  HostExecutionAdmission,
  HostExecutionAuthorityDriver,
  HostExecutionAuthorityFactory,
  HostExecutionAuthorityLifecycle,
  HostExecutionAvailabilityQueries,
  HostExecutionRecoveryFamily,
  HostExecutionResult,
  HostExecutionRuntimeFamily,
} from '../application/ports/hostExecutionAuthority'
import type { DaemonStartupLease } from '../application/ports/daemonStartupLease'
import { createLocalHostExecutionAuthorityFactory } from '../infrastructure/local/hostExecutionAuthority'

interface HostExecutionOwnerFamilies {
  readonly recovery: HostExecutionRecoveryFamily
  readonly runtime: HostExecutionRuntimeFamily
}

/** Each selection supplies the recovery and runtime belonging to this host. */
export type HostExecutionAuthoritySelection = HostExecutionOwnerFamilies &
  (
    | { readonly kind: 'local'; readonly startupLease?: DaemonStartupLease }
    | { readonly kind: 'selected'; readonly factory: HostExecutionAuthorityFactory }
  )

export interface HostExecutionAuthorityBinding {
  readonly provider: DatabaseProvider
  readonly generation: string
  readonly selectionKind: HostExecutionAuthoritySelection['kind']
  readonly lifecycle: HostExecutionAuthorityLifecycle
  readonly admission: HostExecutionAdmission
  readonly queries: HostExecutionAvailabilityQueries
}

export interface ComposeHostExecutionAuthorityBindingInput {
  readonly provider: HostExecutionAuthorityBinding['provider']
  readonly generation: string
  readonly mode: CreateHostExecutionAuthorityLifecycleInput['mode']
  readonly selection: HostExecutionAuthoritySelection
  readonly onFailure: (error: unknown) => void
}

const bindings = new WeakSet<HostExecutionAuthorityBinding>()

function assertOwnerFamilies(selection: HostExecutionAuthoritySelection): void {
  if (selection === undefined || selection === null) {
    throw new Error('host-execution-selection-missing')
  }
  if (selection.kind !== 'local' && selection.kind !== 'selected') {
    throw new Error('host-execution-selection-kind-missing')
  }
  if (
    selection.recovery === undefined ||
    selection.recovery === null ||
    !['local-startup', 'durable-intent'].includes(selection.recovery.kind)
  ) {
    throw new Error('host-execution-recovery-kind-missing')
  }
  for (const method of ['prepare', 'quiesce', 'drain'] as const) {
    if (typeof selection.recovery[method] !== 'function') {
      throw new Error(`host-execution-recovery-missing-${method}`)
    }
  }
  for (const method of ['start', 'quiesce', 'drain'] as const) {
    if (
      selection.runtime === undefined ||
      selection.runtime === null ||
      typeof selection.runtime[method] !== 'function'
    ) {
      throw new Error(`host-execution-runtime-missing-${method}`)
    }
  }
  if (selection.kind === 'selected' && typeof selection.factory?.create !== 'function') {
    throw new Error('host-execution-authority-factory-missing-create')
  }
}

/** Composition creates no claims or recovery work and keeps the native result sync. */
export function composeHostExecutionAuthorityBinding(
  input: ComposeHostExecutionAuthorityBindingInput,
): HostExecutionResult<HostExecutionAuthorityBinding> {
  if (!DATABASE_PROVIDERS.includes(input.provider)) {
    throw new Error('host-execution-provider-missing')
  }
  if (typeof input.generation !== 'string' || input.generation.length === 0) {
    throw new Error('host-execution-generation-missing')
  }
  if (input.mode !== 'execution' && input.mode !== 'resource-only') {
    throw new Error('host-execution-mode-missing')
  }
  if (typeof input.onFailure !== 'function') {
    throw new Error('host-execution-failure-receiver-missing')
  }
  assertOwnerFamilies(input.selection)
  const selection = input.selection
  const factory =
    selection.kind === 'selected'
      ? selection.factory
      : createLocalHostExecutionAuthorityFactory({ startupLease: selection.startupLease })
  const bind = (driver: HostExecutionAuthorityDriver): HostExecutionAuthorityBinding => {
    if (driver === undefined || driver === null || typeof driver !== 'object') {
      throw new Error('host-execution-authority-driver-missing')
    }
    const lifecycle = createHostExecutionAuthorityLifecycle({
      generation: input.generation,
      mode: input.mode,
      driver,
      recovery: selection.recovery,
      runtime: selection.runtime,
      onFailure: input.onFailure,
    })
    const binding = Object.freeze({
      provider: input.provider,
      generation: input.generation,
      selectionKind: selection.kind,
      lifecycle,
      admission: lifecycle.admission,
      queries: lifecycle.queries,
    })
    bindings.add(binding)
    return binding
  }
  const driver = factory.create({ provider: input.provider, generation: input.generation })
  if (
    driver !== undefined &&
    driver !== null &&
    typeof driver === 'object' &&
    'then' in driver &&
    typeof driver.then === 'function'
  ) {
    return Promise.resolve(driver).then(bind)
  }
  return bind(driver as HostExecutionAuthorityDriver)
}

/** Subroots retain the complete binding passed by their provider bootstrap. */
export function requireHostExecutionAuthorityBinding(
  binding: HostExecutionAuthorityBinding,
  scope: {
    readonly provider: HostExecutionAuthorityBinding['provider']
    readonly generation: string
  },
): HostExecutionAuthorityBinding {
  if (!bindings.has(binding)) throw new Error('host-execution-binding-incomplete')
  if (binding.provider !== scope.provider || binding.generation !== scope.generation) {
    throw new Error('host-execution-binding-generation-mismatch')
  }
  return binding
}
