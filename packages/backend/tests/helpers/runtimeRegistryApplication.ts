// RFC-360: legacy test vocabulary bound to the sole Runtime Management application.
// This helper is not a production entrypoint and contains no business implementation.
import { createRuntimeRegistryApplication } from '@/modules/runtime-management/application/runtimeRegistry'
import { createRuntimeRegistryEffects } from '@/modules/runtime-management/infrastructure/runtimeRegistryEffects'
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
export * from '@/modules/runtime-management/domain/runtimeProfile'
export type * from '@/modules/runtime-management/public/types'
export type { RuntimeRegistryOperations } from '@/modules/runtime-management/application/ports/runtimeRegistry'
export { withRuntimeProbeConfigFence } from '@/modules/runtime-management/infrastructure/runtimeProbeFence'
