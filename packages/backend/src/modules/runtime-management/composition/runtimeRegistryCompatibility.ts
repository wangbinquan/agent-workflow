// RFC-360: temporary legacy function bindings to the sole application; no registry algorithm lives here.
import { createRuntimeRegistryApplication } from '../application/runtimeRegistry'
import { createRuntimeRegistryEffects } from '../infrastructure/runtimeRegistryEffects'
export const {
  RUNTIME_PROTOCOLS,
  BUILTIN_RUNTIMES,
  RUNTIME_EXTRA_ARGS_MAX,
  RUNTIME_EXTRA_ARG_MAX_LENGTH,
  validateExtraArgs,
  listRuntimes,
  getRuntime,
  resolveRuntimeByName,
  resolveAgentRuntime,
  resolveInternalAgentRuntime,
  assertRuntimeSpawnCapabilities,
  createRuntime,
  updateRuntime,
  cacheRuntimeProbe,
  invalidateInheritedRuntimeProbeReceipts,
  setRuntimeEnabled,
  deleteRuntime,
  seedBuiltinRuntimes,
  migrateConfigIntoBuiltins,
  assertConfigDefaultsMigrated,
  composeRuntimeRegistryOperations,
} = createRuntimeRegistryApplication(createRuntimeRegistryEffects())
export * from '../domain/runtimeProfile'
export type * from '../public/types'
export type { RuntimeRegistryOperations } from '../application/ports/runtimeRegistry'
export { withRuntimeProbeConfigFence } from '../infrastructure/runtimeProbeFence'
