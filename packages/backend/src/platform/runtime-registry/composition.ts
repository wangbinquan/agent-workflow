// RFC-360 temporary bootstrap forwarding surface, with no alternate registry implementation.
export {
  composeRuntimeRegistryOperations,
  initializeRuntimeRegistryBoot,
} from '@/modules/runtime-management/composition/runtimeRegistry'
export type { RuntimeRegistryOperations } from '@/modules/runtime-management/application/ports/runtimeRegistry'
